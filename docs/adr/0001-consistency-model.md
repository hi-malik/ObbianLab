# ADR 0001: PostgreSQL as the consistency boundary

Status: accepted

## Decision

Use PostgreSQL constraints and transactions for booking ownership, professional scheduling, idempotency records, payment state, and ledger entries. Redis locks may reduce contention but are never required for correctness.

## Why

A Redis lease can expire while its holder is paused, and a Kafka message can be redelivered. Keeping invariants in the same transactional store makes the failure behavior inspectable and testable. PostGIS also lets candidate eligibility and distance ordering happen without copying location data into a second geospatial index for this workload.

## Consequences

Hot professionals and accounts can become row-lock hotspots. Candidate selection is kept short, uses `SKIP LOCKED`, and is horizontally partitionable by service area. If measured demand outgrows a regional PostgreSQL writer, the boundary can be split by non-overlapping city/tenant shards without changing event semantics.
