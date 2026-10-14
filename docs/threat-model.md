# Threat model and implemented controls

Assets include tenant documents, precise location, bookings, immutable financial ledgers, workflow authority and service credentials.

| Threat | Implemented control | Remaining boundary |
| --- | --- | --- |
| Caller role/tenant forgery | Signed expiring tokens or trusted proxy token; tenant membership and roles loaded from database | Operator-issued assessment credentials; no bundled OIDC/MFA or token revocation service |
| Browser CSRF / token theft | Exact configured Origin, HttpOnly/Secure/SameSite cookie, bounded streaming body reads | Deployment must configure the correct HTTPS PUBLIC_ORIGIN |
| Cross-actor idempotency disclosure | Actor-scoped booking idempotency plus ownership checks | Trusted proxy token is privileged and must be protected |
| Booking overlap / stale offers | Serializable retries, exclusion constraints, offer deadlines and locked reassignment | ETA uses distance/speed, not road traffic; GPS authenticity is not verified |
| Duplicate charges/refunds/payouts | Durable identities, business refund dedupe, immutable ledger and provider idempotency | Provider credentials and independent sandbox runs required; ambiguous old operations stop for reconciliation |
| Ledger corruption | Non-empty balanced postings; one tenant/currency; append-only guards | Privileged database administrators remain outside application trust boundary |
| AI action injection | Typed allow-listed tools, server identity, explicit confirmation, durable exact request before execution | Hosted model behavior needs deployment-specific evaluations |
| RAG data leakage / injection | Database tenant/ACL filtering before ranking, encoder version binding, untrusted-context handling and citation validation | Small synthetic local evaluation does not establish corpus-wide factuality |
| Hostile PDFs / oversized bodies | Disposable resource-limited PDF subprocess, page/text/byte limits; HTTP streaming byte limits | No antivirus/OCR system; resource limits reduce but do not eliminate parser risk |
| Event loss / replay / poison records | Transactional outbox/inbox, payload identity, retry schedule, durable DLQ and operator replay | Retention must cover the supported replay window; missing-source events need recovery |
| Credential exposure / lateral access | Per-service AWS Secrets Manager material, least-privilege database roles, private dependencies, TLS and network policies | Local Compose deliberately shares one demo database owner; deploy IAM/controller bootstrap still requires operator credentials |
| Supply chain | Lockfiles, dependency audit, supported Go build, CI image vulnerability scans | No claim that a configured CI job has run remotely until Actions succeeds |

Compose binds application and broker ports to loopback and enables `AUTH_MODE=demo` explicitly. Do not publish that profile. The AWS renderer forces strict auth and Stripe test mode and requires complete provider configuration. Secrets are never committed or printed by deployment scripts. Exact rollout, TLS, database provisioning and recovery prerequisites are documented in [aws-deployment.md](aws-deployment.md).
