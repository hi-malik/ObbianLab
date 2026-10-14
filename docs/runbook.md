# Local runbook and demonstration

## Prerequisites

- Docker Engine with Compose v2 and at least 6 GB available memory
- Node 22 and Python 3.12 only if running tests outside containers
- Loopback ports 3000, 3001, 8000, 8080, and 19092 available (PostgreSQL and Redis stay on the internal Compose network)

## Start

```bash
docker compose up --build -d --wait --wait-timeout 240
docker compose ps
python3 scripts/smoke.py
python3 scripts/concurrency_check.py
python3 scripts/pipeline_replay_check.py
python3 scripts/security_check.py
python3 scripts/web_auth_check.py
python3 scripts/booking_payment_integrity_check.py
```

Open `http://localhost:3000` for the assistant UI. The first build downloads base images and Python/npm modules. `migrate` and `seed` are one-shot containers; an exited status of zero is expected.

## Tests

```bash
npm ci
npm run typecheck
npm test

cd services/ai
python -m pip install -r requirements.txt
PYTHONPATH=. pytest -q

cd ../allocation
go test -race ./...
```

If Go is not installed, `docker build --target build -t obbian-allocation-test services/allocation` runs its tests in the builder.

## Failure drills

**API crash during booking creation.** Stop the API immediately after a client timeout and retry with the same idempotency key. It returns the stored response or completes the still-running transaction; it cannot create a second booking for that key.

**Allocator crash after claiming.** Kill `allocation` while requests exist. The database transaction rolls back. Another replica claims the row with `SKIP LOCKED`; expired offers are returned to allocation until the maximum attempt count.

**Consumer crash after database commit.** Restart `pipeline`. Kafka may redeliver the event, but the inbox primary key turns the handler into a no-op. `python3 scripts/pipeline_replay_check.py` deliberately republishes an already-processed event and compares inbox and aggregate counts.

**Duplicate payment event.** Run the smoke test or post the same signed `eventId` twice. The second response has `duplicate: true`; the ledger transaction count stays one.

**Database unavailable.** Readiness probes fail so traffic stops. Do not restart every pod in a loop. Confirm RDS failover/connection state, watch recovery lag, and allow pool backoff. Restore from a point-in-time backup into a new cluster if corruption—not availability—is the issue.

## Zero-downtime release

1. Ship backward-compatible schema additions with the migration job.
2. Wait for migration success; do not deploy on failure.
3. Roll services with `maxUnavailable: 0` and immutable image digests.
4. Run smoke checks and observe error rate, p95 latency, consumer lag and outbox age.
5. Roll back application images on regression. Destructive schema cleanup is a later release after all old code is gone.

## Recovery objectives

Proposed RPO is five minutes for PostgreSQL (continuous WAL/PITR) and near-zero for Kafka with multi-AZ replication; proposed RTO is 30 minutes for a regional data-plane failover exercise. These are design targets and require quarterly restore/failover tests before they become an SLA.

## Full review regression checks

`python3 scripts/database_tests.py` creates isolated scratch databases, applies all migrations, runs real PostgreSQL pipeline/pricing/AI tests and database-role isolation checks, then removes those databases. `python3 scripts/migration_check.py` tests failed-migration rollback, concurrent runners and checksum tampering. `python3 scripts/deploy_check.py` tests rendering and complete workload rollback without contacting AWS. `make verify` includes these checks after compilation/unit tests; it expects the Compose stack already running.

The default local profile uses demo identity and simulated payments. To test server prices locally, provide `SERVICE_PRICES_JSON` as described in [review-pricing.md](review-pricing.md); the broad simulator smoke test intentionally exercises arbitrary monetary values, so use it with an unpriced demo profile. Test Stripe with `scripts/stripe_sandbox_check.py` and your test credentials, not the simulator smoke script.

`AUTH_MODE=strict` requires signed tokens or trusted proxy credentials, server pricing, and configured hosted AI providers. The deployment renderer supplies strict mode and separates runtime database roles. The exact account/bootstrap/release path is in [aws-deployment.md](aws-deployment.md).

For migration 006 specifically, stop old reporting workers before applying the currency-key change and start the new worker afterward. This initial coordinated upgrade does not claim zero downtime for reporting; Kafka/outbox retain events. Never roll back to a pre-006 reporting image after that schema change.
