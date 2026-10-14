#!/bin/sh
set -eu
: "${DATABASE_URL:?migration database URL required}"
: "${API_DATABASE_USER:?API role required}"
: "${ALLOCATION_DATABASE_USER:?allocation role required}"
: "${PIPELINE_DATABASE_USER:?pipeline role required}"
: "${AI_DATABASE_USER:?AI role required}"
/usr/local/bin/psql-env -X -v ON_ERROR_STOP=1 \
  --set=api_user="$API_DATABASE_USER" --set=allocation_user="$ALLOCATION_DATABASE_USER" \
  --set=pipeline_user="$PIPELINE_DATABASE_USER" --set=ai_user="$AI_DATABASE_USER" <<'SQL'
SELECT set_config('obbian.role.api', :'api_user', false);
SELECT set_config('obbian.role.allocation', :'allocation_user', false);
SELECT set_config('obbian.role.pipeline', :'pipeline_user', false);
SELECT set_config('obbian.role.ai', :'ai_user', false);
\i /provision-runtime.sql
SQL
