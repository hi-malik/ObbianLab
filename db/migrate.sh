#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"

# One connection holds a lock across the run; schema and migration record commit
# together, including if the process crashes or two deploys start concurrently.
{
  cat <<'SQL'
SELECT pg_advisory_lock(713648210);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
SQL
  for file in /migrations/*.sql; do
    version="$(basename "$file")"
    case "$version" in *[!a-zA-Z0-9_.-]*) exit 1;; esac
    checksum="$(sha256sum "$file" | cut -d' ' -f1)"
    printf "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version='%s') AS applied \\gset\n" "$version"
    printf '\\if :applied\n'
    printf "DO \$\$ BEGIN IF EXISTS(SELECT 1 FROM schema_migrations WHERE version='%s' AND checksum IS NOT NULL AND checksum <> '%s') THEN RAISE EXCEPTION 'Applied migration checksum changed: %s'; END IF; END \$\$;\n" "$version" "$checksum" "$version"
    printf "UPDATE schema_migrations SET checksum='%s' WHERE version='%s' AND checksum IS NULL;\n" "$checksum" "$version"
    printf '\\else\nBEGIN;\n'
    sed '/^BEGIN;$/d; /^COMMIT;$/d' "$file"
    printf "\nINSERT INTO schema_migrations(version,checksum) VALUES ('%s','%s');\nCOMMIT;\n" "$version" "$checksum"
    printf '%s\n' '\endif'
  done
  printf 'SELECT pg_advisory_unlock(713648210);\n'
} | /usr/local/bin/psql-env -X -v ON_ERROR_STOP=1
