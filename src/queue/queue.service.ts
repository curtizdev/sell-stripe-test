import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { StructuredLoggerService } from '../common/logger';
import { QUEUE_NAMES, WebhookJobData } from './queue.constants';

@Injectable()
export class QueueService {
  private webhookQueue: Queue<WebhookJobData>;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: StructuredLoggerService,
  ) {
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    this.webhookQueue = new Queue<WebhookJobData>(QUEUE_NAMES.STRIPE_WEBHOOKS, {
      connection: {
        host: redisHost,
        port: redisPort,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5 seconds initial delay
        },
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24 hours
          count: 1000,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });

    this.logger.queue({
      action: 'queue_initialized',
      queueName: QUEUE_NAMES.STRIPE_WEBHOOKS,
      redisHost,
      redisPort,
    });
  }

  /**
   * Get the webhook queue instance
   */
  getWebhookQueue(): Queue<WebhookJobData> {
    return this.webhookQueue;
  }

  /**
   * Add a webhook event to the processing queue
   */
  async enqueueWebhookEvent(data: WebhookJobData): Promise<string> {
    const job = await this.webhookQueue.add(data.eventType, data, {
      jobId: data.stripeEventId, // Use Stripe event ID as job ID for idempotency
    });

    this.logger.queue({
      action: 'job_enqueued',
      queueName: QUEUE_NAMES.STRIPE_WEBHOOKS,
      jobId: job.id,
      eventType: data.eventType,
      stripeEventId: data.stripeEventId,
    });

    return job.id!;
  }

  /**
   * Check if a job with given ID already exists (for idempotency)
   */
  async jobExists(stripeEventId: string): Promise<boolean> {
    const job = await this.webhookQueue.getJob(stripeEventId);
    return job !== undefined;
  }

  /**
   * Close queue connections gracefully
   */
  async close(): Promise<void> {
    await this.webhookQueue.close();
    this.logger.queue({
      action: 'queue_closed',
      queueName: QUEUE_NAMES.STRIPE_WEBHOOKS,
    });
  }
}
