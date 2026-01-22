import {
  IsString,
  IsNumber,
  IsNotEmpty,
  Min,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateOrderDto {
  @ApiProperty({
    description: 'The ID of the merchant placing the order',
    example: 'clx123abc456def789',
  })
  @IsString()
  @IsNotEmpty()
  merchantId: string;

  @ApiProperty({
    description: 'The order amount in cents (smallest currency unit)',
    example: 2999,
    minimum: 1,
  })
  @IsNumber()
  @Min(1)
  amount: number; // Amount in cents

  @ApiPropertyOptional({
    description: 'The currency code (ISO 4217). Defaults to USD',
    example: 'usd',
    default: 'usd',
  })
  @IsString()
  @IsOptional()
  currency?: string; // Defaults to 'usd'
}
