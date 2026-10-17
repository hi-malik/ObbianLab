# ObbianLab

A service booking platform for rides and home services. Customers can request a professional through the booking API or chat interface. The backend handles nearby professional allocation, booking confirmation, payments, and event processing. A document search service provides answers with source citations.

**[Live demo](https://obbianlab-161-118-169-229.sslip.io/)** — sign in with an issued customer access token.

## Project structure

| Directory | Purpose |
| --- | --- |
| `apps/web` | Next.js interface for booking and document search |
| `apps/api` | NestJS APIs for bookings, tracking, pricing, payments, and settlements |
| `services/allocation` | Go worker for geospatial matching, offers, timeouts, and reassignment |
| `services/pipeline` | Kafka event processing, deduplication, retries, dead letters, and reporting |
| `services/ai` | FastAPI service for booking conversations and document retrieval |
| `packages/contracts` | Shared TypeScript schemas and event contracts |
| `db` | PostgreSQL migrations, seed data, and runtime permissions |
| `infra` | Docker, Oracle, AWS Terraform, and Kubernetes configuration |
| `scripts` | Setup, integration checks, and deployment utilities |

PostgreSQL stores bookings, workflow state, and financial ledgers. PostGIS supports location queries, and pgvector stores document embeddings. Redis handles shared request limits. Redpanda provides the Kafka-compatible event broker.

## Local setup

Install Docker with Compose and allow at least 6 GB of memory for the local stack.

```bash
git clone https://github.com/hi-malik/ObbianLab.git
cd ObbianLab
docker compose up --build -d --wait --wait-timeout 240
```

Open [localhost:3000](http://localhost:3000). The first build can take a few minutes. The `migrate`, `seed`, and `kafka-init` containers run once and should exit with code 0.

The default local configuration uses demo authentication, offline English/Hindi parsing, and simulated payments. Application ports bind to localhost; do not expose this configuration publicly. See [.env.example](.env.example) for provider settings.

## Zara AI chat

With hosted AI enabled and `LLM_API_KEY` configured on the AI service, Zara AI uses `LLM_MODEL` (default `gpt-4o-mini`) to answer general questions and handle service requests naturally. Greetings and unsupported services no longer force the booking form. English is the default; an explicit English, Hindi or Hinglish preference persists within the conversation. API keys stay on the server.

Conversation context is stored with the authenticated actor and tenant in PostgreSQL. The model receives up to 20 recent messages, capped at 24,000 characters; older context is dropped. **New chat** starts a fresh conversation. There is no one- or two-question limit, but application request limits, API quota and provider availability still apply. Zara has no web browsing or live-news access. General chat is model-generated and can be wrong; the separate **Knowledge Library** returns document-grounded answers with validated citations.

Bookings still use backend category and availability checks and require a separate explicit confirmation. General questions cannot change booking details. The deterministic **Booking update** card records backend results independently of generated prose. Confirmation and recovery work even when chat generation is unavailable; an uncertain booking outcome must be recovered with `retry` before starting another request. Only electrician, plumber, cleaner and ride are supported booking categories. Offline mode retains the limited booking parser.

## Tests

For TypeScript checks, install Node.js 22 or later:

```bash
npm ci
npm run typecheck
npm test
```

With the Docker stack running and Python 3.12 installed:

```bash
python3 scripts/smoke.py
python3 scripts/concurrency_check.py
python3 scripts/pipeline_replay_check.py
python3 scripts/security_check.py
```

The [runbook](docs/runbook.md) covers Python and Go tests, database checks, and failure recovery. Recorded results and benchmark scope are in [verification](docs/verification.md) and [performance](docs/performance.md).

## Deployment

The live demo runs on an Oracle Always Free VM with signed-token authentication and HTTPS. Database and backend service ports are private. See the [Oracle setup guide](docs/oracle-free-deployment.md) and [deployment record](docs/live-deployment.md) for configuration, access-token renewal, and verification results.

The hosted demo uses offline AI, synthetic professional locations, and simulated payments. Voice transcription is not configured. The 1 GB VM is intended for light demo traffic, not production load.

[AWS deployment instructions](docs/aws-deployment.md), Terraform, and Kubernetes manifests are included, but the AWS deployment has not been verified. Hosted LLM, voice, and Stripe test-account integrations also require credentials and separate validation. GitHub Actions is currently blocked by an account billing issue; completed checks are documented separately.

## Documentation

- [Architecture](docs/architecture.md)
- [Database model](docs/data-model.md)
- [API specification](docs/openapi.yaml)
- [Security model](docs/threat-model.md)
- [Technical decisions](docs/adr)
- [Assumptions and limitations](docs/assumptions-and-limitations.md)
