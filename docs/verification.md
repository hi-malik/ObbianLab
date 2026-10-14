# Verification record — 14 October 2026

These results were observed locally after the strict review fixes. CI is configured to repeat them, but no successful remote workflow run or AWS deployment is claimed. See [strict-review.md](strict-review.md) for the verdict and [performance.md](performance.md) for benchmark scope.

## Functional and security checks

| Check | Reproduction | Observed result |
| --- | --- | --- |
| TypeScript and optimized build | `npm run typecheck`; `npm run build` | All four workspaces pass; contracts build before dependents |
| Node unit suites | `npm test` | API 26, web 8, pipeline 2, contracts 14 pass; DB-dependent tests skip without a test URL |
| Real database suites | `python3 scripts/database_tests.py` | API 29 (including 3 quote-concurrency tests), pipeline 8 DB tests plus its 2 unit tests, AI 43 tests; 20 service-role permission assertions |
| Go allocation | `go test -race ./...`; `go vet ./...`; `go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...` in Go 1.27.2 | Pass; no vulnerabilities found; [artifact](../benchmark-results/go-security-review.json) |
| Dependencies | `npm audit --audit-level=high`; `pip-audit -r services/ai/requirements.txt` | No known vulnerabilities reported |
| Runtime images | Trivy `--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed` | Six application/migration images have zero findings in that scope; [image IDs and summary](../benchmark-results/security-summary.json) |
| Compose | `docker compose config -q` | Valid; local service ports bind loopback |
| Complete workflow | `python3 scripts/smoke.py` | Presence, allocation, acceptance, tracking, capture/refund/reconcile, settlement replay, AI confirmation, cancellation, RAG lifecycle/ACL pass |
| Booking concurrency | `python3 scripts/concurrency_check.py` | Concurrent acceptance produces one winner and one 409 conflict |
| Pipeline replay | `python3 scripts/pipeline_replay_check.py` | Processed inbox record and aggregate counted once |
| Authorization | `python3 scripts/security_check.py` | Seven negative security checks pass |
| Strict web boundary | `python3 scripts/web_auth_check.py` | No anonymous booking proxy; origin checks, expiry/tamper rejection, secure HttpOnly cookies and authenticated proxy pass |
| Booking/financial integrity | `python3 scripts/booking_payment_integrity_check.py` | 12 scenario groups pass; [artifact](../benchmark-results/booking-payment-integrity-review.json) |
| Connect response-loss recovery | `docker compose exec -T api node < scripts/stripe_transfer_recovery_check.cjs` | Six groups pass against real PostgreSQL with mocked Stripe transport; one remote transfer call despite recovery; [artifact](../benchmark-results/stripe-transfer-recovery-review.json) |
| Migration safety | `python3 scripts/migration_check.py` | Failure rolls back schema and record; concurrent runners apply once; checksum tampering rejected |
| Deployment renderer/recovery | `python3 scripts/deploy_check.py` | Four tests pass with mocked AWS/Kubernetes, including immutable release configuration, public readiness retries and full Deployment rollback |
| Terraform | `terraform fmt -check -recursive`; `terraform init -backend=false`; `terraform validate` | Valid locally; no apply performed |
| Kubernetes schemas | kubeconform 0.6.7, strict mode | 33 resources valid, zero invalid/errors/skipped |

Database suites create disposable databases, apply real migrations, exercise PostgreSQL/PostGIS/pgvector, then remove those databases. Permission fixtures use uniquely named review roles. Other integration/benchmark scripts retain isolated synthetic tenants as audit evidence. They do not erase existing application data.

## Browser verification

The final Next.js interface was exercised through a browser: a complete electrician request produced a proposal, literal `confirm` returned a backend booking reference with assignment explicitly pending, and a knowledge question returned an answer with document title, version and passage citation. The unattended test offer subsequently expired to the expected unfulfilled terminal state. Audio is visibly marked as requiring transcription configuration; no real ASR run is claimed.

## Recovery and invariants

`python3 scripts/recovery_check.py` restarted the local database while the application was running. API, allocation, AI and pipeline readiness recovered in **2.218 seconds**; a fresh complete smoke test and Kafka replay passed, with **zero unbalanced ledger transactions**. [Raw evidence](../benchmark-results/recovery-local.json). This is local dependency recovery, not multi-AZ failover or backup-restore RTO/RPO.

Seven checksummed migrations are applied. Financial regressions exercise concurrent intent/capture/settlement requests, fragmented refunds, delayed events, duplicate business facts, ledger ownership/currency constraints and recovery after losing a remote transfer response. Pipeline tests cover malformed records, deduplication conflicts, transient dependencies, bounded retries, dead letters and replay.

## Account-dependent evidence still required

- Execute remote CI and AWS release using the intended account, region, certificate and hostname.
- Demonstrate hosted multilingual intent, actual audio transcription, semantic embeddings and grounded generation on representative documents and held-out queries.
- Execute Stripe test payment, refund, independent provider reconciliation and Connect test transfer with actual test credentials and connected account.
- Record rollout under traffic, rollback, pod/service failure, dependency recovery, alert delivery and database backup restore in AWS.
- Run sustained and burst workloads at production cardinality; the short pipeline benchmark does not prove 24-hour durability or peak cloud capacity.

Migration 006 requires a coordinated initial reporting-worker restart. The pre-review worker is incompatible with its currency-aware reporting key; rollback across that schema boundary is not claimed as zero downtime. Subsequent releases must preserve expand/contract compatibility.
