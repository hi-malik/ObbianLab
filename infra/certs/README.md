# Amazon RDS trust bundle

`global-bundle.pem` is the public commercial-region Amazon RDS/Aurora CA bundle downloaded on 2026-10-14 from:

https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

SHA-256: `fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c`.

The deployment renderer mounts it through an immutable release ConfigMap at `/etc/obbian-certs/global-bundle.pem` in database clients and migration/grant jobs. Database URLs are normalized to `sslmode=verify-full` with this exact `sslrootcert`; arbitrary identity overrides or file options are rejected. The one-time Node database bootstrap uses this repository copy when connecting to an RDS hostname. Update the bundle from the official endpoint and review it before a CA rotation; the source file is public certificate material, not a secret. See [AWS PostgreSQL TLS guidance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html).
