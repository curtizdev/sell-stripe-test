import { Module, Global } from '@nestjs/common';
import { StructuredLoggerService } from './structured-logger.service';

@Global()
@Module({
  providers: [StructuredLoggerService],
  exports: [StructuredLoggerService],
})
export class LoggerModule {}
