import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubscriptionDto {
  @ApiProperty({
    description: 'The Stripe Price ID for the subscription plan',
    example: 'price_1234567890abcdef',
  })
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiPropertyOptional({
    description:
      'Optional Stripe Payment Method ID. If not provided, uses the default payment method on file',
    example: 'pm_1234567890abcdef',
  })
  @IsString()
  @IsOptional()
  paymentMethodId?: string;
}
