# ADR 0002: At-least-once delivery with idempotent effects

Status: accepted

## Decision

Publish domain events through a transactional outbox and process them with an inbox table keyed by `(consumer_name, event_id)`. Commit the business effect and inbox marker together; commit the Kafka offset afterwards.

## Why

"Exactly once" at the broker does not cover PostgreSQL or payment gateway side effects. Explicit idempotency survives consumer restarts, replays, and changes in broker configuration.

## Consequences

Inbox and outbox tables require retention jobs and operational metrics. Event handlers must be deterministic and event schemas must remain backward compatible within a major version.
