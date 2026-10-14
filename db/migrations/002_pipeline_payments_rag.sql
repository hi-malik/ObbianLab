BEGIN;

CREATE TABLE consumer_inbox (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (consumer_name, event_id)
);

CREATE TABLE processing_failures (
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  attempt integer NOT NULL,
  available_at timestamptz NOT NULL,
  error_code text NOT NULL,
  error_detail text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  PRIMARY KEY (consumer_name, event_id, attempt)
);

CREATE TABLE dead_letters (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consumer_name text NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  UNIQUE (consumer_name, event_id)
);

CREATE TABLE daily_booking_metrics (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day date NOT NULL,
  category_id uuid NOT NULL REFERENCES service_categories(id),
  requested_count bigint NOT NULL DEFAULT 0,
  completed_count bigint NOT NULL DEFAULT 0,
  cancelled_count bigint NOT NULL DEFAULT 0,
  gross_amount_minor bigint NOT NULL DEFAULT 0,
  refund_amount_minor bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, category_id)
);

CREATE TYPE payment_status AS ENUM ('created', 'authorized', 'captured', 'failed', 'partially_refunded', 'refunded');
CREATE TYPE ledger_direction AS ENUM ('debit', 'credit');

CREATE TABLE payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  gateway text NOT NULL,
  gateway_payment_id text,
  idempotency_key text NOT NULL,
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  status payment_status NOT NULL DEFAULT 'created',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (gateway, gateway_payment_id),
  CHECK (refunded_minor <= amount_minor)
);

CREATE TABLE payment_webhook_inbox (
  gateway text NOT NULL,
  gateway_event_id text NOT NULL,
  signature_digest text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  PRIMARY KEY (gateway, gateway_event_id)
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  owner_type text NOT NULL CHECK (owner_type IN ('platform', 'professional', 'customer', 'gateway')),
  owner_id uuid,
  code text NOT NULL,
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_type, owner_id, code, currency)
);

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  direction ledger_direction NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at, id);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  professional_id uuid NOT NULL REFERENCES professionals(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'submitted', 'paid', 'failed')),
  idempotency_key text NOT NULL,
  gateway_payout_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (period_end > period_start)
);

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_key text NOT NULL,
  title text NOT NULL,
  classification text NOT NULL DEFAULT 'internal',
  active_version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_key)
);

CREATE TABLE knowledge_document_acl (
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'role')),
  principal text NOT NULL,
  PRIMARY KEY (document_id, principal_type, principal)
);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  version integer NOT NULL,
  ordinal integer NOT NULL,
  heading text,
  content text NOT NULL,
  content_sha256 text NOT NULL,
  embedding vector(384) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version, ordinal)
);
CREATE INDEX knowledge_chunks_embedding_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE ai_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  event_type text NOT NULL,
  tool_name text,
  request jsonb,
  response jsonb,
  decision text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_audit_conversation_idx ON ai_audit_events (tenant_id, conversation_id, created_at);

COMMIT;
