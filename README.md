# Obbian service platform assessment

Candidate: Himanshu Malik  
Role: Lead Fullstack Developer — AI System & Architecture

This repository implements the six assessment scenarios as one event-driven service platform. A strict review on 14 October 2026 found and repaired material authorization, accounting, retry, AI workflow and deployment defects. The corrected application is running and verified locally. **Full assessment acceptance remains pending AWS deployment and credentialed AI/audio/Stripe demonstrations.**

Start with the [strict assessment verdict](./docs/strict-review.md), [architecture](./docs/architecture.md) and [verification record](./docs/verification.md). Use the [runbook](./docs/runbook.md) for a demonstration and the [AWS deployment instructions](./docs/aws-deployment.md) for account setup and release.

An additional [Oracle Always Free deployment profile](./docs/oracle-free-deployment.md) runs the stack on one VM with strict sign-in and explicitly offline AI/simulated professionals and payments. It does not replace the assessment's AWS requirement.

**Live assessment demo:** https://obbianlab-161-118-169-229.sslip.io/ — requires an issued customer token. See the [deployment verification and operations record](./docs/live-deployment.md). The Oracle deployment passed 11 internal workflow checks and 9 public HTTPS checks on 14 October 2026. GitHub Actions could not start because the GitHub account reported a billing lock; this is not a passing CI run.

## Run it

```bash
npm ci
docker compose up --build -d --wait --wait-timeout 240
python3 scripts/smoke.py
python3 scripts/concurrency_check.py
python3 scripts/pipeline_replay_check.py
```

Then open `http://localhost:3000`. The one-shot `migrate`, `seed`, and `kafka-init` containers should exit with status zero. Detailed prerequisites, individual test commands, failure drills, and recovery notes are in the runbook.

PostgreSQL has PostGIS/pgvector and stores durable workflow state; Redpanda provides the Kafka API. Redis provides shared admission limits in strict mode. Compose explicitly selects loopback-only demo authentication, a signed payment simulator, offline English/Hindi intent parsing, hash embeddings and extractive answers. Hosted model/audio and Stripe test adapters require credentials. Never expose demo mode publicly.

## Scenario map

| Scenario | Primary implementation | Important proof |
| --- | --- | --- |
| 1. Booking/allocation | `apps/api`, `services/allocation` | offer lease, exclusion constraint, timeout/reassignment, WebSocket events |
| 2. Data pipeline | `services/pipeline` | inbox dedupe, partitioned work, bounded retry, DLQ, incremental rollups |
| 3. AI booking agent | `services/ai/app/workflow.py` | typed state machine, allow-listed tools, explicit confirmation, audit trail |
| 4. Enterprise RAG | `services/ai/app/rag.py` | versioned chunks, ACL filter before ranking, citations, injection screening |
| 5. Payments | `apps/api/src/payments` | webhook inbox, idempotency keys, immutable double-entry ledger, reconciliation |
| 6. Cloud/platform | `infra`, `.github/workflows` | least-privilege deployment shape, probes, autoscaling, migration job, rollback |

## Review map

- [Architecture and consistency boundaries](./docs/architecture.md)
- [Database relationships and invariants](./docs/data-model.md)
- [OpenAPI contract](./docs/openapi.yaml)
- [Threat model and local-only shortcuts](./docs/threat-model.md)
- [Performance method and bottlenecks](./docs/performance.md)
- [Recorded verification evidence](./docs/verification.md)
- [Assumptions and honest limitations](./docs/assumptions-and-limitations.md)
- [AWS, Kubernetes, rollout and recovery](./docs/runbook.md)
- [Architectural decisions](./docs/adr)

## Verification recorded on 14 October 2026

| Check | Result |
| --- | --- |
| TypeScript and optimized production build | All four workspaces pass |
| API / contracts / pipeline / web tests, including real database suites | 29 / 14 / 10 / 8 pass |
| Python workflow and RAG tests, including real database suites | 43 pass |
| Go race tests, vet and govulncheck | Pass; no known Go vulnerabilities |
| npm and Python dependency audits | No known vulnerabilities reported |
| Six application/migration runtime image scans | Zero fixable HIGH/CRITICAL findings |
| Full Compose smoke, booking concurrency and Kafka replay | Pass |
| Booking/payment regression and Connect crash recovery | 12 and 6 scenario groups pass; provider transport simulated |
| Database role permissions | 22 assertions pass |
| Local database restart | Services ready in 2.218 seconds; subsequent smoke/replay pass |

The [verification record](./docs/verification.md) includes exact scope and commands. The pipeline processed 12,000 mixed events at 173.42 records/second with exact totals and replay deduplication. This is a short local run, not a 24-hour or AWS capacity certification. AWS and credentialed provider checks remain explicitly pending.
