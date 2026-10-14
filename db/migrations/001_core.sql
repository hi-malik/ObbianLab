BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE booking_status AS ENUM (
  'requested', 'allocating', 'offered', 'confirmed', 'in_progress',
  'completed', 'cancelled', 'unfulfilled'
);
CREATE TYPE offer_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_subject text NOT NULL,
  display_name text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_subject)
);

CREATE TABLE service_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  slug text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE professionals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid REFERENCES app_users(id),
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy', 'suspended')),
  location geography(Point, 4326),
  location_recorded_at timestamptz,
  service_radius_m integer NOT NULL DEFAULT 10000 CHECK (service_radius_m BETWEEN 100 AND 100000),
  rating numeric(3,2) NOT NULL DEFAULT 5.0 CHECK (rating BETWEEN 0 AND 5),
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX professionals_location_gix ON professionals USING gist (location);

CREATE TABLE professional_services (
  professional_id uuid NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES service_categories(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (professional_id, category_id)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES app_users(id),
  category_id uuid NOT NULL REFERENCES service_categories(id),
  pickup geography(Point, 4326) NOT NULL,
  address text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  expected_duration interval NOT NULL DEFAULT interval '1 hour',
  status booking_status NOT NULL DEFAULT 'requested',
  assigned_professional_id uuid REFERENCES professionals(id),
  allocation_attempt integer NOT NULL DEFAULT 0,
  next_allocation_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expected_duration > interval '0 seconds')
);
CREATE INDEX bookings_allocation_idx ON bookings (status, next_allocation_at, requested_at)
  WHERE status IN ('requested', 'allocating', 'offered');
CREATE INDEX bookings_pickup_gix ON bookings USING gist (pickup);

CREATE TABLE booking_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  attempt integer NOT NULL,
  status offer_status NOT NULL DEFAULT 'pending',
  distance_m integer NOT NULL,
  eta_seconds integer NOT NULL,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (booking_id, professional_id, attempt),
  CHECK (expires_at > offered_at)
);
CREATE UNIQUE INDEX one_pending_offer_per_booking
  ON booking_offers (booking_id) WHERE status = 'pending';
CREATE INDEX offers_professional_pending_idx
  ON booking_offers (professional_id, expires_at) WHERE status = 'pending';

-- Accepted assignments are the durable guard against double booking. Adjacent
-- ranges are allowed; overlapping active work for one professional is not.
CREATE TABLE professional_assignments (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  service_window tstzrange NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (
    professional_id WITH =,
    service_window WITH &&
  ) WHERE (active)
);

CREATE TABLE booking_locations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  professional_id uuid NOT NULL REFERENCES professionals(id),
  position geography(Point, 4326) NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, professional_id, recorded_at)
);
CREATE INDEX booking_locations_lookup_idx ON booking_locations (booking_id, recorded_at DESC);

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, key)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;

COMMIT;
