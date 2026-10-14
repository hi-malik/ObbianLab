BEGIN;

CREATE TABLE booking_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES app_users(id),
  category_slug text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 9007199254740991),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  policy_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_quotes_customer_idx ON booking_quotes (tenant_id, customer_id, created_at);

CREATE FUNCTION protect_booking_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'booking quotes are immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bookings b JOIN service_categories c ON c.id=b.category_id
    WHERE b.id=NEW.booking_id AND b.tenant_id=NEW.tenant_id AND b.customer_id=NEW.customer_id
      AND c.tenant_id=NEW.tenant_id AND c.slug=NEW.category_slug) THEN
    RAISE EXCEPTION 'booking quote ownership or category mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_quote_guard BEFORE INSERT OR UPDATE ON booking_quotes
FOR EACH ROW EXECUTE FUNCTION protect_booking_quote();

CREATE FUNCTION require_payment_matches_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q booking_quotes;
BEGIN
  SELECT * INTO q FROM booking_quotes WHERE booking_id=NEW.booking_id;
  IF FOUND AND (q.tenant_id <> NEW.tenant_id OR q.amount_minor <> NEW.amount_minor OR q.currency <> NEW.currency) THEN
    RAISE EXCEPTION 'payment does not match the authoritative booking quote';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_quote_guard BEFORE INSERT OR UPDATE OF amount_minor,currency,booking_id,tenant_id ON payment_intents
FOR EACH ROW EXECUTE FUNCTION require_payment_matches_quote();

COMMIT;
