import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  //   ApiHeader,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { StripeEvent } from '@prisma/client';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * POST /webhooks/stripe
   * Handle incoming Stripe webhook events
   */
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint() // Hide from Swagger as this is called by Stripe
  async handleStripeWebhook(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; eventId: string }> {
    if (!request.rawBody) {
      throw new Error('Raw body not available');
    }

    const event = await this.webhooksService.handleWebhook(
      request.rawBody,
      signature,
    );

    return {
      received: true,
      eventId: event.stripeEventId,
    };
  }

  /**
   * GET /webhooks/events
   * Get stored webhook events (for debugging/monitoring)
   */
  @Get('events')
  @ApiOperation({
    summary: 'List webhook events',
    description:
      'Retrieves stored Stripe webhook events for debugging and monitoring',
  })
  @ApiQuery({
    name: 'processed',
    required: false,
    type: String,
    enum: ['true', 'false'],
    description: 'Filter by processed status',
  })
  @ApiQuery({
    name: 'eventType',
    required: false,
    type: String,
    description:
      'Filter by Stripe event type (e.g., invoice.payment_succeeded)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of events to return (default: 50)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of webhook events',
    schema: {
      example: [
        {
          id: 'clx111aaa222bbb333',
          stripeEventId: 'evt_1234567890abcdef',
          eventType: 'invoice.payment_succeeded',
          payload: '{"id":"evt_1234567890abcdef",...}',
          processed: true,
          processedAt: '2024-01-15T10:35:00.000Z',
          error: null,
          retryCount: 0,
          createdAt: '2024-01-15T10:30:00.000Z',
        },
      ],
    },
  })
  async getEvents(
    @Query('processed') processed?: string,
    @Query('eventType') eventType?: string,
    @Query('limit') limit?: string,
  ): Promise<StripeEvent[]> {
    return this.webhooksService.getEvents({
      processed:
        processed === 'true' ? true : processed === 'false' ? false : undefined,
      eventType,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * GET /webhooks/events/:id
   * Get a specific event by Stripe event ID
   */
  @Get('events/:id')
  @ApiOperation({
    summary: 'Get webhook event by ID',
    description: 'Retrieves a specific webhook event by its Stripe event ID',
  })
  @ApiParam({
    name: 'id',
    description: 'Stripe event ID',
    example: 'evt_1234567890abcdef',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook event found',
    schema: {
      example: {
        id: 'clx111aaa222bbb333',
        stripeEventId: 'evt_1234567890abcdef',
        eventType: 'invoice.payment_succeeded',
        payload: '{"id":"evt_1234567890abcdef",...}',
        processed: true,
        processedAt: '2024-01-15T10:35:00.000Z',
        error: null,
        retryCount: 0,
        createdAt: '2024-01-15T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async getEvent(
    @Param('id') stripeEventId: string,
  ): Promise<StripeEvent | null> {
    return this.webhooksService.getEvent(stripeEventId);
  }

  /**
   * POST /webhooks/events/:id/reprocess
   * Manually reprocess a failed event
   */
  @Post('events/:id/reprocess')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reprocess a webhook event',
    description:
      'Manually trigger reprocessing of a failed or unprocessed webhook event',
  })
  @ApiParam({
    name: 'id',
    description: 'Stripe event ID to reprocess',
    example: 'evt_1234567890abcdef',
  })
  @ApiResponse({
    status: 200,
    description: 'Event queued for reprocessing',
    schema: {
      example: {
        success: true,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Event not found' })
  async reprocessEvent(
    @Param('id') stripeEventId: string,
  ): Promise<{ success: boolean }> {
    await this.webhooksService.reprocessEvent(stripeEventId);
    return { success: true };
  }
}
