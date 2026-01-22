import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { MerchantsService, SubscriptionResult } from './merchants.service';
import { CreateMerchantDto, CreateSubscriptionDto } from './dto';
import { Merchant, Subscription } from '@prisma/client';

@ApiTags('Merchants')
@Controller('merchants')
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

  /**
   * POST /merchants
   * Create a new merchant
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new merchant',
    description:
      'Creates a new merchant account and corresponding Stripe customer',
  })
  @ApiBody({ type: CreateMerchantDto })
  @ApiResponse({
    status: 201,
    description: 'Merchant created successfully',
    schema: {
      example: {
        id: 'clx123abc456def789',
        name: 'Acme Corp',
        email: 'billing@acmecorp.com',
        stripeCustomerId: 'cus_1234567890abcdef',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async createMerchant(@Body() dto: CreateMerchantDto): Promise<Merchant> {
    return this.merchantsService.createMerchant(dto);
  }

  /**
   * GET /merchants/:id
   * Get a merchant by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get merchant by ID',
    description: 'Retrieves a merchant by their unique identifier',
  })
  @ApiParam({
    name: 'id',
    description: 'Merchant ID',
    example: 'clx123abc456def789',
  })
  @ApiResponse({
    status: 200,
    description: 'Merchant found',
    schema: {
      example: {
        id: 'clx123abc456def789',
        name: 'Acme Corp',
        email: 'billing@acmecorp.com',
        stripeCustomerId: 'cus_1234567890abcdef',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async getMerchant(@Param('id') id: string): Promise<Merchant> {
    return this.merchantsService.getMerchant(id);
  }

  /**
   * POST /merchants/:id/subscriptions
   * Create a subscription for a merchant
   * Returns clientSecret if 3DS is required
   */
  @Post(':id/subscriptions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create subscription for merchant',
    description:
      'Creates a new subscription for the merchant. Returns clientSecret if 3D Secure authentication is required.',
  })
  @ApiParam({
    name: 'id',
    description: 'Merchant ID',
    example: 'clx123abc456def789',
  })
  @ApiBody({ type: CreateSubscriptionDto })
  @ApiResponse({
    status: 201,
    description: 'Subscription created successfully',
    schema: {
      example: {
        subscription: {
          id: 'clx456def789ghi012',
          merchantId: 'clx123abc456def789',
          stripeSubscriptionId: 'sub_1234567890abcdef',
          stripePriceId: 'price_1234567890abcdef',
          status: 'active',
          currentPeriodStart: '2024-01-15T10:30:00.000Z',
          currentPeriodEnd: '2024-02-15T10:30:00.000Z',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
        },
        clientSecret: null,
        requiresAction: false,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or payment failed',
  })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async createSubscription(
    @Param('id') merchantId: string,
    @Body() dto: CreateSubscriptionDto,
  ): Promise<SubscriptionResult> {
    return this.merchantsService.createSubscription(merchantId, dto);
  }

  /**
   * GET /merchants/:id/subscriptions
   * Get all subscriptions for a merchant
   */
  @Get(':id/subscriptions')
  @ApiOperation({
    summary: 'Get merchant subscriptions',
    description: 'Retrieves all subscriptions for a specific merchant',
  })
  @ApiParam({
    name: 'id',
    description: 'Merchant ID',
    example: 'clx123abc456def789',
  })
  @ApiResponse({
    status: 200,
    description: 'List of merchant subscriptions',
    schema: {
      example: [
        {
          id: 'clx456def789ghi012',
          merchantId: 'clx123abc456def789',
          stripeSubscriptionId: 'sub_1234567890abcdef',
          stripePriceId: 'price_1234567890abcdef',
          status: 'active',
          currentPeriodStart: '2024-01-15T10:30:00.000Z',
          currentPeriodEnd: '2024-02-15T10:30:00.000Z',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
        },
      ],
    },
  })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async getMerchantSubscriptions(
    @Param('id') merchantId: string,
  ): Promise<Subscription[]> {
    return this.merchantsService.getMerchantSubscriptions(merchantId);
  }

  /**
   * POST /merchants/:id/setup-intent
   * Create a SetupIntent for collecting payment method
   */
  @Post(':id/setup-intent')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create payment method setup intent',
    description:
      'Creates a Stripe SetupIntent for securely collecting and storing a payment method',
  })
  @ApiParam({
    name: 'id',
    description: 'Merchant ID',
    example: 'clx123abc456def789',
  })
  @ApiResponse({
    status: 201,
    description: 'SetupIntent created successfully',
    schema: {
      example: {
        clientSecret: 'seti_1234567890abcdef_secret_abc123',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async createSetupIntent(
    @Param('id') merchantId: string,
  ): Promise<{ clientSecret: string }> {
    return this.merchantsService.createSetupIntent(merchantId);
  }
}
