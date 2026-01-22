import { Injectable, Logger } from '@nestjs/common';

export interface LogContext {
  event?: string;
  eventId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  merchantId?: string;
  orderId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  stripeCustomerId?: string;
  error?: string;
  [key: string]: string | number | boolean | undefined;
}

@Injectable()
export class StructuredLoggerService {
  private readonly logger = new Logger('StructuredLogger');

  /**
   * Format context into structured log string
   */
  private formatContext(context: LogContext): string {
    return Object.entries(context)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
  }

  webhook(context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.log(`[WEBHOOK] ${formatted}`);
  }

  /**
   * Log API operations
   */
  api(context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.log(`[API] ${formatted}`);
  }

  /**
   * Log queue operations
   */
  queue(context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.log(`[QUEUE] ${formatted}`);
  }

  /**
   * Log Stripe operations
   */
  stripe(context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.log(`[STRIPE] ${formatted}`);
  }

  /**
   * Log database operations
   */
  database(context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.log(`[DB] ${formatted}`);
  }

  /**
   * Log errors with structured format
   */
  error(message: string, context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.error(`[ERROR] ${message} ${formatted}`);
  }

  /**
   * Log warnings
   */
  warn(message: string, context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.warn(`[WARN] ${message} ${formatted}`);
  }

  /**
   * Log debug information
   */
  debug(message: string, context: LogContext): void {
    const formatted = this.formatContext(context);
    this.logger.debug(`[DEBUG] ${message} ${formatted}`);
  }
}
