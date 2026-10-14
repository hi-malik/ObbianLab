# Oracle Always Free assessment demo

This profile runs the complete Docker stack on one Ubuntu 24.04 ARM VM. Use only Always Free eligible A1 capacity within the account's displayed allowance: 2 OCPUs, 12 GB RAM and a 100 GB balanced boot disk, with total tenancy disk usage below the 200 GB free allowance. Availability is not guaranteed. No paid upgrade, managed database, NAT gateway or Kubernetes cluster is required.

This is an authenticated assessment demo with **offline English/Hindi parsing, hash-vector retrieval, a synthetic professional GPS heartbeat and simulated payments**. It is not the AWS deployment required by scenario 6. Actual voice/hosted LLM/Stripe evidence remains separate. The public interface labels its offline demo status.

### Capacity fallback: E2 Micro

If A1 is unavailable, the Always Free `VM.Standard.E2.1.Micro` with Ubuntu 24.04 AMD64 can run a low-traffic assessment demo. Its 1 GB RAM and fractional CPU are unsuitable for the throughput benchmark. Provision a 100 GB boot disk and 4 GB swap, build images on a development machine, then transfer them over SSH with `docker save`/`docker load`. Do not build the full stack on this small VM.

For images named `PREFIX-api:latest`, `PREFIX-web:latest`, `PREFIX-ai:latest`, `PREFIX-allocation:latest`, `PREFIX-pipeline:latest`, `PREFIX-migrate:latest` and `PREFIX-database:latest`, run:

```sh
python3 scripts/prepare-oracle.py --hostname YOUR_PUBLIC_HOSTNAME --prebuilt-prefix PREFIX --micro
docker compose -f .deploy/compose.yaml up --no-build -d --wait --wait-timeout 600
```

The profile uses those already loaded images, reduces the broker's memory allocation and worker concurrency, and allows more time for health checks. Use the same flags when regenerating configuration or refreshing a customer token. Keep a record of the source commit and image IDs, and re-run the deployment checks after every update. Swap prevents some memory failures but increases latency; migrate to A1 when capacity becomes available.

## Network and setup

Use a public IPv4 address, allow TCP 80/443 to the VM for Caddy HTTPS, and restrict SSH TCP 22 to the operator's current IP. PostgreSQL, Redis, Kafka, API, allocator and AI have no published host ports. A synthetic customer needs an issued signed token to use the web interface; knowing seeded user IDs is insufficient. Runtime database users are separate, with table/column grants. Store deployment secrets only in the private `.deploy/` directory, excluded from Git and Docker build contexts.

Point a hostname at the VM, or use an IP-mapped hostname such as `obbianlab-IP-WITH-DASHES.sslip.io`. Shared DNS and certificate issuance are external services and not an uptime guarantee. [Caddy](https://caddyserver.com/docs/automatic-https) obtains and renews a public certificate with ports 80/443 reachable.

Install Docker Engine/Compose using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/) and install Python 3/PyYAML. Clone the repository, then:

```sh
python3 scripts/prepare-oracle.py --hostname YOUR_PUBLIC_HOSTNAME
COMPOSE_PARALLEL_LIMIT=1 docker compose -f .deploy/compose.yaml up --build -d --wait --wait-timeout 300
docker compose -f .deploy/compose.yaml ps
```

Configuration generation preserves existing secrets. Do not remove `.deploy/secrets.json` on an existing database: database role passwords must remain consistent. The first database initialization installs extensions and creates restricted logins; then checksummed migrations and grants run before seeding and application startup. PostgreSQL, Redis, Kafka and Caddy certificate data use named persistent volumes.

The generated `.deploy/customer-access-token.txt` grants the seeded customer 24 hours of access. Retrieve it securely over SSH and paste it into the website's sign-in field. It is a credential: do not commit it or put it in a URL. Re-run the preparation script with the same hostname to issue a fresh token, preserving signing keys. Browser sessions expire after one hour and never beyond the signed token's expiry.

Only the synthetic demonstration professional receives automatic GPS heartbeats. Real professionals would publish authenticated device presence. No automatic payment or provider spending occurs in this profile. Offline AI is a separate setting (`AI_PROVIDER_MODE=offline`) from strict authentication, so choosing free model behavior does not enable demo impersonation headers or bypass admission limits.

## Verified profile checks

Run `python3 scripts/oracle-profile-check.py` after startup. It checks anonymous rejection, document administration permissions, AI confirmation and durable booking, Go allocation and acceptance, server-owned prices, cited retrieval, cancellation, signed browser login, secure cookies, CSRF/expired/tampered token rejection, and the authenticated web proxy. It creates synthetic assessment records and cancels its booking.

On 2026-10-14 this profile passed all 11 checks against a freshly initialized local Docker stack with separate database users. The related validation passed TypeScript checks, 40 AI unit tests (3 database tests skipped in that unit invocation), 8 web tests, and 22 database permission assertions. These local results do not establish Oracle capacity, ARM deployment success or public HTTPS availability; those require verification on the actual VM.

## Operations

```sh
docker compose -f .deploy/compose.yaml logs --tail=100 api ai pipeline web caddy
docker compose -f .deploy/compose.yaml exec database pg_isready -U obbian_admin -d obbian
```

Keep encrypted database backups outside this single VM; VM reclamation or disk loss is not covered by local Docker volumes. Do not run `down -v` on the deployment. This profile has no multi-AZ availability or rolling capacity guarantee. Application updates should be backed up and coordinated; the AWS release workflow remains independent.
