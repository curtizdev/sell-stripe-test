import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma';
import { StripeService } from '../stripe';
import { StructuredLoggerService } from '../common/logger';
import { CreateOrderDto } from './dto';
import { Order } from '@prisma/client';

export enum OrderStatus {
  PENDING = 'pending',
  PAID = 'paid',
  PAYMENT_FAILED = 'payment_failed',
  REFUNDED = 'refunded',
  CANCELED = 'canceled',
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Create a new order for a merchant
   */
  async createOrder(dto: CreateOrderDto): Promise<Order> {
    this.logger.api({
      action: 'create_order',
      merchantId: dto.merchantId,
      amount: dto.amount,
      currency: dto.currency || 'usd',
    });

    // Verify merchant exists
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: dto.merchantId },
    });

    if (!merchant) {
      throw new NotFoundException(
        `Merchant with ID ${dto.merchantId} not found`,
      );
    }

    // Create order in pending status
    const order = await this.prisma.order.create({
      data: {
        merchantId: dto.merchantId,
        amount: dto.amount,
        currency: dto.currency || 'usd',
        status: OrderStatus.PENDING,
      },
    });

    this.logger.database({
      action: 'order_created',
      orderId: order.id,
      merchantId: order.merchantId,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
    });

    return order;
  }

  /**
   * Get an order by ID
   */
  async getOrder(id: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({
      where: { id },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${id} not found`);
    }

    return order;
  }

  /**
   * Get all orders for a merchant
   */
  async getMerchantOrders(merchantId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get order by Stripe invoice ID
   */
  async getOrderByInvoiceId(stripeInvoiceId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({
      where: { stripeInvoiceId },
    });
  }

  /**
   * Update order status to paid (called by webhook processor)
   */
  async markOrderAsPaid(
    stripeInvoiceId: string,
    paidAt?: Date,
  ): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { stripeInvoiceId },
    });

    if (!order) {
      this.logger.warn('Order not found for payment success', {
        stripeInvoiceId,
        action: 'mark_order_paid',
      });
      return null;
    }

    // Idempotency: skip if already paid
    if (order.status === OrderStatus.PAID) {
      this.logger.debug('Order already marked as paid, skipping', {
        orderId: order.id,
        stripeInvoiceId,
      });
      return order;
    }

    const updated = await this.prisma.order.update({
      where: { stripeInvoiceId },
      data: {
        status: OrderStatus.PAID,
        paidAt: paidAt || new Date(),
      },
    });

    this.logger.database({
      action: 'order_marked_paid',
      orderId: order.id,
      merchantId: order.merchantId,
      stripeInvoiceId,
      oldStatus: order.status,
      newStatus: OrderStatus.PAID,
    });

    return updated;
  }

  /**
   * Update order status to payment_failed (called by webhook processor)
   */
  async markOrderAsPaymentFailed(
    stripeInvoiceId: string,
    failureReason?: string,
  ): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { stripeInvoiceId },
    });

    if (!order) {
      this.logger.warn('Order not found for payment failure', {
        stripeInvoiceId,
        action: 'mark_order_failed',
      });
      return null;
    }

    // Idempotency: skip if already in terminal state
    if (
      order.status === OrderStatus.PAID ||
      order.status === OrderStatus.PAYMENT_FAILED
    ) {
      this.logger.debug('Order already in terminal state, skipping', {
        orderId: order.id,
        stripeInvoiceId,
        currentStatus: order.status,
      });
      return order;
    }

    const updated = await this.prisma.order.update({
      where: { stripeInvoiceId },
      data: {
        status: OrderStatus.PAYMENT_FAILED,
        failedAt: new Date(),
        failureReason: failureReason || 'Payment failed',
      },
    });

    this.logger.database({
      action: 'order_marked_payment_failed',
      orderId: order.id,
      merchantId: order.merchantId,
      stripeInvoiceId,
      oldStatus: order.status,
      newStatus: OrderStatus.PAYMENT_FAILED,
      failureReason,
    });

    return updated;
  }

  /**
   * Link an order to a Stripe invoice
   */
  async linkOrderToInvoice(
    orderId: string,
    stripeInvoiceId: string,
  ): Promise<Order> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    if (order.stripeInvoiceId) {
      throw new BadRequestException('Order is already linked to an invoice');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { stripeInvoiceId },
    });

    this.logger.database({
      action: 'order_linked_to_invoice',
      orderId: order.id,
      merchantId: order.merchantId,
      stripeInvoiceId,
    });

    return updated;
  }

  /**
   * Find pending orders for a merchant that might match an invoice
   * Used during webhook processing to link invoices to orders
   */
  async findPendingOrdersForMerchant(merchantId: string): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: {
        merchantId,
        status: OrderStatus.PENDING,
        stripeInvoiceId: null,
      },
      orderBy: { createdAt: 'asc' }, // FIFO
    });
  }

  /**
   * Update order status by merchant (for matching during webhook processing)
   * This finds orders by merchant and amount for invoice matching
   */
  async findAndLinkOrderToInvoice(
    merchantId: string,
    stripeInvoiceId: string,
    amountPaid: number,
  ): Promise<Order | null> {
    // Find pending order matching the amount
    const pendingOrder = await this.prisma.order.findFirst({
      where: {
        merchantId,
        status: OrderStatus.PENDING,
        stripeInvoiceId: null,
        amount: amountPaid,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!pendingOrder) {
      return null;
    }

    const updated = await this.prisma.order.update({
      where: { id: pendingOrder.id },
      data: { stripeInvoiceId },
    });

    this.logger.database({
      action: 'order_auto_linked_to_invoice',
      orderId: pendingOrder.id,
      merchantId,
      stripeInvoiceId,
      amount: amountPaid,
    });

    return updated;
  }
}
