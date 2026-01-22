import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma';
import { MerchantsService } from '../merchants';
import { OrdersService } from '../orders';
import { StructuredLoggerService } from '../common/logger';
import {
  QUEUE_NAMES,
  WEBHOOK_JOB_TYPES,
  WebhookJobData,
} from './queue.constants';
import Stripe from 'stripe';

/**
 * Extended invoice type to handle Stripe API response properties
 * Using type intersection to add optional properties
 */
type ExtendedInvoice = Stripe.Invoice & {
  subscription?: string | Stripe.Subscription | null;
  charge?: string | Stripe.Charge | null;
};

/**
 * Extended subscription type for period properties
 */
type ExtendedSubscription = Stripe.Subscription & {
  current_period_start?: number;
  current_period_end?: number;
};

@Injectable()
export class WebhookProcessorService implements OnModuleInit, OnModuleDestroy {
  private worker: Worker<WebhookJobData>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly merchantsService: MerchantsService,
    private readonly ordersService: OrdersService,
    private readonly logger: StructuredLoggerService,
  ) {}

  onModuleInit(): void {
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    this.worker = new Worker<WebhookJobData>(
      QUEUE_NAMES.STRIPE_WEBHOOKS,
      async (job: Job<WebhookJobData>) => {
        await this.processJob(job);
      },
      {
        connection: {
          host: redisHost,
          port: redisPort,
        },
        concurrency: 5,
      },
    );

    this.worker.on('completed', (job: Job<WebhookJobData>) => {
      this.logger.queue({
        action: 'job_completed',
        jobId: job.id,
        eventType: job.data.eventType,
        stripeEventId: job.data.stripeEventId,
      });
    });

    this.worker.on(
      'failed',
      (job: Job<WebhookJobData> | undefined, error: Error) => {
        this.logger.error('Job failed', {
          jobId: job?.id,
          eventType: job?.data.eventType,
          stripeEventId: job?.data.stripeEventId,
          error: error.message,
        });
      },
    );

    this.logger.queue({
      action: 'worker_started',
      queueName: QUEUE_NAMES.STRIPE_WEBHOOKS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.logger.queue({
        action: 'worker_stopped',
        queueName: QUEUE_NAMES.STRIPE_WEBHOOKS,
      });
    }
  }

  /**
   * Process a webhook job
   */
  private async processJob(job: Job<WebhookJobData>): Promise<void> {
    const { eventId, stripeEventId, eventType, payload } = job.data;

    this.logger.queue({
      action: 'processing_job',
      jobId: job.id,
      eventType,
      stripeEventId,
      attempt: job.attemptsMade + 1,
    });

    try {
      // Execute processing within a transaction for atomicity
      await this.prisma.$transaction(async (tx) => {
        // Check if already processed (idempotency)
        const existingEvent = await tx.stripeEvent.findUnique({
          where: { stripeEventId },
        });

        if (existingEvent?.processed) {
          this.logger.queue({
            action: 'job_skipped_already_processed',
            jobId: job.id,
            stripeEventId,
            eventType,
          });
          return;
        }

        // Parse the payload
        const event: Stripe.Event = JSON.parse(payload);

        // Process based on event type
        await this.processEventByType(event);

        // Mark event as processed
        await tx.stripeEvent.update({
          where: { id: eventId },
          data: {
            processed: true,
            processedAt: new Date(),
            retryCount: job.attemptsMade,
          },
        });
      });

      this.logger.webhook({
        event: eventType,
        eventId: stripeEventId,
        action: 'processed_successfully',
      });
    } catch (error) {
      // Update retry count and error
      await this.prisma.stripeEvent.update({
        where: { id: eventId },
        data: {
          retryCount: job.attemptsMade + 1,
          processingError:
            error instanceof Error ? error.message : 'Unknown error',
        },
      });

      this.logger.error('Job processing failed', {
        jobId: job.id,
        stripeEventId,
        eventType,
        error: error instanceof Error ? error.message : 'Unknown error',
        attempt: job.attemptsMade + 1,
      });

      throw error; // Re-throw to trigger BullMQ retry
    }
  }

  /**
   * Route event processing based on type
   */
  private async processEventByType(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case WEBHOOK_JOB_TYPES.INVOICE_PAYMENT_SUCCEEDED:
        await this.handleInvoicePaymentSucceeded(event);
        break;

      case WEBHOOK_JOB_TYPES.INVOICE_PAYMENT_FAILED:
        await this.handleInvoicePaymentFailed(event);
        break;

      case WEBHOOK_JOB_TYPES.CUSTOMER_SUBSCRIPTION_UPDATED:
        await this.handleSubscriptionUpdated(event);
        break;

      case WEBHOOK_JOB_TYPES.CUSTOMER_SUBSCRIPTION_DELETED:
        await this.handleSubscriptionDeleted(event);
        break;

      default:
        this.logger.warn('Unhandled event type', {
          eventType: event.type,
          eventId: event.id,
        });
    }
  }

  /**
   * Handle invoice.payment_succeeded event
   * - Updates subscription status to active
   * - Updates order status to paid
   */
  private async handleInvoicePaymentSucceeded(
    event: Stripe.Event,
  ): Promise<void> {
    const invoice = event.data.object as ExtendedInvoice;
    const customerId =
      typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;

    this.logger.webhook({
      event: 'invoice.payment_succeeded',
      eventId: event.id,
      invoiceId: invoice.id,
      stripeCustomerId: customerId,
      action: 'processing',
    });

    // Get merchant by Stripe customer ID
    const merchant = customerId
      ? await this.merchantsService.getMerchantByStripeCustomerId(customerId)
      : null;

    if (!merchant) {
      this.logger.warn('Merchant not found for invoice payment', {
        stripeCustomerId: customerId,
        invoiceId: invoice.id,
      });
      return;
    }

    // Update subscription status if this is a subscription invoice
    if (invoice.subscription) {
      const subscriptionId =
        typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription.id;

      await this.merchantsService.updateSubscriptionStatus(
        subscriptionId,
        'active',
        {
          currentPeriodStart: invoice.period_start
            ? new Date(invoice.period_start * 1000)
            : undefined,
          currentPeriodEnd: invoice.period_end
            ? new Date(invoice.period_end * 1000)
            : undefined,
        },
      );

      this.logger.webhook({
        event: 'invoice.payment_succeeded',
        eventId: event.id,
        invoiceId: invoice.id,
        merchantId: merchant.id,
        subscriptionId,
        action: 'subscription_activated',
      });
    }

    // Try to find and update related order
    const order = await this.ordersService.getOrderByInvoiceId(invoice.id);

    if (order) {
      // Order is already linked, update its status
      await this.ordersService.markOrderAsPaid(invoice.id, new Date());

      this.logger.webhook({
        event: 'invoice.payment_succeeded',
        eventId: event.id,
        invoiceId: invoice.id,
        merchantId: merchant.id,
        orderId: order.id,
        action: 'order_marked_paid',
      });
    } else {
      // Try to find and link a pending order by amount
      const amountPaid = invoice.amount_paid || 0;
      const linkedOrder = await this.ordersService.findAndLinkOrderToInvoice(
        merchant.id,
        invoice.id,
        amountPaid,
      );

      if (linkedOrder) {
        await this.ordersService.markOrderAsPaid(invoice.id, new Date());

        this.logger.webhook({
          event: 'invoice.payment_succeeded',
          eventId: event.id,
          invoiceId: invoice.id,
          merchantId: merchant.id,
          orderId: linkedOrder.id,
          action: 'order_linked_and_marked_paid',
        });
      }
    }
  }

  /**
   * Handle invoice.payment_failed event
   * - Updates subscription status to past_due
   * - Updates order status to payment_failed
   */
  private async handleInvoicePaymentFailed(event: Stripe.Event): Promise<void> {
    const invoice = event.data.object as ExtendedInvoice;
    const customerId =
      typeof invoice.customer === 'string'
        ? invoice.customer
        : invoice.customer?.id;

    this.logger.webhook({
      event: 'invoice.payment_failed',
      eventId: event.id,
      invoiceId: invoice.id,
      stripeCustomerId: customerId,
      action: 'processing',
    });

    // Get failure reason
    const failureReason = this.extractFailureReason(invoice);

    // Get merchant by Stripe customer ID
    const merchant = customerId
      ? await this.merchantsService.getMerchantByStripeCustomerId(customerId)
      : null;

    if (!merchant) {
      this.logger.warn('Merchant not found for invoice payment failure', {
        stripeCustomerId: customerId,
        invoiceId: invoice.id,
      });
      return;
    }

    // Update subscription status if this is a subscription invoice
    if (invoice.subscription) {
      const subscriptionId =
        typeof invoice.subscription === 'string'
          ? invoice.subscription
          : invoice.subscription.id;

      // Stripe's dunning model will set status to past_due, unpaid, or canceled
      // We reflect this based on the subscription status
      await this.merchantsService.updateSubscriptionStatus(
        subscriptionId,
        'past_due',
      );

      this.logger.webhook({
        event: 'invoice.payment_failed',
        eventId: event.id,
        invoiceId: invoice.id,
        merchantId: merchant.id,
        subscriptionId,
        action: 'subscription_past_due',
        failureReason,
      });
    }

    // Try to find and update related order
    const order = await this.ordersService.getOrderByInvoiceId(invoice.id);

    if (order) {
      await this.ordersService.markOrderAsPaymentFailed(
        invoice.id,
        failureReason,
      );

      this.logger.webhook({
        event: 'invoice.payment_failed',
        eventId: event.id,
        invoiceId: invoice.id,
        merchantId: merchant.id,
        orderId: order.id,
        action: 'order_marked_payment_failed',
        failureReason,
      });
    }
  }

  /**
   * Handle customer.subscription.updated event
   * Syncs subscription status from Stripe to local DB
   */
  private async handleSubscriptionUpdated(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as ExtendedSubscription;

    this.logger.webhook({
      event: 'customer.subscription.updated',
      eventId: event.id,
      subscriptionId: subscription.id,
      status: subscription.status,
      action: 'processing',
    });

    await this.merchantsService.updateSubscriptionStatus(
      subscription.id,
      subscription.status,
      {
        currentPeriodStart: subscription.current_period_start
          ? new Date(subscription.current_period_start * 1000)
          : undefined,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : undefined,
        canceledAt: subscription.canceled_at
          ? new Date(subscription.canceled_at * 1000)
          : undefined,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    );

    this.logger.webhook({
      event: 'customer.subscription.updated',
      eventId: event.id,
      subscriptionId: subscription.id,
      action: 'subscription_status_synced',
      newStatus: subscription.status,
    });
  }

  /**
   * Handle customer.subscription.deleted event
   */
  private async handleSubscriptionDeleted(event: Stripe.Event): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;

    this.logger.webhook({
      event: 'customer.subscription.deleted',
      eventId: event.id,
      subscriptionId: subscription.id,
      action: 'processing',
    });

    await this.merchantsService.updateSubscriptionStatus(
      subscription.id,
      'canceled',
      {
        canceledAt: new Date(),
      },
    );

    this.logger.webhook({
      event: 'customer.subscription.deleted',
      eventId: event.id,
      subscriptionId: subscription.id,
      action: 'subscription_canceled',
    });
  }

  /**
   * Extract failure reason from invoice
   */
  private extractFailureReason(invoice: ExtendedInvoice): string {
    // Check last payment error on the payment intent
    if (invoice.last_finalization_error) {
      return invoice.last_finalization_error.message || 'Payment failed';
    }

    // Check the charge if available
    const charge = invoice.charge;
    if (charge && typeof charge === 'object' && charge.failure_message) {
      return charge.failure_message;
    }

    return 'Payment failed';
  }
}
