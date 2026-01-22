import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    // Enable raw body for webhook signature verification
    rawBody: true,
  });

  // Enable global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Enable CORS for development
  app.enableCors();

  // Swagger configuration with custom UI
  const config = new DocumentBuilder()
    .setTitle('SellAbroad Billing API')
    .setDescription(
      `
## 🚀 Stripe Subscription Billing Service

A comprehensive billing service that handles merchant subscriptions, off-session renewals, 
and order lifecycle management with Stripe integration.

### Features
- **Merchants**: Create and manage merchant accounts with Stripe customers
- **Subscriptions**: Handle subscription creation with 3DS authentication support
- **Orders**: Track order lifecycle linked to billing events
- **Webhooks**: Process Stripe webhook events via async job queue
- **Observability**: Structured logging with event tracing

### Authentication
Configure your Stripe API keys in the environment variables.
    `.trim(),
    )
    .setVersion('1.0.0')
    .setContact(
      'SellAbroad Team',
      'https://sellabroad.com',
      'support@sellabroad.com',
    )
    .setLicense('MIT', 'https://opensource.org/licenses/MIT')
    .addTag('Merchants', 'Merchant account and subscription management')
    .addTag('Orders', 'Order lifecycle management')
    .addTag('Webhooks', 'Stripe webhook processing and event management')
    .addServer('http://localhost:3000', 'Local Development')
    .build();

  const document = SwaggerModule.createDocument(
    app as Parameters<typeof SwaggerModule.createDocument>[0],
    config,
  );

  SwaggerModule.setup(
    'api',
    app as Parameters<typeof SwaggerModule.setup>[1],
    document,
    {
      customSiteTitle: 'SellAbroad Billing API Docs',
      customfavIcon: 'https://stripe.com/favicon.ico',
      customCss: `
      .swagger-ui .topbar { display: none }
      .swagger-ui .info .title { color: #635BFF; }
      .swagger-ui .info .description { font-size: 14px; }
      .swagger-ui .opblock.opblock-post { border-color: #49cc90; background: rgba(73, 204, 144, 0.1); }
      .swagger-ui .opblock.opblock-get { border-color: #61affe; background: rgba(97, 175, 254, 0.1); }
      .swagger-ui .opblock.opblock-put { border-color: #fca130; background: rgba(252, 161, 48, 0.1); }
      .swagger-ui .opblock.opblock-delete { border-color: #f93e3e; background: rgba(249, 62, 62, 0.1); }
      .swagger-ui .btn.execute { background-color: #635BFF; border-color: #635BFF; }
      .swagger-ui .btn.execute:hover { background-color: #4B45C6; border-color: #4B45C6; }
      .swagger-ui section.models { border-color: #635BFF; }
      .swagger-ui section.models .model-box { background: #fafafa; }
    `,
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
        filter: true,
        showRequestDuration: true,
        syntaxHighlight: {
          activate: true,
          theme: 'monokai',
        },
      },
    },
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`Application is running on: http://localhost:${port}`);
  logger.log('Webhook endpoint: POST /webhooks/stripe');
  logger.log('API endpoints:');
  logger.log('  POST   /merchants');
  logger.log('  GET    /merchants/:id');
  logger.log('  POST   /merchants/:id/subscriptions');
  logger.log('  GET    /merchants/:id/subscriptions');
  logger.log('  POST   /merchants/:id/setup-intent');
  logger.log('  POST   /orders');
  logger.log('  GET    /orders/:id');
}

bootstrap();
