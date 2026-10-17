# Strict review: scenarios 3 and 4

Review date: 2026-10-14. The original implementation did **not** satisfy these scenarios safely. The repaired local deployment demonstrates the workflow and retrieval mechanics. Hosted LLM, semantic embeddings, and audio adapters are implemented and contract-tested, but no provider credential was supplied, so their live quality and latency remain unverified. The offline deployment must be described as a demonstration, not a production AI evaluation.

## Findings and repairs

| Severity | Original issue | Repair and verification |
|---|---|---|
| Critical | Shared bearer token plus caller-controlled `x-roles` allowed knowledge-admin escalation. | Role/tenant membership now comes from `app_users`. Signed HS256 identity tokens or a server-held service token authenticate the caller. Forged-role HTTP test returns 403. Production rejects the demo token. |
| High | Redis TTL/eviction erased conversation confirmation and recovery state; concurrent confirmations raced. | Migration 005 adds durable PostgreSQL conversation records. Session advisory locks serialize requests across replicas. State and audit writes reuse the lock-owning connection to prevent pool deadlock. Real PostgreSQL multi-instance concurrency test creates one booking. |
| High | Backend timeouts could commit a booking while the assistant falsely said “Nothing was booked.” | Persist `executing` before the call. Ambiguous failures explicitly report an unknown outcome and preserve immutable payload/idempotency key. `retry` recovers the same request. Cancellation and edits cannot discard an uncertain booking. |
| High | A proposal could be stale, user corrections were ignored, and a requested booking was labelled confirmed before allocation. | Five-minute confirmation expiry, availability recheck, correction/reproposal, separate literal confirmation, and “request accepted; professional assignment pending” response. |
| High | LLM JSON schemas were not strict-provider compatible; parsing failures could crash the workflow. | Recursive strict schema conversion, typed validation, recoverable extraction/availability errors, model-supplied category IDs ignored, and confirmation/cancellation authority kept outside the model. |
| High | RAG was exclusively hash embeddings and extractive text, with no real generation adapter. | Configurable 384-dimensional hosted semantic embeddings and a structured grounded-answer adapter. Each generated citation must contain an exact quote from an authorized retrieved source. Demo output labels itself `extractive-demo`. |
| High | Old dependency pins included PDF/multipart/Starlette vulnerabilities. | Updated FastAPI, Starlette, pypdf, multipart, pytest and pytest-asyncio; clean install and complete test suite verified. `pip-audit -r requirements.txt` now reports zero known vulnerabilities. |
| Medium | Raw PDF extraction ran on the event loop without resource isolation. | Disposable subprocess: 512 MiB address space, 10 CPU seconds, 15 seconds wall time; 20 MB upload, 500 pages and two million extracted characters. Valid PDF upload/extraction is covered by an HTTP integration test. |
| Medium | Retrieval threshold checked the unsorted candidate; irrelevant chunks were appended and citations lacked versions. | Sort first, threshold each result, filter demo lexical matches, include only used citations and active document version. Vector models are namespaced so changing providers never mixes incompatible vectors. |
| Medium | “Voice” meant only a supplied text transcript; no audio decoder existed. | `/agent/voice` uploads bounded audio to a configured transcription provider and runs the same identity-bound confirmation workflow. An unconfigured provider returns explicit 503. |
| Medium | No meaningful retrieval/security/recovery evaluation existed. | 43 tests including real PostgreSQL/pgvector cases, plus a reproducible five-document/six-query English/Hindi retrieval regression set. |

## Architecture and data flow

```mermaid
flowchart LR
    Text[Text / trusted transcript] --> Auth[Bearer auth + DB roles]
    Audio[Audio upload] --> ASR[Configured transcription provider]
    ASR --> Auth
    Auth --> Lock[PostgreSQL conversation lock]
    Lock --> Model[Typed intent extraction]
    Model --> Slots[Collect and validate slots]
    Slots --> Availability[Authorized category and availability APIs]
    Availability --> Proposal[Persist exact proposal]
    Proposal --> Confirm[Separate explicit confirmation]
    Confirm --> Executing[Durable executing state]
    Executing --> Booking[Booking API + stable idempotency key]
    Booking --> Outcome[Durable success or recoverable unknown outcome]
    Lock --> Audit[PostgreSQL audit events]
```

