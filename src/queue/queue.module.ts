import { Module } from '@nestjs/common';
import { QueueService } from './queue.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { MerchantsModule } from '../merchants';
import { OrdersModule } from '../orders';

@Module({
  imports: [MerchantsModule, OrdersModule],
  providers: [QueueService, WebhookProcessorService],
  exports: [QueueService],
})
export class QueueModule {}
