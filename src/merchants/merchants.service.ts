import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '../prisma';
import { StripeService } from '../stripe';
import { StructuredLoggerService } from '../common/logger';
import { CreateMerchantDto, CreateSubscriptionDto } from './dto';
import { Merchant, Subscription } from '@prisma/client';

export interface SubscriptionResult {
  subscription: Subscription;
  clientSecret?: string;
  requiresAction: boolean;
}

@Injectable()
export class MerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Create a new merchant
   */
  async createMerchant(dto: CreateMerchantDto): Promise<Merchant> {
    this.logger.api({
      action: 'create_merchant',
      email: dto.email,
    });

    // Check if merchant with email already exists
    const existing = await this.prisma.merchant.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Merchant with this email already exists');
    }

    const merchant = await this.prisma.merchant.create({
      data: {
        name: dto.name,
        email: dto.email,
      },
    });

    this.logger.database({
      action: 'merchant_created',
      merchantId: merchant.id,
      email: merchant.email,
    });

    return merchant;
  }

  /**
   * Get a merchant by ID
   */
  async getMerchant(id: string): Promise<Merchant> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id },
    });

    if (!merchant) {
      throw new NotFoundException(`Merchant with ID ${id} not found`);
    }

    return merchant;
  }

  /**
   * Get a merchant by Stripe customer ID
   */
  async getMerchantByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Merchant | null> {
    return this.prisma.merchant.findUnique({
      where: { stripeCustomerId },
    });
  }

  /**
   * Create a subscription for a merchant
   * 1. Create Stripe Customer if not exists
   * 2. Create SetupIntent for payment method attachment (mandate for off-session)
   * 3. Create Subscription
   * 4. Return clientSecret if 3DS is required
   */
  async createSubscription(
    merchantId: string,
    dto: CreateSubscriptionDto,
  ): Promise<SubscriptionResult> {
    const merchant = await this.getMerchant(merchantId);

    this.logger.api({
      action: 'create_subscription',
      merchantId: merchant.id,
      planId: dto.planId,
    });

    // Step 1: Create or get Stripe Customer
    let stripeCustomerId = merchant.stripeCustomerId;

    if (!stripeCustomerId) {
      const customer = await this.stripeService.createCustomer({
        email: merchant.email,
        name: merchant.name,
        merchantId: merchant.id,
      });
      stripeCustomerId = customer.id;

      // Update merchant with Stripe customer ID
      await this.prisma.merchant.update({
        where: { id: merchant.id },
        data: { stripeCustomerId },
      });

      this.logger.database({
        action: 'merchant_stripe_customer_linked',
        merchantId: merchant.id,
        stripeCustomerId,
      });
    }

    // Step 2: If payment method provided, attach it
    if (dto.paymentMethodId) {
      await this.stripeService.attachPaymentMethod(
        stripeCustomerId,
        dto.paymentMethodId,
      );

      await this.prisma.merchant.update({
        where: { id: merchant.id },
        data: { defaultPaymentMethodId: dto.paymentMethodId },
      });
    }

    // Step 3: Create the subscription
    const stripeSubscription = (await this.stripeService.createSubscription({
      customerId: stripeCustomerId,
      priceId: dto.planId,
      paymentMethodId: dto.paymentMethodId,
    })) as Stripe.Subscription & {
      current_period_start?: number;
      current_period_end?: number;
      latest_invoice?: Stripe.Invoice & {
        payment_intent?: Stripe.PaymentIntent;
      };
    };

    // Step 4: Store subscription in database
    const subscription = await this.prisma.subscription.create({
      data: {
        merchantId: merchant.id,
        stripeSubscriptionId: stripeSubscription.id,
        stripePriceId: dto.planId,
        status: stripeSubscription.status,
        currentPeriodStart: stripeSubscription.current_period_start
          ? new Date(stripeSubscription.current_period_start * 1000)
          : null,
        currentPeriodEnd: stripeSubscription.current_period_end
          ? new Date(stripeSubscription.current_period_end * 1000)
          : null,
      },
    });

    this.logger.database({
      action: 'subscription_created',
      merchantId: merchant.id,
      subscriptionId: subscription.id,
      stripeSubscriptionId: stripeSubscription.id,
      status: stripeSubscription.status,
    });

    // Step 5: Check if 3DS is required
    let clientSecret: string | undefined;
    let requiresAction = false;

    // Check for pending_setup_intent (for setup requiring 3DS)
    if (stripeSubscription.pending_setup_intent) {
      const setupIntent = stripeSubscription.pending_setup_intent;
      if (typeof setupIntent === 'object' && setupIntent.client_secret) {
        clientSecret = setupIntent.client_secret;
        requiresAction = setupIntent.status === 'requires_action';
      }
    }

    // Check for latest_invoice with payment_intent requiring action
    if (
      stripeSubscription.latest_invoice &&
      typeof stripeSubscription.latest_invoice === 'object'
    ) {
      const invoice = stripeSubscription.latest_invoice;
      if (
        invoice.payment_intent &&
        typeof invoice.payment_intent === 'object'
      ) {
        const paymentIntent = invoice.payment_intent;
        if (paymentIntent.status === 'requires_action') {
          clientSecret = paymentIntent.client_secret ?? undefined;
          requiresAction = true;
        } else if (paymentIntent.status === 'requires_payment_method') {
          clientSecret = paymentIntent.client_secret ?? undefined;
          requiresAction = true;
        }
      }
    }

    if (requiresAction) {
      this.logger.api({
        action: 'subscription_requires_action',
        merchantId: merchant.id,
        subscriptionId: subscription.id,
        reason: '3DS_required',
      });
    }

    return {
      subscription,
      clientSecret,
      requiresAction,
    };
  }

  /**
   * Get all subscriptions for a merchant
   */
  async getMerchantSubscriptions(merchantId: string): Promise<Subscription[]> {
    await this.getMerchant(merchantId); // Verify merchant exists

    return this.prisma.subscription.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Update subscription status (called by webhook processor)
   */
  async updateSubscriptionStatus(
    stripeSubscriptionId: string,
    status: string,
    additionalData?: {
      currentPeriodStart?: Date;
      currentPeriodEnd?: Date;
      canceledAt?: Date;
      cancelAtPeriodEnd?: boolean;
    },
  ): Promise<Subscription | null> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
    });

    if (!subscription) {
      this.logger.warn('Subscription not found for update', {
        stripeSubscriptionId,
        action: 'update_subscription_status',
      });
      return null;
    }

    const updated = await this.prisma.subscription.update({
      where: { stripeSubscriptionId },
      data: {
        status,
        ...additionalData,
      },
    });

    this.logger.database({
      action: 'subscription_status_updated',
      subscriptionId: subscription.id,
      merchantId: subscription.merchantId,
      stripeSubscriptionId,
      oldStatus: subscription.status,
      newStatus: status,
    });

    return updated;
  }

  /**
   * Get subscription by Stripe subscription ID
   */
  async getSubscriptionByStripeId(
    stripeSubscriptionId: string,
  ): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
    });
  }

  /**
   * Create a SetupIntent for collecting payment method
   */
  async createSetupIntent(
    merchantId: string,
  ): Promise<{ clientSecret: string }> {
    const merchant = await this.getMerchant(merchantId);

    if (!merchant.stripeCustomerId) {
      // Create customer first
      const customer = await this.stripeService.createCustomer({
        email: merchant.email,
        name: merchant.name,
        merchantId: merchant.id,
      });

      await this.prisma.merchant.update({
        where: { id: merchant.id },
        data: { stripeCustomerId: customer.id },
      });

      merchant.stripeCustomerId = customer.id;
    }

    const setupIntent = await this.stripeService.createSetupIntent({
      customerId: merchant.stripeCustomerId,
    });

    return {
      clientSecret: setupIntent.client_secret!,
    };
  }
}
