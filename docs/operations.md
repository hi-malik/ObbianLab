# Observability and production operations

## Signals

API and AI HTTP logs use structured records with generated request identifiers and route templates; allocation uses structured slog and Kafka uses structured client logs. Request bodies and credentials are omitted. In EKS, a node-level OpenTelemetry/Fluent Bit collector sends logs to CloudWatch Logs and metrics/traces to the chosen managed backend. Logs are transport, not the alerting model.

Service-level objectives proposed for an initial production baseline:

| Journey | SLI | Initial objective |
| --- | --- | --- |
| create booking | valid requests completing without 5xx | 99.9% over 28 days |
| offer allocation | requested to first offer | 95% under 3 s when eligible supply exists |
| payment webhook | valid first delivery durably processed | 99.99% under 2 s |
| reporting | Kafka consumer lag age | 99% under 5 min |
| RAG | authorized query returning or safely declining | 99.5% under 4 s excluding model-provider outage |

Page on symptoms: sustained error-budget burn, oldest outbox age, consumer lag age, DLQ growth, allocation queue age, unbalanced-ledger assertion failures, RDS capacity/lock waits, and payment reconciliation mismatch. CPU is a diagnostic signal, not a customer-impact page by itself.

## Dashboards

- booking rate by state and service area; allocation attempts and offer expiry ratio;
- PostGIS candidate query p50/p95/p99, rows examined, database locks and pool saturation;
- outbox age/count, Kafka ingress/egress, partition skew and consumer lag;
- payment event age, duplicates, illegal transitions, ledger postings and reconciliation delta;
- AI workflow stage/failure reason/tool latency, with request text excluded from default logs;
- RAG retrieval latency, grounded-decline rate, citation coverage and ACL denial rate.

## Reconciliation

The local `GET /payments/reconciliation/report` endpoint performs the read-only comparison against the signed sandbox webhook inbox, payment state and ledger posting counts. The finance-only Stripe reconciliation endpoint retrieves independent PaymentIntent/refund state; operational scheduling and bank settlement reports remain deployment-specific. Differences become cases; reconciliation never "fixes" money automatically. A correction is a new compensating transaction with an operator identity and source evidence.

## Retention

Location samples have the shortest retention and are downsampled/deleted according to consent and legal policy. Inbox/outbox rows move to compressed archive partitions after their replay window. Ledger and AI action audit retention is policy-driven and immutable where required. RAG deletion removes the document from retrieval immediately; physical chunk removal is an asynchronous, auditable retention task.
