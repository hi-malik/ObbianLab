# Strict review: booking allocation and financial consistency

## Verdict and defects corrected

The original implementation was not ready to pass scenarios 1 and 5. The review found functional backend foundations but critical authorization and accounting defects.

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| Caller-controlled identity and finance roles; shared WebSocket token could subscribe as any actor | Strict bearer authentication by default; HMAC-signed actor/tenant/expiry JWT; tenant membership and roles read from PostgreSQL; explicit local demo mode only | `apps/api/test/security.test.ts`; live forged-role/tenant tests |
| Booking idempotency response could be reused by another actor in a tenant | Actor included in request fingerprint; active category checked against tenant | API request validation and database ownership checks |
| Missing start/completion lifecycle left assignments active forever | Assigned professional can start and complete; completion atomically releases assignment and writes event | Live completion/assignment check |
| Rejected final offer could leave booking permanently requested | Terminal attempt handling and rejection/unfulfilled outbox events | Live rejection to alternate professional; allocation timeout regression |
| ETA was only displayed, not used for eligibility | Availability and Go allocation enforce `maxEtaSeconds` (120–14400; default 1800), radius, presence freshness, category and overlap | API/Go code and integration checks |
| WebSocket changes were emitted only by one API process; allocation changes were absent | Transactional PostgreSQL notifications notify every API replica, including allocation and tracking changes | Live signed Socket.IO subscription and committed location event |
| Different payment retry keys could create multiple charges for one booking | Booking row lock, reuse identical intent and unique booking payment constraint | Six concurrent distinct keys return one intent |
| Customers could choose the payable amount in strict mode | Immutable server-issued booking quote and exact amount/currency validation; missing pricing policy fails closed | 3 PostgreSQL pricing integration tests; [pricing review](review-pricing.md) |
| Partial-refund rounding did not fully reverse original commission | Refund split uses cumulative commission difference | Unit fragmented refund test and real 101-unit full reversal |
| A historical settlement cutoff excluded payout debits and allowed repaying earnings | Every debit is included; eligible credits are bounded by cutoff; locked payable account and transaction retry | Same-period new-key and concurrent payout regression |
| Retried capture under another event ID caused false reconciliation mismatch | Business no-op recorded as `applied=false`; reconciliation compares applied events and ledger counts/amounts | Concurrent capture and delayed capture after full refund |
| Failed/out-of-order webhook transactions lost the inbox record | Verified inbox persisted first, bounded background retries, retained error, finance replay endpoint | Refund delivered before capture recovers automatically |
| Missing cross-event refund identity | Optional stable `refundId` stored uniquely per payment, with amount fingerprint validation | Same refund ID under different webhook event IDs applies once |
| Serialization/deadlock errors escaped without recovery | Fully rolled-back DB-only transactions retry with bounded jitter; external delivery remains in outbox | Transaction retry tests |
| Ledger transaction could be empty or use another tenant/currency account | Deferred nonempty/balance check and account ownership/currency trigger | Migration 004; database negative checks |

## Interfaces added or tightened

- `POST /bookings/:id/start`, `POST /bookings/:id/complete`: assigned professional lifecycle.
- `GET /bookings/:id/locations/latest`: authorized reconnect snapshot.
- `POST /payments/webhooks/:eventId/replay`: finance-only recovery of retained webhook failures.
- Booking creation/availability accept optional `maxEtaSeconds` and bounded service duration (5–1440 minutes).
- New payment intents require a confirmed, in-progress or completed booking. One logical payment intent exists per booking with fixed amount and currency; changing these requires a separate explicit business adjustment workflow.
- `GET /payments/quote/:bookingId` returns the authorized server quote. Strict mode validates every payment request against that immutable quote; a configured `SERVICE_PRICES_JSON` policy also applies in demo mode.
- Sandbox refund events accept `refundId`; real gateway adapters must provide the stable refund operation ID. With no `refundId`, the event ID is the local simulation's operation ID.
- Reconciliation includes pending webhook IDs, attempts and processing errors, plus captured/refunded ledger amount comparisons.