```mermaid
flowchart LR
    Upload[Admin text or isolated PDF parsing] --> Chunks[Overlapping chunks]
    Chunks --> Embed[Configured embeddings / labelled demo hash]
    Embed --> Version[Transactional document version + ACL + pgvector]
    Question[Question + verified identity] --> QueryVector[Query embedding]
    QueryVector --> Filter[Tenant + role/user ACL + active version + embedding model]
    Version --> Filter
    Filter --> Rerank[Vector and lexical reranking]
    Rerank --> Evidence[Authorized evidence only]
    Evidence --> Answer[Structured answer or demo extraction]
    Answer --> Check[Validate exact citation quotes or abstain]
```

The LLM extracts data and drafts grounded answers. It never receives credentials or a general-purpose action executor. Application code owns the allow-listed `resolve_category`, `check_availability`, and `create_booking` tools. Literal user confirmation is evaluated independently from model output. Retrieved document instructions cannot invoke any booking tool.

`ai_conversations` stores the original tenant/actor, slots, proposal time, stage and booking ID as JSONB. The normal migration runner applies this before the application rollout. Advisory locks release automatically when the process/connection dies. The `executing` checkpoint commits before a remote booking effect; recovery repeats the same backend idempotency key. Financial or booking state is never inferred from LLM text.

Document updates create a new version and ACL within one transaction; retrieval selects only the active version. Deletion physically removes the document, every version of its chunks, and ACLs through database cascades. A model change requires reingesting documents into that model's namespace before they become retrievable.

## API and configuration

FastAPI exposes the complete executable schema at `/openapi.json` and `/docs`.

| Endpoint | Input | Access / behavior |
|---|---|---|
| `POST /agent/messages` | JSON `message`, optional `conversation_id` | Bound to verified tenant/actor; returns stage, text, booking reference, required fields. |
| `POST /agent/voice-transcripts` | Same JSON | Explicit transcript boundary; same policy as text. |
| `POST /agent/voice` | Multipart `file`, optional `conversation_id` | WAV, MP3, M4A, WebM, Ogg; at most 10 MB; configured ASR required. |
| `POST /rag/documents` | JSON external key, title, text, allowed roles/users | DB-derived `knowledge_admin`; empty ACL defaults to ingesting user only. |
| `POST /rag/documents/pdf` | Multipart external key, title, allowed roles, PDF file | DB-derived `knowledge_admin`; isolated extraction and resource limits. |
| `DELETE /rag/documents/{external_key}` | External key | DB-derived `knowledge_admin`; tenant-scoped physical deletion. |
| `POST /rag/query` | JSON question, optional limit 1–10 | Only authorized active evidence; citations include document ID, title, version, chunk and excerpt. |

`AUTH_MODE=demo` explicitly enables local offline operation and `AI_DEMO_TOKEN`. The application otherwise fails startup without `AI_SERVICE_TOKEN`, `INTERNAL_SERVICE_TOKEN`, `LLM_API_KEY` and embedding credentials (embedding key may reuse the LLM key). The service token is for a trusted backend proxy; direct clients use a signed token with `sub`, `tenantId`, `exp`, optional `nbf`, and audience `obbian`, signed with `AUTH_SIGNING_SECRET` of at least 32 characters. Roles in client headers are always ignored. AI calls NestJS with `Authorization: Bearer INTERNAL_SERVICE_TOKEN`.

Provider settings use an OpenAI-compatible API origin **without** a `/v1` suffix:

- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`: Zara AI conversation, typed booking intent and grounded generation.
- `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`: embeddings with `dimensions=384`; default origin/key may reuse LLM settings.
- `ASR_BASE_URL`, `ASR_API_KEY`, `ASR_MODEL`: multipart audio transcription; default origin/key may reuse LLM settings.

Defaults are `https://api.openai.com`, `gpt-4o-mini`, `text-embedding-3-small`, and `whisper-1`. A provider must support the corresponding endpoints and strict JSON schemas; model availability depends on its account. Incompatible vectors, malformed outputs, invented source quotes, and upstream failures are rejected. API requests emit structured request ID, route template, status and duration logs without message bodies, identity tokens, audio, or document content.

## Verification and measured performance

