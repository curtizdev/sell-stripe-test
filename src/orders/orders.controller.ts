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
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto';
import { Order } from '@prisma/client';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * POST /orders
   * Create a new order
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new order',
    description:
      'Creates a new order for a merchant. The order starts in PENDING status and transitions based on payment events.',
  })
  @ApiBody({ type: CreateOrderDto })
  @ApiResponse({
    status: 201,
    description: 'Order created successfully',
    schema: {
      example: {
        id: 'clx789ghi012jkl345',
        merchantId: 'clx123abc456def789',
        amount: 2999,
        currency: 'usd',
        status: 'PENDING',
        stripeInvoiceId: null,
        failureReason: null,
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async createOrder(@Body() dto: CreateOrderDto): Promise<Order> {
    return this.ordersService.createOrder(dto);
  }

  /**
   * GET /orders/:id
   * Get an order by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get order by ID',
    description: 'Retrieves an order by its unique identifier',
  })
  @ApiParam({
    name: 'id',
    description: 'Order ID',
    example: 'clx789ghi012jkl345',
  })
  @ApiResponse({
    status: 200,
    description: 'Order found',
    schema: {
      example: {
        id: 'clx789ghi012jkl345',
        merchantId: 'clx123abc456def789',
        amount: 2999,
        currency: 'usd',
        status: 'PAID',
        stripeInvoiceId: 'in_1234567890abcdef',
        failureReason: null,
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-15T10:35:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrder(@Param('id') id: string): Promise<Order> {
    return this.ordersService.getOrder(id);
  }
}
