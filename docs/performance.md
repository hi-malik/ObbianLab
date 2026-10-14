# Performance evidence and optimization plan

Measured 14 October 2026 on an x86_64 Linux host with 8 logical CPUs and approximately 7.4 GiB RAM, using local Docker, PostgreSQL and one Redpanda broker. Workloads were short and synthetic. Concurrent build/scan activity can affect latency; no result is an AWS sizing or production SLA claim.

## Measured workloads

| Scenario | Workload | Observed result | Evidence and scope |
| --- | --- | --- | --- |
| 1. Availability | 500 authenticated HTTP requests, concurrency 25, small seeded professional dataset | 500 successes, zero errors; 199.67 requests/s; p50 106.94 ms, p95 167.71 ms, p99 569.45 ms | [Raw result](../benchmark-results/availability-local.json); PostGIS radius and overlap query, not large-fleet or road-routing performance |
| 2. Pipeline | 12,000 mixed facts through PostgreSQL outbox → Kafka 12 partitions → PostgreSQL, concurrency 8; then 1,200 duplicates | 69.197 s; 173.42 records/s; exact totals, zero double counting and zero DLQ | [Raw result](../benchmarks/results/pipeline-latest.json); actual broker/database, short synthetic run |
| 3. Assistant | 50 sequential new-conversation clarification requests after five warmups | p50 14.016 ms, p95 28.645 ms | [Raw result](../services/ai/evaluation/agent-benchmark.json); live auth/state/audit SQL, offline parser, no ASR/LLM or booking creation |
| 4. Retrieval | Five synthetic documents, six English/Hindi queries | Recall@3 1.0, MRR@3 1.0, zero ACL leaks; p50 2.693 ms, p95 6.860 ms | [Raw result](../services/ai/evaluation/retrieval-results.json); hash embeddings/lexical reranking, tiny regression set |
| 5. Payments | 100 payments, 300 HTTP calls, concurrency 10; capture then duplicate webhook | 5.766 s total; 17.34 payments/s; intent p95 320.03 ms, capture p95 933.32 ms, duplicate p95 46.66 ms; 100 balanced captures | [Raw result](../benchmarks/results/payments-latest.json); simulated gateway, preseeded confirmed bookings/quotes, real shared-account contention |
| 6. Recovery | Restart PostgreSQL, then full smoke/replay | 2.218 s to all readiness; zero unbalanced transactions | [Raw result](../benchmark-results/recovery-local.json); local recovery, no AWS failover/restore measurement |

Two million records/day averages **23.15 records/s**. The pipeline result is approximately **7.49 times** that average. Multiplying the measured rate by a day gives about 14.98 million records, but that is an extrapolation, not an executed daily-volume soak. A proposed 20× burst target (~463 records/s) remains unproven.

## Reproduction

Start and migrate the local stack, then run `python3 scripts/smoke.py`. Workloads create synthetic fixtures; use an assessment/test environment.

```sh
python3 benchmarks/http_load.py --requests 500 --concurrency 25 --output benchmark-results/availability-local.json
python3 benchmarks/payments_load.py
```

For AI measurements, install services/ai/requirements.txt, set DATABASE_URL to a reachable migrated test database, AI_BENCH_URL to the running demo AI service, and AI_DEMO_TOKEN to its configured token, then run `python3 services/ai/benchmark.py` or `python3 services/ai/evaluate.py`. From Compose these scripts can run inside the AI container with the service database environment; mount the scripts/output directory first.

For the pipeline, build contracts and pipeline first, set `PIPELINE_BENCHMARK_DATABASE_URL` to a separate migrated scratch database whose name contains `test`, `review` or `benchmark`, and `KAFKA_BROKERS` to the reachable broker. Run `node benchmarks/pipeline_load.mjs`. It provisions unique temporary topics and checks exact aggregates before/after replay. See [pipeline review](review-pipeline.md) for setup. Do not repoint a load test at a live customer environment.

## Bottlenecks and next measurements

| Signal | Likely bottleneck | Optimization to validate |
| --- | --- | --- |
| Availability p95 rises with fleet size | Radius scans, stale presence and schedule queries | Realistic cardinalities, GiST plans/statistics and service-area partitioning |
| Booking acceptance lock waits | Hot professional exclusion index | Short transactions and independent service-area partitions, preserving exclusion guarantees |
| Old unpublished outbox rows | Publisher batches/database round trips | Larger batches and more publishers with SKIP LOCKED; measure broker acknowledgements |
| Reporting lag/hot rollups | Tenant/day contention and uneven partitions | Per-partition deltas or batched upserts, preserving event dedupe |
| Payment capture p95 | Shared clearing/commission account locks | Keep remote calls outside transactions; measure lock waits before partitioning accounts |
| Slow AI or occupied pools | Provider latency and conversation lock duration | Bound provider concurrency, timeouts and pool budgets; measure real provider latency/cost |
| RAG recall falls under ACLs | Approximate search/filter selectivity | Held-out corpus evaluation, tenant partitions/HNSW tuning based on recall |
| Slow document ingestion | PDF CPU and embedding requests | Queued bulk ingestion, batched embeddings, bounded worker memory/CPU |
| Recovery exceeds objectives | Reconnect/backoff, pod/node scheduling, restore time | AWS pod/AZ/backup drills recording actual error windows, RTO and RPO |

Use `EXPLAIN (ANALYZE, BUFFERS, WAL)` on representative candidate queries, schedule checks, aggregate upserts, ledger balances and ACL-filtered retrieval. Capture consumer lag, oldest outbox age, retained dead letters, lock waits, CPU/memory and provider errors during a 24-hour soak and burst/replay run before selecting production capacity.
