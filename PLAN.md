# Delivery plan

This repository is intentionally one system rather than six unrelated samples. A booking created in scenario 1 can flow through the scenario 2 event pipeline, be initiated by the scenario 3 assistant, use scenario 4 for support knowledge, create scenario 5 ledger entries, and run on the scenario 6 platform.

## Ground rules

- Correctness before throughput: booking ownership and money movement use database constraints and transactions, not Redis locks as the source of truth.
- At-least-once delivery is assumed. Consumers are idempotent and all externally visible events use a transactional outbox.
- The AI service proposes and invokes narrowly scoped tools; it never writes directly to business tables.
- Local development uses Docker Compose. AWS manifests are deployable examples, but the repository does not claim an AWS deployment was performed.
- Payments and intent/retrieval have explicit offline demo modes. Real Stripe test, hosted LLM/embedding/generation and audio transcription adapters require credentials; no audio transcription is fabricated.

## Milestones and acceptance checks

| Milestone | Deliverable | Acceptance check |
| --- | --- | --- |
| 0. Foundation | contracts, schema, ADRs, diagrams | migrations apply to a clean database |
| 1. Booking | NestJS API + Go allocator | concurrent offers cannot confirm the same professional twice |
| 2. Pipeline | Kafka producer/consumer + reporting | replaying an event does not alter aggregates twice; poison events reach DLQ |
| 3. AI | FastAPI workflow + auditable tools | booking requires explicit confirmation and backend validation |
| 4. RAG | ingestion, retrieval, citations, ACL | deleted/restricted chunks are not retrieved |
| 5. Payments | ledger, webhook inbox, refund/settlement state machine | duplicate webhook and retry tests preserve balanced entries |
| 6. Platform | web demo, Compose, Kubernetes/Terraform, CI | build, tests, health checks, migration job, rollback notes |
| 7. Evidence | benchmark scripts and report | commands, hardware/context, p50/p95/p99, bottlenecks recorded |

## Planned repository shape

```text
apps/api/              NestJS booking, payment and internal tool APIs
apps/web/              Next.js customer/operator demo
services/allocation/   Go geospatial candidate scoring and offer leases
services/pipeline/     Node/Kafka ingestion and incremental aggregation
services/ai/           FastAPI agent workflow and RAG service
packages/contracts/    versioned TypeScript event and API contracts
db/migrations/         PostgreSQL/PostGIS/pgvector schema
infra/                 Docker Compose, Kubernetes and Terraform
docs/                  architecture, threat model, runbooks and ADRs
benchmarks/             reproducible load generators and captured results
```

## Demonstration script

1. Start dependencies and services with `docker compose up --build`.
2. Seed professionals and submit a booking.
3. Observe an offer, accept it, and stream a location update.
4. Replay the booking event and show unchanged aggregates.
5. Ask the assistant for an electrician; confirm the proposed booking.
6. Ingest a support document, query it, then revoke access and query again.
7. Send the same payment webhook twice and inspect the balanced ledger.
8. Run unit, integration, concurrency, security, and smoke tests.

## Scope decisions and current status

The implementation demonstrates business invariants in executable code. Audio transcription, hosted structured intent, embeddings and generation, and Stripe test payments/refunds/Connect transfers have real configurable adapters with local contract tests. Their live execution remains pending credentials. Terraform, Kubernetes and the release workflow are locally validated; AWS has not been provisioned. See [the strict review](docs/strict-review.md) for the current verdict, measured evidence and outstanding acceptance requirements.
