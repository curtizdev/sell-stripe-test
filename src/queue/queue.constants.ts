/**
 * Queue names for the application
 */
export const QUEUE_NAMES = {
  STRIPE_WEBHOOKS: 'stripe-webhooks',
} as const;

/**
 * Job types for Stripe webhook processing
 */
export const WEBHOOK_JOB_TYPES = {
  INVOICE_PAYMENT_SUCCEEDED: 'invoice.payment_succeeded',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  CUSTOMER_SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  CUSTOMER_SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
} as const;

/**
 * Job data interface for webhook processing
 */
export interface WebhookJobData {
  eventId: string;
  stripeEventId: string;
  eventType: string;
  payload: string; // JSON stringified
  retryCount: number;
}