## Authentication contract

Strict mode is the default. `Authorization: Bearer <token>` accepts an HS256 JWT signed with `AUTH_SIGNING_SECRET` of at least 32 characters. Header is `{"alg":"HS256","typ":"JWT"}`; claims are `sub` (user UUID), `tenantId` (tenant UUID), `aud: "obbian"`, `exp` (Unix seconds), and optional `nbf`. Roles and membership are always looked up in the database. Spoofed actor/role headers do not override a signed token.

A trusted internal proxy can use `INTERNAL_SERVICE_TOKEN` and actor/tenant headers. This secret authorizes identity delegation and must never be exposed to browser code. WebSockets accept only an actor JWT in `handshake.auth.token`, even in demo mode.

`AUTH_MODE=demo` explicitly enables local header identities for HTTP demo scripts. Compose binds services to loopback; production must use strict mode, provision actor identities, use a real identity provider/token issuer and manage secrets. Demo mode is not suitable for internet exposure.

## Reliability and accounting decisions

```mermaid
sequenceDiagram
    participant Gateway as Sandbox gateway
    participant API as NestJS API
    participant DB as PostgreSQL
    participant Retry as Background recovery
    Gateway->>API: Signed event / stable refund operation ID
    API->>DB: Persist unique verified inbox record
    API->>DB: Lock inbox + payment + booking
    API->>DB: Validate transition; post balanced immutable ledger; write outbox
    API->>DB: Mark processed/applied; commit
    alt dependency missing / event out of order
        API->>DB: Retain error and next attempt
        Retry->>DB: Reprocess pending inbox (bounded attempts)
    end
    API-->>Gateway: accepted / duplicate / deferred
```

Settlement `periodEnd` is the eligibility cutoff for accumulated unpaid credits; all historical debits are included, including refunds and earlier payouts recorded after that cutoff. `periodStart` labels the settlement run; this is a cumulative balance sweep with carry-forward, not a filter that discards older unpaid earnings. Refunds after payout can produce a professional debit balance; later earnings offset it before another settlement. Payout creation and ledger posting are atomic in the **local sandbox simulator**.

WebSocket notifications are low-latency best-effort delivery after transaction commit. Committed bookings and locations are the durable source of truth; clients should read the booking and latest location after reconnect. PostgreSQL LISTEN/NOTIFY fans out to replicas but is not a historical event replay stream. Application logs are structured JSON with request IDs, route templates and timing; request bodies and bearer tokens are omitted.

## Validation

Run from the repository root after migrations and Compose startup:

```sh
npm test --workspace @obbian/api
npm run typecheck --workspace @obbian/api
python3 scripts/booking_payment_integrity_check.py
python3 scripts/concurrency_check.py
```

The integrity script creates a unique tenant and retains its rows for audit; it does not delete existing data. It verifies actual HTTP/database behavior and Socket.IO event delivery. The original concurrency script verifies the exclusion constraint under simultaneous offer acceptance.

## Explicit limitations

- Default local gateway charges and payouts use simulator IDs and HMAC webhooks. The optional real Stripe test adapter described below supports charges/refunds and independent statement reconciliation, but has not been executed against an account without credentials. Stripe Connect test transfers are implemented as described below; bank payouts and dispute/chargeback workflows remain out of scope. The default reconciliation report compares retained signed events against ledgers; the Stripe-specific reconciliation endpoint retrieves independent provider state.
- The ETA uses straight-line distance, assumed 30 km/h speed and 120 seconds dispatch overhead. It does not use road routing, congestion, traffic or travel-time uncertainty.
- Strict-mode payment amounts are checked against immutable server-issued booking quotes. The trusted deployment policy `SERVICE_PRICES_JSON` provides category prices; missing policy fails closed. Only explicit unpriced local demo mode accepts arbitrary regression amounts. See [pricing review](review-pricing.md).
- Webhook retries stop after 20 failed processing attempts, retaining evidence for finance replay. Operators must alert on pending/dead webhook items and fix permanent payload errors.
- Availability is a snapshot, never a reservation. PostgreSQL exclusion constraints enforce the actual no-overlap guarantee when an offer is accepted.

