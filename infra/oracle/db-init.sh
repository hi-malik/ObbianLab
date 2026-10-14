#!/bin/bash
set -euo pipefail
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
\getenv migration_password DB_MIGRATION_PASSWORD
\getenv api_password DB_API_PASSWORD
\getenv allocation_password DB_ALLOCATION_PASSWORD
\getenv pipeline_password DB_PIPELINE_PASSWORD
\getenv ai_password DB_AI_PASSWORD
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE ROLE obbian_migration LOGIN NOINHERIT PASSWORD :'migration_password';
CREATE ROLE obbian_api LOGIN NOINHERIT PASSWORD :'api_password';
CREATE ROLE obbian_allocation LOGIN NOINHERIT PASSWORD :'allocation_password';
CREATE ROLE obbian_pipeline LOGIN NOINHERIT PASSWORD :'pipeline_password';
CREATE ROLE obbian_ai LOGIN NOINHERIT PASSWORD :'ai_password';
GRANT CONNECT ON DATABASE obbian TO obbian_migration,obbian_api,obbian_allocation,obbian_pipeline,obbian_ai;
GRANT USAGE ON SCHEMA public TO obbian_migration,obbian_api,obbian_allocation,obbian_pipeline,obbian_ai;
GRANT CREATE ON SCHEMA public TO obbian_migration;
SQL
