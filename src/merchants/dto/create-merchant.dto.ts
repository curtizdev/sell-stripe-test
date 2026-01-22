import { IsString, IsEmail, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateMerchantDto {
  @ApiProperty({
    description: 'The name of the merchant',
    example: 'Acme Corp',
    minLength: 2,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  name: string;

  @ApiProperty({
    description: 'The email address of the merchant',
    example: 'billing@acmecorp.com',
    format: 'email',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