## Real Stripe test-mode adapter

The optional Stripe adapter uses actual Stripe test-mode PaymentIntents and refunds. `STRIPE_SECRET_KEY` must begin with `sk_test_`; live keys and live webhook events are rejected. No raw card numbers are accepted. The authenticated `sandbox-confirm` endpoint uses Stripe's `pm_card_visa` test PaymentMethod.

Configure the API using secrets from your own Stripe test account:

```sh
export PAYMENT_GATEWAY=stripe_test
export STRIPE_SECRET_KEY=sk_test_REPLACE_FROM_YOUR_ACCOUNT
export STRIPE_WEBHOOK_SECRET=whsec_REPLACE_FROM_STRIPE_LISTEN
# Pass these variables into the API container or Kubernetes secret/config.
stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.amount_capturable_updated,refund.created,refund.updated --forward-to localhost:3001/webhooks/stripe
python3 scripts/stripe_sandbox_check.py
```

`POST /payments` first commits a local reservation, then creates the remote intent using the local payment UUID as the provider idempotency key. A crash or network timeout can be retried using the same booking and idempotency key. `POST /payments/:id/refunds` requires the finance role, a bounded positive `amountMinor` and an `Idempotency-Key`; the refund operation identity is persisted before calling Stripe. The API refuses an ambiguous operation older than 23 hours, before Stripe's documented minimum idempotency retention window expires, and requires manual reconciliation. Gateway calls are outside retried database transactions.

`POST /payments/:id/reconcile` requires finance and fetches the actual Stripe intent plus every page of refunds. It compares authoritative gateway totals and repairs missing capture/refund events using stable operation IDs. Normal signed delivery after recovery is a financial no-op. `POST /webhooks/stripe` validates the exact raw body, timestamp tolerance and any valid `v1` signature; successful `refund.created`/`refund.updated` events use the Stripe refund ID for deduplication.

When `PAYMENT_GATEWAY=stripe_test`, settlements require `STRIPE_CONNECT_DESTINATIONS`, a trusted JSON mapping from professional UUID to connected `acct_...` destination. Missing configuration fails before reserving funds. A settlement moves payable into a pending settlement account and persists status `submitted` before making a Stripe transfer; only a verified test transfer produces status `paid`, gateway ID `tr_...`, the final clearing ledger entries and `settlement.paid` event. Here paid means transferred to the connected Stripe balance, not paid to a bank account. Simulator and Stripe ledger accounts are isolated so simulated earnings cannot fund a Stripe transfer.

Validation achieved locally: adapter contract/security tests with mocked HTTP transport, signature tampering/expiry/live-event rejection, test-key enforcement, stable retry keys and paginated independent refund retrieval. Real Stripe account execution has **not** been claimed: it requires the user's test API and webhook credentials. The runnable `scripts/stripe_sandbox_check.py` performs a real test payment, confirmation, full refund, retry and independent reconciliation when credentials are supplied.

