BEGIN;

ALTER TABLE consumer_inbox ADD COLUMN event_payload jsonb;
-- Backfill the exact v1 envelope previously published by the outbox worker.
UPDATE consumer_inbox i SET event_payload = jsonb_build_object(
  'id', o.id, 'type', o.event_type, 'schemaVersion', o.schema_version,
  'aggregateId', o.aggregate_id, 'tenantId', o.payload->>'tenantId',
  'occurredAt', to_char(o.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'traceId', COALESCE(o.payload->>'traceId', o.id::text), 'payload', o.payload)
FROM outbox_events o WHERE i.event_id = o.id;

ALTER TABLE daily_booking_metrics ADD COLUMN currency char(3) NOT NULL DEFAULT 'XXX';
ALTER TABLE daily_booking_metrics DROP CONSTRAINT daily_booking_metrics_pkey;
ALTER TABLE daily_booking_metrics ADD PRIMARY KEY (tenant_id, day, category_id, currency);
ALTER TABLE daily_booking_metrics ADD CONSTRAINT metric_currency CHECK (currency ~ '^[A-Z]{3}$');
-- Preserve count history. Rebuild monetary history by currency from committed source facts.
UPDATE daily_booking_metrics SET gross_amount_minor = 0, refund_amount_minor = 0;
INSERT INTO daily_booking_metrics (tenant_id, day, category_id, currency, gross_amount_minor, refund_amount_minor)
SELECT b.tenant_id, (o.occurred_at AT TIME ZONE 'UTC')::date, b.category_id, o.payload->>'currency',
       sum(CASE WHEN o.event_type = 'payment.captured' THEN (o.payload->>'amountMinor')::bigint ELSE 0 END),
       sum(CASE WHEN o.event_type = 'payment.refunded' THEN (o.payload->>'amountMinor')::bigint ELSE 0 END)
FROM outbox_events o JOIN consumer_inbox i ON i.event_id = o.id AND i.consumer_name = 'reporting-v1'
JOIN bookings b ON b.id = (o.payload->>'bookingId')::uuid AND b.tenant_id = (o.payload->>'tenantId')::uuid
WHERE o.event_type IN ('payment.captured', 'payment.refunded') AND i.processed_at IS NOT NULL
GROUP BY b.tenant_id, (o.occurred_at AT TIME ZONE 'UTC')::date, b.category_id, o.payload->>'currency'
ON CONFLICT (tenant_id, day, category_id, currency) DO UPDATE
SET gross_amount_minor = EXCLUDED.gross_amount_minor, refund_amount_minor = EXCLUDED.refund_amount_minor;

ALTER TABLE dead_letters ADD COLUMN published_at timestamptz;
ALTER TABLE dead_letters ADD COLUMN recovered_at timestamptz;
CREATE INDEX processing_failures_ready_idx ON processing_failures (consumer_name, available_at)
WHERE dispatched_at IS NULL;
CREATE INDEX dead_letters_unpublished_idx ON dead_letters (consumer_name, failed_at)
WHERE published_at IS NULL;
COMMIT;
