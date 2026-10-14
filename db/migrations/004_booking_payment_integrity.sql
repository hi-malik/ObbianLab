BEGIN;
ALTER TABLE bookings ADD COLUMN max_eta_seconds integer NOT NULL DEFAULT 1800 CHECK (max_eta_seconds BETWEEN 120 AND 14400);

-- One logical charge per booking, independent of client retry keys.
CREATE UNIQUE INDEX one_payment_per_booking ON payment_intents (booking_id);
ALTER TABLE payment_webhook_inbox ADD COLUMN applied boolean NOT NULL DEFAULT true;
ALTER TABLE payment_webhook_inbox ADD COLUMN processing_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE payment_webhook_inbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX payment_webhook_retry_idx ON payment_webhook_inbox (next_attempt_at) WHERE processed_at IS NULL;
CREATE TABLE payment_refunds (
  payment_id uuid NOT NULL REFERENCES payment_intents(id),
  gateway_refund_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payment_id, gateway_refund_id)
);
INSERT INTO payment_refunds (payment_id,gateway_refund_id,amount_minor)
SELECT pi.id,w.gateway_event_id,(w.payload->>'amountMinor')::bigint
FROM payment_webhook_inbox w JOIN payment_intents pi ON pi.gateway_payment_id=w.payload->>'gatewayPaymentId'
WHERE w.processed_at IS NOT NULL AND w.payload->>'type'='payment.refunded';

-- Entry currencies and tenants must agree with both parent transaction/account.
CREATE FUNCTION enforce_ledger_entry_ownership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_accounts a JOIN ledger_transactions t ON t.tenant_id=a.tenant_id
    WHERE a.id=NEW.account_id AND t.id=NEW.transaction_id AND a.currency=NEW.currency
  ) THEN RAISE EXCEPTION 'ledger account, transaction tenant, or currency mismatch'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entry_ownership BEFORE INSERT ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_entry_ownership();
CREATE FUNCTION enforce_nonempty_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_ledger_transaction_balanced(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transaction_nonempty AFTER INSERT ON ledger_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_nonempty_ledger_transaction();
-- Notifications fan out committed state to every API replica. Clients recover a
-- missed notification using GET booking/latest location after reconnecting.
CREATE FUNCTION notify_booking_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.aggregate_type='booking' THEN PERFORM pg_notify('booking_changes',NEW.id::text); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_outbox_notification AFTER INSERT ON outbox_events
FOR EACH ROW EXECUTE FUNCTION notify_booking_change();
CREATE FUNCTION notify_booking_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('booking_tracking',NEW.id::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_location_notification AFTER INSERT ON booking_locations
FOR EACH ROW EXECUTE FUNCTION notify_booking_location();
COMMIT;