Official implementation references: [PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create), [test PaymentMethods](https://docs.stripe.com/testing), [webhook signature verification](https://docs.stripe.com/events/manage-webhook-endpoints#signature-errors), [idempotency retention](https://docs.stripe.com/api/idempotent_requests), and [refund creation](https://docs.stripe.com/api/refunds/create).

## Observed local integration result

On 2026-10-14, `scripts/booking_payment_integrity_check.py` passed all **12 scenario groups** against the rebuilt Docker stack. The [final integrity artifact](../benchmark-results/booking-payment-integrity-review.json) records audit tenant `55efd4a6-da0b-4409-b61b-344265f03561`, including offer expiration, reassignment, cross-actor idempotency, concurrent payment creation and settlement protection. API build/typecheck passed. The API suite passed **29 tests: 26 unit tests plus 3 PostgreSQL pricing integration tests**.

The [final Connect recovery artifact](../benchmark-results/stripe-transfer-recovery-review.json) passed all **6 checks** against the final running API image, using real PostgreSQL and a simulated Stripe transport. Audit tenant: `0a9ddd38-2c2a-4585-b43c-427e69f40433`; settlement: `8ef75886-feb5-4a57-97a5-a17287cb9568`. The simulated provider transfer was invoked exactly once despite a crash, recovery and repeated requests. No real Stripe account charge, Connect transfer or bank payout was attempted without credentials.

## Stripe Connect settlement recovery

```json
{"44444444-4444-4444-8444-444444444444":"acct_YOUR_TEST_CONNECTED_ACCOUNT"}
```

Set that JSON as `STRIPE_CONNECT_DESTINATIONS` through trusted server configuration. `POST /settlements` reserves the available Stripe-only professional balance, persists the destination snapshot, then uses the settlement UUID for Stripe's transfer idempotency key and transfer group. It first queries the provider by transfer group to recover an already delivered transfer. After validation of destination, amount, currency, test mode and reversal state, a second atomic ledger transaction releases the reservation to gateway clearing. The pending status is visible at finance-only `GET /settlements/:id`, including a retained recovery error.

A process crash after gateway delivery but before recording the response leaves a durable submitted settlement. Background recovery and same-key retries query the transfer group and finalize the existing transfer without sending it again. Unknown transfers older than 23 hours cannot create a new provider transfer; finance must inspect provider state and resolve the ambiguity manually. Multiple provider transfers or a reversed/mismatched transfer also stop automatic completion. Pending recovery retries are bounded to 20 attempts; explicit same-key operator retries remain available after fixing a transient provider failure. Funds remain reserved while unresolved, preventing new-key double payments.

Run the real PostgreSQL crash regression on the credential-free local stack:

```sh
docker compose exec -T api node < scripts/stripe_transfer_recovery_check.cjs
```

Only the external provider transport is simulated in this regression; ledger constraints, reservation, process reconstruction, same-key replay and duplicate-payout prevention use real PostgreSQL. Real Connect account execution requires a test connected account, funded test balance and test credentials, and has not been represented as completed without those resources. Provider references: [create a Connect transfer](https://docs.stripe.com/api/transfers/create), [recover transfers by transfer group](https://docs.stripe.com/api/transfers/list).

To extend the credentialed real Stripe test script to an actual Connect **test** transfer, configure the destination mapping and sufficient test balance, then run `RUN_STRIPE_CONNECT_TRANSFER=1 python3 scripts/stripe_sandbox_check.py`. The script checks transfer retry idempotency before refunding the customer test payment. A refund after the transfer correctly leaves a professional debit balance to offset against later earnings; it does not silently reverse an already delivered transfer. Bank payouts and automatic transfer reversals are separate workflows.

## Go runtime and dependency security

The Go allocation builder, module and CI version are pinned to Go 1.27.2, verified against [official Go release downloads](https://go.dev/dl/?mode=json). pgx was upgraded to 5.11.0; module tidy removed the obsolete crypto dependency. In the Go 1.27.2 container, `go test -race ./...`, `go vet ./...`, and `go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` all passed; govulncheck reported **No vulnerabilities found** on 2026-10-14. These are code/dependency checks, not a claim of a completed AWS deployment or an image registry scan.

Final local artifacts are [booking/payment integrity](../benchmark-results/booking-payment-integrity-review.json), [Connect crash recovery](../benchmark-results/stripe-transfer-recovery-review.json), and [Go security checks](../benchmark-results/go-security-review.json). The integrity artifact covers 12 checks, including real offer expiration and reassignment. The Connect artifact explicitly identifies its simulated external transport.
