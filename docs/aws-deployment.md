# AWS deployment and release runbook

No AWS resources have been created by this review. The user asked to finish the audit/fixes first and select the account/hostname afterward. The following is the concrete deployment path, not a claim of an already deployed AWS environment.

## Account inputs and bootstrap

Use an AWS profile or role with approved permissions in the intended account. Keep API keys, database URLs/passwords and signing secrets in AWS Secrets Manager, never chat or Git. Select a currently supported EKS Kubernetes version and Aurora PostgreSQL version in that region before planning.

Terraform inputs in `infra/terraform`:

- `aws_region`, `name`, `environment`, optional `vpc_cidr`;
- `eks_version`, `database_engine_version`;
- `operator_cidrs`: explicit operator/deployment-runner egress addresses, not `0.0.0.0/0`;
- `deploy_principal_arn`: the IAM role/user authorized to deploy to EKS.

Create a versioned, encrypted Terraform S3 state bucket and configure its backend. Inspect a saved plan before applying it. The plan creates chargeable EKS nodes, three NAT gateways, Aurora, Redis, MSK, ECR and monitoring resources. Use the account/region agreed with the user; these are not free-tier-only resources.

```sh
terraform -chdir=infra/terraform init -backend-config=YOUR_BACKEND_CONFIG
terraform -chdir=infra/terraform plan -var-file=YOUR_ENVIRONMENT_TFVARS -out=release.tfplan
terraform -chdir=infra/terraform apply release.tfplan
```

Run `scripts/bootstrap-aws.sh` on a trusted deployment host. Supply `CLUSTER_NAME`, `AWS_REGION`, `VPC_ID`, `LOAD_BALANCER_ROLE_ARN`, `AUTOSCALER_CHART_VERSION` and `AUTOSCALER_IMAGE_TAG`. The autoscaler image minor must match the EKS version. This installs the AWS Load Balancer Controller and Cluster Autoscaler; Terraform installs VPC network-policy support, DNS/proxy, metrics, Pod Identity and CloudWatch observability add-ons. Node autoscaling is independent of the HPA resources that scale service replicas. Terraform ignores the node group desired capacity after initial creation so a later infrastructure apply does not undo autoscaler decisions.

The deployment runner must be inside the VPC or have a stable allowed CIDR. `.github/workflows/deploy.yml` intentionally uses `[self-hosted, linux, x64, obbian-deploy]` for the Kubernetes release stage; an arbitrary GitHub-hosted runner is not allowed through the restricted cluster endpoint. Image builds run on hosted runners using OIDC. The configured deployment role needs ECR publication, EKS describe/access and permission to read only the application secret; bootstrap infrastructure permissions are separate.

## Application secret and database identities

The application secret is a JSON object. The deployment script validates required fields without printing values:

