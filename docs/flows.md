# Data flows

## Ingestion, retry and reporting

```mermaid
sequenceDiagram
  participant API as Transactional service
  participant DB as PostgreSQL
  participant O as Outbox publisher
  participant K as Kafka
  participant C as Reporting consumer
  API->>DB: transaction: business change + outbox row
  O->>DB: SELECT ... FOR UPDATE SKIP LOCKED
  O->>K: publish event (aggregate key)
  K-->>O: replicated acknowledgement
  O->>DB: mark published
  K->>C: at-least-once delivery
  C->>DB: transaction: inbox marker + metric delta
  alt transient handler failure
    C->>DB: persist attempt and available_at
    DB->>K: retry pump republishes when due
  else invalid/max attempts
    C->>DB: durable dead letter
    C->>K: diagnostic DLQ topic
  end
```

The potentially ambiguous crash window is after Kafka acknowledges and before `published_at` commits. That creates a duplicate, not a lost fact; the consumer inbox absorbs it.

## AI booking authority

```mermaid
stateDiagram-v2
  [*] --> Collecting
  Collecting --> Collecting: missing fields / clarify
  Collecting --> AwaitingConfirmation: typed availability tool succeeds
  AwaitingConfirmation --> AwaitingConfirmation: ambiguous reply
  AwaitingConfirmation --> Cancelled: user cancels
  AwaitingConfirmation --> Executing: exact explicit confirmation
  Executing --> Completed: backend transaction succeeds
  Executing --> Failed: timeout / response lost; outcome unknown
  Failed --> Executing: retry same immutable request and key
  Executing --> Collecting: definite backend rejection
```

The model cannot transition directly to `Completed`. It has no booking database credentials, and the idempotency key is derived server-side from the actor-bound conversation. Completed means the backend accepted the request; professional assignment remains a separate lifecycle. An interrupted executing checkpoint or a failed/uncertain response retains the immutable request and cannot be discarded by an edit or cancellation.

## Payment capture and replay

```mermaid
sequenceDiagram
  participant G as Gateway sandbox
  participant A as Payment API
  participant DB as PostgreSQL
  G->>A: signed captured event
  A->>A: constant-time signature check over raw bytes
  A->>DB: insert gateway/event ID
  alt duplicate ID
    DB-->>A: conflict
    A-->>G: success, duplicate=true
  else first delivery
    A->>DB: lock intent; post gateway debit + revenue/payable credits
    A->>DB: deferred balance constraint + state + outbox
    A-->>G: success
  end
```

## RAG update and query

```mermaid
flowchart LR
  Upload[PDF/text upload] --> Extract[bounded extraction]
  Extract --> Chunk[overlapping chunks]
  Chunk --> Version[immutable versioned chunks]
  Version --> Vector[(pgvector HNSW)]
  Query[question + identity] --> ACL[tenant + user/role ACL filter]
  ACL --> Vector
  Vector --> Rerank[vector + lexical rerank]
  Rerank --> Screen[neutralize document instructions]
  Screen --> Answer[grounded answer + citations]
  Delete[authorized hard delete] --> Remove[remove document + all versioned chunks + ACLs]
  Remove --> Vector
```
