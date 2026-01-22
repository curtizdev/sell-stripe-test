-=';ln# SellAbroad Billing Service

A production-grade Stripe subscription billing system with off-session payments, webhook processing, and order lifecycle management built with NestJS.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Setup Instructions](#setup-instructions)
- [Database Schema](#database-schema)
- [API Endpoints](#api-endpoints)
- [Webhook Event Flow](#webhook-event-flow)
- [Failure Modes Handling](#failure-modes-handling)
- [Observability & Logging](#observability--logging)
- [Design Decisions](#design-decisions)
- [Known Limitations](#known-limitations)

## Overview

This service handles:

1. **Merchant Management** - Create merchants and manage their profiles
2. **Subscription Billing** - Create Stripe subscriptions with 3DS support and off-session renewals
3. **Order Lifecycle** - Track orders from pending → paid/payment_failed
4. **Webhook Processing** - Idempotent, async webhook processing with BullMQ

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        NestJS Application                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Merchants  │  │   Orders    │  │  Webhooks   │              │
│  │   Module    │  │   Module    │  │   Module    │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │              Shared Services                     │            │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │            │
│  │  │ Prisma  │  │ Stripe  │  │  Structured     │  │            │
│  │  │ Service │  │ Service │  │  Logger         │  │            │
│  │  └────┬────┘  └────┬────┘  └────────┬────────┘  │            │
│  └───────┼────────────┼────────────────┼───────────┘            │
│          │            │                │                         │
└──────────┼────────────┼────────────────┼─────────────────────────┘
           │            │                │
           ▼            ▼                │
    ┌──────────┐  ┌──────────┐          │
    │  SQLite  │  │  Stripe  │          │
    │    DB    │  │   API    │          │
    └──────────┘  └──────────┘          │
                                        ▼
                              ┌─────────────────┐
                              │   Console/Log   │
                              │   Aggregator    │
                              └─────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Async Processing Layer                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐        ┌─────────────┐                         │
│  │   BullMQ    │◄──────►│    Redis    │                         │
│  │   Worker    │        │             │                         │
│  └──────┬──────┘        └─────────────┘                         │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────┐            │
│  │           Webhook Processor Service              │            │
│  │  • invoice.payment_succeeded                     │            │
│  │  • invoice.payment_failed                        │            │
│  │  • customer.subscription.updated                 │            │
│  └─────────────────────────────────────────────────┘            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Setup Instructions

### Prerequisites

- Node.js >= 20.x
- pnpm (recommended) or npm
- Redis server (for BullMQ job queue)
- Stripe account (test mode)

### 1. Clone and Install

```bash
git clone <repository-url>
cd sellabroad-test
pnpm install
```

### 2. Configure Environment

Copy the example environment file and update with your values:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Database
DATABASE_URL="file:./dev.db"

# Stripe (use test mode keys)
STRIPE_SECRET_KEY="sk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_DEFAULT_PRICE_ID="price_..."

# Redis for BullMQ
REDIS_HOST="localhost"
REDIS_PORT="6379"

# Application
PORT="3000"
NODE_ENV="development"
```

### 3. Setup Database

```bash
# Generate Prisma client
npx prisma generate

# Create database and tables
npx prisma db push
```

### 4. Start Redis

```bash
# Using Docker
docker run -d --name redis -p 6379:6379 redis:alpine

# Or using Homebrew on macOS
brew services start redis
```

### 5. Run the Application

```bash
# Development mode
pnpm start:dev

# Production mode
pnpm build && pnpm start:prod
```

### 6. Setup Stripe Webhook (for local testing)

Use Stripe CLI to forward webhooks to your local server:

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login to Stripe
stripe login

# Forward webhooks
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Copy the webhook signing secret from the CLI output to your `.env` file.

## Database Schema

### Entity Relationship Diagram

```
┌─────────────────┐       ┌─────────────────┐
│    merchants    │       │  subscriptions  │
├─────────────────┤       ├─────────────────┤
│ id (PK)         │──┐    │ id (PK)         │
│ name            │  │    │ merchantId (FK) │◄─┐
│ email (unique)  │  └───►│ stripeSubId     │  │
│ stripeCustomerId│       │ stripePriceId   │  │
│ defaultPaymentM │       │ status          │  │
│ createdAt       │       │ periodStart     │  │
│ updatedAt       │       │ periodEnd       │  │
└─────────────────┘       │ canceledAt      │  │
         │                │ cancelAtEnd     │  │
         │                │ createdAt       │  │
         │                │ updatedAt       │  │
         │                └─────────────────┘  │
         │                                     │
         │                ┌─────────────────┐  │
         │                │     orders      │  │
         │                ├─────────────────┤  │
         └───────────────►│ id (PK)         │  │
                          │ merchantId (FK) │──┘
                          │ amount          │
                          │ currency        │
                          │ status          │
                          │ stripeInvoiceId │
                          │ paidAt          │
                          │ failedAt        │
                          │ failureReason   │
                          │ createdAt       │
                          │ updatedAt       │
                          └─────────────────┘

┌─────────────────┐
│  stripe_events  │
├─────────────────┤
│ id (PK)         │
│ stripeEventId   │
│ eventType       │
│ payload (JSON)  │
│ processed       │
│ processedAt     │
│ processingError │
│ retryCount      │
│ createdAt       │
│ updatedAt       │
└─────────────────┘
```

### Table Descriptions

| Table           | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `merchants`     | Stores business customers with their Stripe customer ID        |
| `subscriptions` | Tracks subscription state (active, past_due, canceled, unpaid) |
| `orders`        | Manages order lifecycle (pending → paid/payment_failed)        |
| `stripe_events` | Webhook event log for idempotency and audit trail              |

### Subscription Statuses

| Status       | Description                             |
| ------------ | --------------------------------------- |
| `incomplete` | Initial setup, awaiting first payment   |
| `active`     | Subscription is active and paid         |
| `past_due`   | Payment failed, in retry/dunning period |
| `unpaid`     | All retry attempts exhausted            |
| `canceled`   | Subscription has been canceled          |
| `trialing`   | In trial period (if configured)         |

### Order Statuses

| Status           | Description                     |
| ---------------- | ------------------------------- |
| `pending`        | Order created, awaiting payment |
| `paid`           | Payment successful              |
| `payment_failed` | Payment failed                  |
| `refunded`       | Order refunded                  |
| `canceled`       | Order canceled                  |

## API Documentation

This project uses **Swagger** for interactive API documentation.

After starting the server, visit: [http://localhost:3000/api](http://localhost:3000/api)

You can view and test all available endpoints, see request/response schemas, and try out the API directly from the browser.

## API Endpoints

### Merchants

#### Create Merchant

```http
POST /merchants
Content-Type: application/json

{
  "name": "Acme Corp",
  "email": "billing@acme.com"
}

Response: 201 Created
{
  "id": "uuid",
  "name": "Acme Corp",
  "email": "billing@acme.com",
  "stripeCustomerId": null,
  "defaultPaymentMethodId": null,
  "createdAt": "2026-01-22T10:00:00Z",
  "updatedAt": "2026-01-22T10:00:00Z"
}
```

#### Get Merchant

```http
GET /merchants/:id

Response: 200 OK
{
  "id": "uuid",
  "name": "Acme Corp",
  ...
}
```

#### Create Subscription

```http
POST /merchants/:id/subscriptions
Content-Type: application/json

{
  "planId": "price_xxx",
  "paymentMethodId": "pm_xxx" // optional
}

Response: 201 Created
{
  "subscription": {
    "id": "uuid",
    "merchantId": "uuid",
    "stripeSubscriptionId": "sub_xxx",
    "status": "active",
    ...
  },
  "clientSecret": "pi_xxx_secret_xxx", // Present if 3DS required
  "requiresAction": false
}
```

#### Create SetupIntent (for payment method collection)

```http
POST /merchants/:id/setup-intent

Response: 201 Created
{
  "clientSecret": "seti_xxx_secret_xxx"
}
```

### Orders

#### Create Order

```http
POST /orders
Content-Type: application/json

{
  "merchantId": "uuid",
  "amount": 2999, // Amount in cents
  "currency": "usd"
}

Response: 201 Created
{
  "id": "uuid",
  "merchantId": "uuid",
  "amount": 2999,
  "currency": "usd",
  "status": "pending",
  "stripeInvoiceId": null,
  "paidAt": null,
  "failedAt": null,
  "failureReason": null,
  "createdAt": "2026-01-22T10:00:00Z",
  "updatedAt": "2026-01-22T10:00:00Z"
}
```

#### Get Order

```http
GET /orders/:id

Response: 200 OK
{
  "id": "uuid",
  "status": "paid",
  ...
}
```

### Webhooks

#### Stripe Webhook Endpoint

```http
POST /webhooks/stripe
Headers:
  stripe-signature: t=xxx,v1=xxx,...

Body: Raw Stripe webhook payload

Response: 200 OK
{
  "received": true,
  "eventId": "evt_xxx"
}
```

#### Get Webhook Events (Admin/Debug)

```http
GET /webhooks/events?processed=false&eventType=invoice.payment_failed&limit=50

Response: 200 OK
[
  {
    "id": "uuid",
    "stripeEventId": "evt_xxx",
    "eventType": "invoice.payment_failed",
    "processed": false,
    ...
  }
]
```

#### Reprocess Failed Event

```http
POST /webhooks/events/:stripeEventId/reprocess

Response: 200 OK
{
  "success": true
}
```

## Webhook Event Flow

### Flow Diagram

```
    Stripe                    App                     Redis/BullMQ
      │                        │                           │
      │  1. POST /webhooks/stripe                          │
      │───────────────────────►│                           │
      │                        │                           │
      │                   2. Verify signature              │
      │                        │                           │
      │                   3. Check idempotency             │
      │                      (duplicate?)                  │
      │                        │                           │
      │                   4. Persist to                    │
      │                      stripe_events                 │
      │                        │                           │
      │                        │  5. Enqueue job           │
      │                        │──────────────────────────►│
      │                        │                           │
      │  6. 200 OK             │                           │
      │◄───────────────────────│                           │
      │                        │                           │
      │                        │  7. Process job (async)   │
      │                        │◄──────────────────────────│
      │                        │                           │
      │                   8. Update DB in                  │
      │                      transaction                   │
      │                        │                           │
      │                   9. Mark event                    │
      │                      as processed                  │
      │                        │                           │
```

### Supported Events

| Event                           | Action                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `invoice.payment_succeeded`     | Update subscription to `active`, update order to `paid`             |
| `invoice.payment_failed`        | Update subscription to `past_due`, update order to `payment_failed` |
| `customer.subscription.updated` | Sync subscription status from Stripe                                |
| `customer.subscription.deleted` | Mark subscription as `canceled`                                     |

### Processing Guarantees

1. **At-least-once delivery** - Events are retried on failure
2. **Idempotency** - Duplicate events are detected and skipped
3. **Ordered processing within entity** - Same subscription events processed in order
4. **Transactional updates** - DB updates are atomic

## Failure Modes Handling

### 1. Webhook Delays

**Problem**: Stripe may delay webhook delivery during outages or high load.

**Solution**:

- Events are persisted immediately upon receipt
- BullMQ job queue handles async processing with configurable timeouts
- Stripe has built-in retry logic (up to 3 days)
- Admin endpoint allows manual reprocessing of stuck events

**Example Log**:

```
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx action=received
[QUEUE] action=job_enqueued jobId=evt_xxx eventType=invoice.payment_succeeded
```

### 2. Out-of-Order Delivery

**Problem**: Events may arrive out of chronological order (e.g., `payment_succeeded` before `subscription.created`).

**Solution**:

- Events are processed based on current state, not assumed sequence
- Status transitions are validated (e.g., don't mark as paid if already paid)
- `customer.subscription.updated` syncs the authoritative state from Stripe
- Idempotent operations ensure safe replay

**Example**:

```typescript
// In OrdersService.markOrderAsPaid
if (order.status === OrderStatus.PAID) {
  // Already paid, skip to maintain idempotency
  return order;
}
```

### 3. Duplicate Events

**Problem**: Stripe may send the same event multiple times.

**Solution**:

- `stripe_events` table has unique constraint on `stripeEventId`
- Duplicate detection before processing
- BullMQ job ID set to Stripe event ID for queue-level deduplication
- Idempotent status update operations

**Example Log**:

```
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx action=duplicate_ignored
```

### 4. requires_payment_method Scenarios

**Problem**: Subscription requires a new payment method (e.g., card declined, 3DS required).

**Solution**:

- SetupIntent flow creates mandates for off-session payments
- `createSubscription` returns `clientSecret` and `requiresAction: true` when 3DS needed
- Frontend uses `confirmCardSetup` or `confirmCardPayment` to complete 3DS
- Subscription status tracked as `incomplete` until resolved

**Example Response**:

```json
{
  "subscription": { "status": "incomplete" },
  "clientSecret": "pi_xxx_secret_xxx",
  "requiresAction": true
}
```

### 5. Customer Removed Default Payment Method

**Problem**: Customer removes their payment method between billing cycles.

**Solution**:

- Stripe's `invoice.payment_failed` webhook triggers on billing failure
- Subscription moves to `past_due` status
- Merchant can be notified (future enhancement)
- `POST /merchants/:id/setup-intent` allows collecting new payment method

**Webhook Flow**:

```
invoice.payment_failed → subscription.status = past_due
customer.subscription.updated → sync status
```

### 6. Card Expired Between Cycles

**Problem**: Card expires before the next billing cycle.

**Solution**:

- Same flow as removed payment method
- `invoice.payment_failed` triggers with `card_declined` reason
- Stripe's Smart Retries attempt alternative times
- Dunning emails handled by Stripe
- After exhausting retries: status → `unpaid` or `canceled`

**Example Log**:

```
[WEBHOOK] event=invoice.payment_failed eventId=evt_xxx merchantId=uuid
          subscriptionId=sub_xxx action=subscription_past_due
          failureReason="Your card has expired."
```

### Recovery Matrix

| Failure           | Detection                | Recovery              |
| ----------------- | ------------------------ | --------------------- |
| Webhook delay     | Stripe retries           | Automatic             |
| Out-of-order      | State validation         | Idempotent ops        |
| Duplicates        | DB unique constraint     | Skip processing       |
| 3DS required      | `requiresAction` flag    | Frontend flow         |
| No payment method | `invoice.payment_failed` | SetupIntent flow      |
| Expired card      | `invoice.payment_failed` | Dunning + SetupIntent |

## Observability & Logging

### Log Format

All logs follow a structured format for easy parsing:

```
[CATEGORY] key1=value1 key2=value2 key3=value3
```

### Log Categories

| Category    | Purpose               |
| ----------- | --------------------- |
| `[WEBHOOK]` | Stripe webhook events |
| `[API]`     | REST API operations   |
| `[QUEUE]`   | BullMQ job operations |
| `[STRIPE]`  | Stripe API calls      |
| `[DB]`      | Database operations   |
| `[ERROR]`   | Error conditions      |
| `[WARN]`    | Warning conditions    |

### Example Logs

#### Successful Subscription Flow

```
[API] action=create_merchant email=billing@acme.com
[DB] action=merchant_created merchantId=abc-123 email=billing@acme.com
[STRIPE] action=create_customer merchantId=abc-123 email=billing@acme.com
[STRIPE] action=customer_created merchantId=abc-123 stripeCustomerId=cus_xxx
[DB] action=merchant_stripe_customer_linked merchantId=abc-123 stripeCustomerId=cus_xxx
[STRIPE] action=create_subscription stripeCustomerId=cus_xxx priceId=price_xxx
[STRIPE] action=subscription_created stripeCustomerId=cus_xxx subscriptionId=sub_xxx status=active
[DB] action=subscription_created merchantId=abc-123 subscriptionId=def-456 stripeSubscriptionId=sub_xxx status=active
```

#### Webhook Processing

```
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx action=received
[DB] action=stripe_event_persisted eventId=evt_xxx eventType=invoice.payment_succeeded entityId=ghi-789
[QUEUE] action=job_enqueued queueName=stripe-webhooks jobId=evt_xxx eventType=invoice.payment_succeeded
[QUEUE] action=processing_job jobId=evt_xxx eventType=invoice.payment_succeeded attempt=1
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx invoiceId=inv_xxx stripeCustomerId=cus_xxx action=processing
[DB] action=subscription_status_updated subscriptionId=def-456 merchantId=abc-123 oldStatus=incomplete newStatus=active
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx invoiceId=inv_xxx merchantId=abc-123 subscriptionId=sub_xxx action=subscription_activated
[WEBHOOK] event=invoice.payment_succeeded eventId=evt_xxx action=processed_successfully
[QUEUE] action=job_completed jobId=evt_xxx eventType=invoice.payment_succeeded
```

#### Payment Failure

```
[WEBHOOK] event=invoice.payment_failed eventId=evt_yyy action=received
[QUEUE] action=processing_job jobId=evt_yyy eventType=invoice.payment_failed attempt=1
[WEBHOOK] event=invoice.payment_failed eventId=evt_yyy invoiceId=inv_yyy merchantId=abc-123 subscriptionId=sub_xxx action=subscription_past_due failureReason="Your card was declined."
[DB] action=subscription_status_updated subscriptionId=def-456 merchantId=abc-123 oldStatus=active newStatus=past_due
```

## Design Decisions

### 1. SQLite over PostgreSQL

**Decision**: Use SQLite for the demo instead of PostgreSQL.

**Rationale**:

- Zero setup required for reviewers
- Single file database, easy to reset
- Sufficient for demo workloads
- Prisma abstracts away most differences

**Trade-offs**:

- No concurrent write scaling
- Limited to single instance deployment
- No `FOR UPDATE` lock support (use transactions)

### 2. BullMQ over Direct Processing

**Decision**: Process webhooks asynchronously via BullMQ queue.

**Rationale**:

- Webhook endpoint returns quickly (< 200ms)
- Built-in retry with exponential backoff
- Automatic job deduplication by ID
- Visibility into job status
- Can scale workers independently

**Trade-offs**:

- Requires Redis
- Eventual consistency (slight delay)
- More moving parts

### 3. SetupIntent for Off-Session Mandates

**Decision**: Use SetupIntent with `usage: 'off_session'` for payment method attachment.

**Rationale**:

- Creates proper mandate for future off-session charges
- Handles 3DS during setup rather than at renewal
- Compliant with SCA requirements
- Better UX for recurring billing

### 4. Idempotency via Stripe Event ID

**Decision**: Use Stripe's event ID as the idempotency key.

**Rationale**:

- Guaranteed unique by Stripe
- Survives replays and retries
- Works at both DB and queue level
- Simple implementation

### 5. Transaction-Based State Updates

**Decision**: Use database transactions for webhook processing.

**Rationale**:

- Atomic updates across related entities
- Consistent state even on partial failures
- Easy rollback on errors
- SQLite supports transactions natively

### 6. Structured Logging Pattern

**Decision**: Custom structured logger with consistent format.

**Rationale**:

- Easy to parse with log aggregators
- Consistent context across all modules
- Type-safe log context
- Simple grep/search friendly

## Known Limitations

### Current Limitations

1. **Single Redis Instance**
   - No Redis Cluster support
   - Single point of failure for job queue

2. **No Email Notifications**
   - Dunning emails rely on Stripe's built-in system
   - No custom notification system

3. **No Admin Dashboard**
   - API-only, no UI
   - Manual database queries for debugging

4. **No Rate Limiting**
   - Webhook endpoint not rate limited
   - Relies on Stripe's rate limiting

5. **No Authentication**
   - API endpoints are unprotected
   - Suitable for demo only

6. **Order-Invoice Matching**
   - Basic amount-based matching
   - May not work for complex invoices with multiple items

7. **No Webhook Event Cleanup**
   - Events accumulate forever
   - Would need periodic cleanup job

### Production Readiness Checklist

For production deployment, add:

- [ ] Authentication/Authorization (JWT, API keys)
- [ ] Rate limiting on all endpoints
- [ ] Redis Cluster for high availability
- [ ] Database migrations (not `db push`)
- [ ] Health check endpoints
- [ ] Metrics export (Prometheus)
- [ ] Distributed tracing (OpenTelemetry)
- [ ] Alerting on failure patterns
- [ ] Horizontal pod autoscaling
- [ ] Database connection pooling
- [ ] Secrets management (Vault, AWS Secrets Manager)
- [ ] Event cleanup/archival job
- [ ] Custom dunning email integration

## Testing

### Unit Tests

```bash
pnpm test
```

### E2E Tests

```bash
pnpm test:e2e
```

### Manual Testing with Stripe CLI

```bash
# Create test resources
stripe products create --name="Test Product"
stripe prices create --product=prod_xxx --unit-amount=2999 --currency=usd --recurring[interval]=month

# Trigger webhook events
stripe trigger invoice.payment_succeeded
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.updated
```

## License

UNLICENSED - Internal use only
