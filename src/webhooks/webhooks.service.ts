import {
  Injectable,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { StripeService } from '../stripe';
import { QueueService } from '../queue';
import { StructuredLoggerService } from '../common/logger';
import { StripeEvent } from '@prisma/client';
import Stripe from 'stripe';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly queueService: QueueService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Process incoming Stripe webhook
   * 1. Verify signature
   * 2. Check for duplicate (idempotency)
   * 3. Persist event to stripe_events table
   * 4. Enqueue event for async processing
   */
  async handleWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<StripeEvent> {
    // Step 1: Verify webhook signature
    let event: Stripe.Event;
    try {
      event = this.stripeService.verifyWebhookSignature(payload, signature);
    } catch (error) {
      this.logger.error('Webhook signature verification failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new BadRequestException('Invalid webhook signature');
    }

    this.logger.webhook({
      event: event.type,
      eventId: event.id,
      action: 'received',
    });

    // Step 2: Check for duplicate event (idempotency)
    const existingEvent = await this.prisma.stripeEvent.findUnique({
      where: { stripeEventId: event.id },
    });

    if (existingEvent) {
      this.logger.webhook({
        event: event.type,
        eventId: event.id,
        action: 'duplicate_ignored',
      });

      // Return existing event - this is idempotent behavior
      // If already processed, don't re-enqueue
      if (!existingEvent.processed) {
        // Event exists but wasn't processed - check if it's in queue
        const jobExists = await this.queueService.jobExists(event.id);
        if (!jobExists) {
          // Re-enqueue if not in queue
          await this.queueService.enqueueWebhookEvent({
            eventId: existingEvent.id,
            stripeEventId: event.id,
            eventType: event.type,
            payload: existingEvent.payload,
            retryCount: existingEvent.retryCount,
          });
        }
      }

      return existingEvent;
    }

    // Step 3: Persist event to database
    const stripeEvent = await this.prisma.stripeEvent.create({
      data: {
        stripeEventId: event.id,
        eventType: event.type,
        payload: JSON.stringify(event),
        processed: false,
        retryCount: 0,
      },
    });

    this.logger.database({
      action: 'stripe_event_persisted',
      eventId: event.id,
      eventType: event.type,
      entityId: stripeEvent.id,
    });

    // Step 4: Enqueue event for async processing
    try {
      await this.queueService.enqueueWebhookEvent({
        eventId: stripeEvent.id,
        stripeEventId: event.id,
        eventType: event.type,
        payload: stripeEvent.payload,
        retryCount: 0,
      });

      this.logger.webhook({
        event: event.type,
        eventId: event.id,
        action: 'enqueued',
      });
    } catch (error) {
      // If enqueueing fails, log but don't fail the webhook
      // The event is persisted and can be processed later
      this.logger.error('Failed to enqueue webhook event', {
        eventId: event.id,
        eventType: event.type,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return stripeEvent;
  }

  /**
   * Get all stored webhook events (for debugging/monitoring)
   */
  async getEvents(options?: {
    processed?: boolean;
    eventType?: string;
    limit?: number;
  }): Promise<StripeEvent[]> {
    return this.prisma.stripeEvent.findMany({
      where: {
        processed: options?.processed,
        eventType: options?.eventType,
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 100,
    });
  }

  /**
   * Get a specific event by Stripe event ID
   */
  async getEvent(stripeEventId: string): Promise<StripeEvent | null> {
    return this.prisma.stripeEvent.findUnique({
      where: { stripeEventId },
    });
  }

  /**
   * Manually reprocess a failed event
   */
  async reprocessEvent(stripeEventId: string): Promise<void> {
    const event = await this.prisma.stripeEvent.findUnique({
      where: { stripeEventId },
    });

    if (!event) {
      throw new BadRequestException(`Event ${stripeEventId} not found`);
    }

    if (event.processed) {
      throw new ConflictException(`Event ${stripeEventId} already processed`);
    }

    // Re-enqueue the event
    await this.queueService.enqueueWebhookEvent({
      eventId: event.id,
      stripeEventId: event.stripeEventId,
      eventType: event.eventType,
      payload: event.payload,
      retryCount: event.retryCount,
    });

    this.logger.webhook({
      event: event.eventType,
      eventId: stripeEventId,
      action: 'manually_reprocessed',
    });
  }
}
