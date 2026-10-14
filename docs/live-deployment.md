# Oracle deployment verification — 14 October 2026

Live URL: https://obbianlab-161-118-169-229.sslip.io/

The application is running on an Always Free `VM.Standard.E2.1.Micro` in Mumbai AD-1 with Ubuntu 24.04 AMD64, a 100 GB boot volume and 4 GB swap. Both the 2 OCPU/12 GB and 1 OCPU/6 GB A1 requests returned an Oracle host-capacity error. No paid upgrade was made. The Micro VM is a low-traffic assessment host; local throughput measurements do not represent this VM's capacity.

All seven application/database/migration images were built and tested locally from application source commit `2fae8fc3836ec7110113654c0d04f34128a54fd0`, exported, transferred over SSH, and loaded into Docker. The transferred archive's SHA-256 and the seven image IDs were checked against the local originals. The later deployment changes add the Micro configuration and verification scripts without modifying the application images.

## Verified behavior

- All long-running application services with health probes report healthy; migrations, grants, seed and Kafka topic initialization exited successfully.
- Caddy obtained a valid Let's Encrypt certificate. The live page loads in the browser and displays its offline assessment label.
- `scripts/oracle-profile-check.py` passed all 11 groups on the VM: anonymous rejection, document administration authorization, strict offline AI/database access, confirmed backend booking, Go allocation and professional acceptance, server-owned pricing, cited retrieval, cancellation, signed login/secure cookies, CSRF/expiry/tamper rejection and the authenticated web proxy.
- `scripts/public_demo_check.py` passed all 9 public groups using normal DNS and verified HTTPS: TLS, anonymous rejection, invalid token rejection, CSRF rejection, customer sign-in, secure cookies, AI availability proposal, cited retrieval and logout. Ten requests took 0.303–2.597 seconds each in this single smoke run, not a load test.
- Backend ports 3000, 3001, 5432, 6379, 8000, 8080, 9092 and 19092 were unreachable externally. Only Caddy publishes 80/443. SSH is restricted to the deployment operator's IP in both OCI and the host firewall.
- A first DNS lookup timed out; subsequent normal DNS resolution, public tests and browser navigation succeeded. The shared sslip.io hostname has no availability guarantee.

The [first GitHub Actions run](https://github.com/hi-malik/ObbianLab/actions/runs/38536173163) did not execute its jobs. GitHub reported: "The job was not started because your account is locked due to a billing issue." Resolve that account condition and rerun CI. Do not interpret the local/cloud smoke evidence as a successful GitHub CI run.

## Sign-in and operations

The repository contains no live credentials. The customer token is stored on the VM at `/opt/obbianlab/.deploy/customer-access-token.txt` with mode 600. Retrieve it over SSH and paste it into the website's sign-in field; do not place it in a URL. It expires after 24 hours, and the browser cookie lasts at most one hour. Refresh it while preserving the existing credentials and Micro settings:

```sh
cd /opt/obbianlab
sudo python3 scripts/prepare-oracle.py --hostname obbianlab-161-118-169-229.sslip.io --prebuilt-prefix obbian-oracle-check --micro
sudo python3 scripts/oracle-profile-check.py
```

From a workstation with a securely retrieved token:

```sh
python3 scripts/public_demo_check.py --origin https://obbianlab-161-118-169-229.sslip.io --token-file /private/path/customer-access-token.txt
```

For application updates, rebuild and transfer the changed images before recreating services with `docker compose -f .deploy/compose.yaml up --no-build -d --wait --wait-timeout 600`. Do not remove the `.deploy` credentials or persistent volumes. Back up the database before migrations. The SSH source rule must be updated if the operator's public IP changes.

This remains a single-VM, offline AI and simulated payment/professional demo. It does not demonstrate AWS, multi-AZ resilience, zero-downtime rollout, hosted LLM/voice or a live Stripe test-account integration. Oracle may reclaim idle free VMs; back up important state outside the VM and avoid treating this demo as durable production hosting.