The repaired service passed **43 tests**, including the real PostgreSQL tests, in **6.17 seconds** on the local Docker host. Tests cover functionality, simultaneous confirmations, state recovery across service objects, response-loss retry, availability races, actor/tenant isolation, forged roles, signed-token validation, unsupported audio, actual PDF extraction, prompt-induced action refusal, citation fabrication, document update/delete, embedding-model isolation, and Redis rate-limit enforcement/failure behavior.

Run unit tests with `cd services/ai && pytest -q`. To include SQL integration tests, first apply all migrations and set `TEST_DATABASE_URL` to the assessment database. Test tenants and rows are removed afterwards. A container example from the repository root:

```bash
docker run --rm --network obbian-assessment_default \
  -e TEST_DATABASE_URL=postgres://obbian:obbian@database:5432/obbian \
  -v "$PWD/services/ai:/work" -w /work obbian-assessment-ai \
  python -m pytest -q -p no:cacheprovider
```

The reproducible scripts and raw results are in `services/ai/benchmark.py`, `services/ai/evaluate.py`, and `services/ai/evaluation/`.

| Workload | Sample / mode | Observed local result |
|---|---|---|
| Agent response, new conversation and address clarification | 50 sequential live HTTP requests; five warmups excluded; real auth/state/audit SQL; deterministic demo intent | p50 **14.016 ms**, p95 **28.645 ms**, max **32.652 ms** |
| RAG retrieval | Five synthetic documents, six English/Hindi queries; pgvector, hash demo embeddings, lexical reranking | p50 **2.693 ms**, p95 **6.860 ms**; recall@3 **1.0**, MRR@3 **1.0**, zero ACL leaks, unrelated question abstained |

These are narrow functional regression measurements, not evidence of production LLM quality, audio accuracy, cloud latency, throughput at scale, or a large-corpus semantic retrieval benchmark. Hosted provider calls were tested with deterministic HTTP mocks; no live provider was available. Test-set size is deliberately visible rather than hidden behind a perfect metric.

Likely bottlenecks are provider latency/rate limits, PDF parsing CPU, ingestion embedding batches, the SQL pool while a conversation holds a lock, and approximate-vector recall under selective ACL filters. Bound concurrent provider work, run bulk ingestion as jobs, size pools using measured in-flight calls, cache only identity-safe read results, consider tenant-partitioned/vector-prefilter strategies, and evaluate recall over a representative authorized corpus before tuning HNSW and score thresholds. Retain old versions only according to an explicit data-retention policy; deletion already removes all versions.

## Remaining acceptance limitations

The subsequent free-cloud deployment profile adds `AI_PROVIDER_MODE=offline` independently of authentication. This explicitly selects deterministic models without paid provider keys while keeping strict identity, DB roles and Redis admission checks enabled. Strict service tokens must be at least 32 characters. Hosted mode remains the default for the AWS release; offline mode is labeled as a demonstration in the public UI.

1. Local intent extraction, embeddings and answers intentionally use offline demonstrations until provider secrets are configured. Real multilingual speech, semantic retrieval and generated-answer quality have not been demonstrated live.
2. The regex instruction scrubber is a supplemental guard, not proof that prompt injection is solved. Stronger boundaries are no action tools in the answer model, identity/ACL enforcement before generation, strict typed outputs, exact citation checks and backend-confirmed booking effects. Semantic support of every generated claim still needs a larger adversarial evaluation.
3. Scanned PDFs have no OCR path and are rejected if they contain no extractable text. PDF parsing is Linux-container isolated, not a general desktop subprocess implementation.
4. The retrieval set is synthetic and tiny; it does not qualify the system as an enterprise production RAG deployment. Production review still needs domain documents, ambiguity/negative/injection cases, role matrices, held-out queries and provider cost/latency measurements.
5. This review does not certify the AWS deployment, IAM, gateway sandbox, booking allocator, or financial pipeline; those are separate scenarios.

Dependency versions were checked against the publishers’ [FastAPI](https://pypi.org/project/fastapi/), [pypdf](https://pypi.org/project/pypdf/), and [python-multipart](https://pypi.org/project/python-multipart/) release metadata. The final requirements audit reported **“No known vulnerabilities found”** on 2026-10-14. This is a dependency advisory scan, not proof of absence of security defects.