| Fields | Purpose |
| --- | --- |
| `API_DATABASE_URL`, `ALLOCATION_DATABASE_URL`, `PIPELINE_DATABASE_URL`, `AI_DATABASE_URL`, `MIGRATION_DATABASE_URL` | Five distinct login roles on the same Aurora database |
| `KAFKA_BROKERS`, `REDIS_URL` | MSK IAM brokers and a `rediss://` endpoint |
| `AUTH_SIGNING_SECRET`, `INTERNAL_SERVICE_TOKEN`, `AI_SERVICE_TOKEN`, `SANDBOX_WEBHOOK_SECRET` | Independent secrets of at least 32 characters |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Structured multilingual intent and grounded answer provider |
| `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | Semantic embeddings supporting 384 output dimensions |
| `ASR_BASE_URL`, `ASR_API_KEY`, `ASR_MODEL` | Real audio transcription |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe **test-mode** credentials and timestamped webhook verification |
| `STRIPE_CONNECT_DESTINATIONS` | Trusted JSON mapping professional UUIDs to provisioned Stripe test connected accounts |
| `SERVICE_PRICES_JSON` | Trusted server service prices; see the quote API and pricing configuration |

Database usernames must be distinct, non-privileged identifiers. Passwords must be at least 32 characters and URL-encoded correctly. Database bootstrap must run from a host with private Aurora connectivity (inside the VPC or through an approved VPN). An allowed public EKS CIDR alone does not grant database access. Only a one-time trusted bootstrap uses the RDS master secret: set `DATABASE_ADMIN_URL` locally and run:

```sh
npm ci
node scripts/provision-database.mjs --secret-id APPLICATION_SECRET_ARN --region AWS_REGION
```

This creates PostGIS/pgvector and other required extensions, creates restricted logins, and grants schema creation only to the migrator. It does not log credentials. Each release runs migrations as that owner and then applies explicit runtime grants from `db/provision-runtime.sql`. AI cannot read/mutate bookings or financial ledgers; runtime identities cannot create tables. Run `scripts/database_permissions_check.mjs` against its disposable test database to verify these permissions locally.

Aurora URLs are normalized to `sslmode=verify-full` with a mounted official RDS CA bundle. See `infra/certs/README.md` for source, hash and rotation. Kafka uses IAM OAUTHBEARER/TLS and the pipeline's workload role; topic creation is an explicit idempotent release job. Redis uses TLS. Public access uses an ACM certificate and an ALB HTTPS redirect.

## Release

Set these GitHub environment values: `AWS_REGION`, `CLUSTER_NAME`, `ECR_PREFIX`, `PUBLIC_HOSTNAME`, `CERTIFICATE_ARN`, `VPC_CIDR`. Set environment secrets `DEPLOY_ROLE_ARN` and `APPLICATION_SECRET_ARN`; configure the IAM OIDC trust to the intended repository/environment. Supply a validated ACM certificate for the public hostname. On the first release, the script prints the ALB hostname once available; point DNS to that hostname while the bounded HTTPS verification waits (default ten minutes, configurable with `--public-check-timeout`). Later releases reuse the ingress. The deployment fails if strict public HTTPS verification does not pass before the timeout.

The workflow executes the reusable CI suite, builds all six images, scans each image, pushes only scanned images to immutable ECR repositories, and records content digests. The release stage invokes `scripts/deploy.py`, which:

1. Validates configuration and creates immutable release-specific config/secrets.
2. Applies network policies, atomic checksummed migrations and explicit runtime grants.
3. Initializes Kafka topics with twelve event/retry partitions and three DLQ partitions.
4. Applies digest-pinned workloads and waits for every rollout.
5. Checks the public HTTPS session endpoint reports strict unauthenticated mode.
6. On failure, restores prior complete Deployment specifications, including image/config/secret references; a failed initial deployment removes newly created workloads.

Schema rollback is not automated. Expand/contract compatibility is mandatory for rolling upgrades. Migration 006's currency key change is an initial coordinated upgrade and cannot be rolled back to the pre-review pipeline image. Keep the queues intact during that worker restart. Retain older immutable secrets/configs referenced by live or rollback ReplicaSets; garbage-collect only after the rollback window closes.

Issue a short-lived signed assessment token for an already provisioned user with `scripts/issue-token.mjs` and sign into the UI. Production deployment does not seed impersonable demo users. Provision actual tenant/users/categories/professionals using an authorized database administration session. Professional devices must publish presence to be available. A live demonstration should cover booking, actual signed WebSocket tracking, payment capture/refund/reconciliation and Connect test transfer using the provider's test account.

Configure Stripe test webhooks to `https://HOSTNAME/api/payments/webhook`; supported types and the credentialed test script are in `docs/review-booking-payments.md`. This Next.js endpoint streams the exact signed bytes to the private API. No live secret keys or real payments are supported.

## Required live acceptance evidence

Before calling scenario 6 complete, retain the Terraform apply outputs, successful remote CI run, public HTTPS checks, strict-role negative checks, provider-backed AI/RAG/audio and payment/transfer demonstration, rollout under traffic, rollback, one-pod crash recovery, dependency outage/recovery, and a database backup restore. Local configuration validation is not a substitute for these runs. Record observed latency/error rate, rollout duration and recovery time; do not present proposed RTO/RPO as measurements.
