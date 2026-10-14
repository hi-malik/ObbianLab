# Strict assessment review — 14 October 2026

## Verdict

**The original submission was not correct or complete enough to pass all six scenarios.** It had useful working foundations but exposed identity/role spoofing, duplicate-payment and settlement risks, lossy retry behavior, non-durable AI confirmation state, demo-only model behavior and incomplete cloud deployment wiring. These were material defects.

The review repaired the identified implementation defects, rebuilt the local application and exercised functionality, authorization, concurrency, recovery and accounting invariants. The application runs at `http://localhost:3000` while Docker is running. **The entire assessment is not complete yet:** AWS deployment, credentialed AI/audio/Stripe demonstrations and cloud resilience evidence remain outstanding. The user explicitly deferred selecting the AWS target until audit/fixes were finished.

## Requirement-by-requirement result

| Scenario | Implemented and verified locally | Strict remaining qualification |
| --- | --- | --- |
| 1. Booking/allocation | PostGIS category/radius/freshness/availability/ETA filtering; Go ranking and timeout/reassignment; acceptance/rejection/lifecycle; database exclusion against overlapping assignments; signed WebSocket tracking/reconnect snapshots | ETA is a straight-line approximation. Device GPS authenticity, road routing and traffic are excluded. Notifications require durable-state reload after reconnect. |
| 2. Data pipeline | Validated contracts; durable outbox/inbox; payload-conflict detection; partition concurrency; exact integer/currency reporting; retry/DLQ/replay; 12,000 real broker/database events plus 1,200 duplicates with exact totals | 173.42 records/s exceeds the 2M/day average in a short local run. A 24-hour workload, production cardinality, 20× bursts and AWS capacity remain unverified. |
| 3. AI workflow | Durable multi-step state/locks; explicit confirmation; typed allow-listed tools; backend authorization; stable retry after unknown outcomes; audits; hosted structured-intent/audio adapters; English/Hindi offline demonstration | No live model/audio credentials supplied. Real multilingual voice accuracy, provider failures and latency require credentialed demonstration. Parser results are not LLM quality evidence. |
| 4. Enterprise RAG | Text/PDF ingestion with resource limits; versions/deletion; role/user/tenant ACLs; encoder isolation; retrieval/reranking; exact citations; grounded generation adapter; adversarial/real database tests | Hosted embeddings/generation not executed. Six synthetic queries are regression coverage, not enterprise evaluation. Scanned PDF OCR is absent; injection defenses do not prove semantic correctness of every answer. |
| 5. Payments | Immutable server quotes; one intent per booking; durable signed-webhook inbox; exact cumulative refunds; double-entry tenant/currency guards; reconciliation/replay; pending settlement reservation/crash recovery; real Stripe TEST adapters | Actual Stripe test payment/refund/reconciliation/Connect transfer require credentials/account. Local transport is simulated. Connect paid means transfer to connected balance, not bank payout. Disputes/automatic transfer reversals are excluded. |
| 6. AWS/platform | Docker builds; atomic migrations; Terraform/K8s validation; workload identities, scoped DB roles, verified TLS, network policies, secrets, scans, logging/metrics, HPA/node autoscaling; immutable rollout/full-spec rollback tooling | **Not deployed to AWS.** No remote CI, under-traffic zero-downtime rollout, AWS rollback/failover or backup restore evidence. Migration 006 needs coordinated initial worker restart; the old image cannot roll back across its schema change. |

## Material repairs

1. Replaced caller-controlled identity/roles with signed expiring identities and database membership in strict mode. Closed web origin/body-size bypasses and protected finance/admin actions. Demo shortcuts are explicit and loopback only.
2. Added immutable server-owned prices; fixed concurrent payment creation, refund rounding, delayed webhooks, settlement double payment and ledger ownership/currency enforcement.
3. Made AI conversations durable and serialized across instances. Preserved exact payload/idempotency keys after ambiguous outcomes and removed false professional-confirmation claims.
4. Corrected pipeline loss/double-counting paths, malformed-record retention, retry identity and currency reporting. Added MSK IAM/topic initialization.
5. Added hosted provider adapters and strengthened RAG ACL/citation/PDF handling, explicitly recording which paths use mocks/offline demonstrations.
6. Repaired deployment prerequisites and rollback: separate database roles, checksummed atomic migrations/grants, verified RDS TLS, immutable secrets/configuration, traffic probes, ingress, workload IAM and autoscaling. Updated vulnerable dependencies/runtime images.

Detailed findings and decisions: [booking/payments](review-booking-payments.md), [pricing](review-pricing.md), [AI/RAG](review-ai-rag.md), [pipeline](review-pipeline.md), [architecture and flows](architecture.md), [data model](data-model.md), [ADRs](adr), [threat model](threat-model.md).

## Submission artifacts and evidence

- Source under apps/services/packages/db/infra/scripts; Docker and Compose configuration supplied.
- [API specification](openapi.yaml), [AI schema](ai-openapi.json), architecture/data-flow diagrams, schemas/migrations and technical decisions included.
- [Verification](verification.md): 29 API, 14 contract, 10 pipeline, 8 web and 43 AI tests; Go race/vet/security; 20 DB-permission assertions; executable integration/recovery checks. Unit tests repeated in database runs are not counted twice.
- [Performance](performance.md): measured allocation, pipeline, AI, RAG, payment and local recovery workloads, bottlenecks and optimization strategy.
- [Runbook](runbook.md), [AWS instructions](aws-deployment.md) and [limitations](assumptions-and-limitations.md) separate runnable instructions from missing evidence.

## Final acceptance path

Supply the intended AWS profile/account, region, hostname/certificate and Git repository, then execute the prepared release workflow. Configure provider secrets locally or in Secrets Manager, never chat/Git. Complete provider-backed workflows and cloud rollout/rollback/recovery drills, retain outputs and update this verdict. Until then the accurate status is **local implementation repaired and verified; full assessment acceptance pending external deployment and provider evidence**.
