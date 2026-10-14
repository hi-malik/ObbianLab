# Server-owned payment pricing

The prior payment endpoint let a customer choose any positive amount and currency. This is now rejected outside the explicitly unpriced local demo.

The API deployment supplies `SERVICE_PRICES_JSON`, a trusted mapping of category slug to a flat price per booking in minor currency units. Example:

```json
{
  "electrician": { "amountMinor": 2500, "currency": "INR" },
  "plumber": { "amountMinor": 3000, "currency": "INR" },
  "cleaner": { "amountMinor": 2000, "currency": "INR" },
  "ride": { "amountMinor": 1500, "currency": "INR" }
}
```

This example is a policy illustration, not a recommended commercial tariff. Configure the actual assessment tariff before production deployment. Amounts must be positive safe integers and currency must be three letters. For a booking without a stored quote, a missing or malformed policy, or a category missing from a configured policy, rejects the operation with 503. The API never substitutes a customer amount for a missing strict-mode price.

`GET /payments/quote/:bookingId` requires the verified booking owner and tenant. It returns `{bookingId, category, amountMinor, currency, source:"server-policy", createdAt}`. The first quote is persisted in `booking_quotes` by migration 007. All quote creation locks the booking row, so concurrent requests create only one quote. Quotes are immutable, have no expiry in this assessment, and survive restarts or later policy changes. The stored hash records the category/amount/currency policy that produced the quote. Updating deployment prices affects only bookings without an existing quote.

`POST /payments` retains `amountMinor` and `currency` as the customer's acknowledgement of the quote. Before any gateway call or payment creation, the API checks those fields against the stored authoritative quote in the same database transaction. A mismatch returns 409. This prevents a customer from lowering the price or changing currency while preserving the existing payment/idempotency contract. The database additionally prevents quote mutation and rejects payment rows whose amount/currency differs from an existing quote.

Only `AUTH_MODE=demo` with **no** `SERVICE_PRICES_JSON` retains arbitrary customer amounts for the local financial simulator and its rounding/concurrency fixtures. In that mode the quote endpoint returns `source:"demo-client-amount"` with null amount/currency so no authoritative quotation is implied. Supplying a policy enables enforcement even in demo mode. An existing authoritative quote is always enforced, including if the configuration is subsequently removed in demo mode.

The quote policy is intentionally a flat fee for the whole booking: it does not calculate distance, duration, tax, surge pricing, discounts or multi-currency conversion. Every tenant in one API deployment uses the configured category policy. Those are explicit business-policy simplifications; customers cannot choose the authoritative payable amount.

Tests cover missing/malformed pricing, normalized currency, prototype-key rejection, tenant/owner isolation, amount and currency tampering, immutable policy changes, demo boundaries, concurrent PostgreSQL quote creation, database mutation guards, and payment insertion guards. The six unit tests run in the normal API suite. Three PostgreSQL tests additionally run with `TEST_DATABASE_URL` after migration 007, creating and cleaning up an isolated tenant.

Verified on 2026-10-14: **6/6 unit tests** and **3/3 PostgreSQL integration tests** passed. The SQL concurrency case issued 20 simultaneous quote requests and observed one stored quote. The API TypeScript check passed. Migration 007 was applied by the checksum-verifying advisory-lock migration runner.
