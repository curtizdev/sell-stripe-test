import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { StructuredLoggerService } from '../common/logger';

export interface CreateCustomerDto {
  email: string;
  name: string;
  merchantId: string;
}

export interface CreateSubscriptionDto {
  customerId: string;
  priceId: string;
  paymentMethodId?: string;
}

export interface CreateSetupIntentDto {
  customerId: string;
}

@Injectable()
export class StripeService implements OnModuleInit {
  private stripe: Stripe;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    this.stripe = new Stripe(secretKey);
  }

  /**
   * Get the Stripe instance for direct operations
   */
  getStripeInstance(): Stripe {
    return this.stripe;
  }

  /**
   * Create a Stripe customer
   */
  async createCustomer(data: CreateCustomerDto): Promise<Stripe.Customer> {
    this.logger.stripe({
      action: 'create_customer',
      merchantId: data.merchantId,
      email: data.email,
    });

    const customer = await this.stripe.customers.create({
      email: data.email,
      name: data.name,
      metadata: {
        merchantId: data.merchantId,
      },
    });

    this.logger.stripe({
      action: 'customer_created',
      merchantId: data.merchantId,
      stripeCustomerId: customer.id,
    });

    return customer;
  }

  /**
   * Retrieve a Stripe customer
   */
  async getCustomer(customerId: string): Promise<Stripe.Customer | null> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      if (customer.deleted) {
        return null;
      }
      return customer as Stripe.Customer;
    } catch {
      return null;
    }
  }

  /**
   * Create a SetupIntent for off-session payment method attachment
   * This creates a mandate allowing future off-session charges
   */
  async createSetupIntent(
    data: CreateSetupIntentDto,
  ): Promise<Stripe.SetupIntent> {
    this.logger.stripe({
      action: 'create_setup_intent',
      stripeCustomerId: data.customerId,
    });

    const setupIntent = await this.stripe.setupIntents.create({
      customer: data.customerId,
      payment_method_types: ['card'],
      usage: 'off_session', // Important: allows off-session payments for renewals
    });

    this.logger.stripe({
      action: 'setup_intent_created',
      stripeCustomerId: data.customerId,
      setupIntentId: setupIntent.id,
    });

    return setupIntent;
  }

  /**
   * Confirm a SetupIntent and attach payment method
   */
  async confirmSetupIntent(
    setupIntentId: string,
    paymentMethodId: string,
  ): Promise<Stripe.SetupIntent> {
    this.logger.stripe({
      action: 'confirm_setup_intent',
      setupIntentId,
      paymentMethodId,
    });

    const setupIntent = await this.stripe.setupIntents.confirm(setupIntentId, {
      payment_method: paymentMethodId,
    });

    return setupIntent;
  }

  /**
   * Attach a payment method to a customer and set as default
   */
  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<void> {
    this.logger.stripe({
      action: 'attach_payment_method',
      stripeCustomerId: customerId,
      paymentMethodId,
    });

    // Attach the payment method to the customer
    await this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });

    // Set as default payment method for invoices
    await this.stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    this.logger.stripe({
      action: 'payment_method_attached',
      stripeCustomerId: customerId,
      paymentMethodId,
    });
  }

  /**
   * Create a subscription with the customer's default payment method
   */
  async createSubscription(
    data: CreateSubscriptionDto,
  ): Promise<Stripe.Subscription> {
    this.logger.stripe({
      action: 'create_subscription',
      stripeCustomerId: data.customerId,
      priceId: data.priceId,
    });

    const subscriptionParams: Stripe.SubscriptionCreateParams = {
      customer: data.customerId,
      items: [{ price: data.priceId }],
      payment_behavior: 'default_incomplete', // Allows handling 3DS
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription',
      },
      expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
    };

    if (data.paymentMethodId) {
      subscriptionParams.default_payment_method = data.paymentMethodId;
    }

    const subscription =
      await this.stripe.subscriptions.create(subscriptionParams);

    this.logger.stripe({
      action: 'subscription_created',
      stripeCustomerId: data.customerId,
      subscriptionId: subscription.id,
      status: subscription.status,
    });

    return subscription;
  }

  /**
   * Get a subscription by ID
   */
  async getSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription | null> {
    try {
      return await this.stripe.subscriptions.retrieve(subscriptionId);
    } catch {
      return null;
    }
  }

  /**
   * Cancel a subscription
   */
  async cancelSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription> {
    this.logger.stripe({
      action: 'cancel_subscription',
      subscriptionId,
    });

    return this.stripe.subscriptions.cancel(subscriptionId);
  }

  /**
   * Retrieve an invoice
   */
  async getInvoice(invoiceId: string): Promise<Stripe.Invoice | null> {
    try {
      return await this.stripe.invoices.retrieve(invoiceId);
    } catch {
      return null;
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: Buffer, signature: string): Stripe.Event {
    const webhookSecret = this.configService.get<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }

    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  }

  /**
   * Get customer's payment methods
   */
  async getPaymentMethods(customerId: string): Promise<Stripe.PaymentMethod[]> {
    const paymentMethods = await this.stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
    });
    return paymentMethods.data;
  }

  /**
   * Create an invoice for a customer
   */
  async createInvoice(
    customerId: string,
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<Stripe.Invoice> {
    // Create an invoice item
    await this.stripe.invoiceItems.create({
      customer: customerId,
      amount,
      currency,
      description: 'Order payment',
      metadata,
    });

    // Create and finalize the invoice
    const invoice = await this.stripe.invoices.create({
      customer: customerId,
      auto_advance: true, // Auto-finalize
      metadata,
    });

    return invoice;
  }
}
