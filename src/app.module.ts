import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma';
import { LoggerModule } from './common/logger';
import { StripeModule } from './stripe';
import { MerchantsModule } from './merchants';
import { OrdersModule } from './orders';
import { QueueModule } from './queue';
import { WebhooksModule } from './webhooks';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    LoggerModule,
    StripeModule,
    MerchantsModule,
    OrdersModule,
    QueueModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
