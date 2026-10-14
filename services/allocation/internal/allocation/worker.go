package allocation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Worker struct {
	pool        *pgxpool.Pool
	logger      *slog.Logger
	offerTTL    time.Duration
	maxAttempts int
}

func NewWorker(pool *pgxpool.Pool, logger *slog.Logger, offerTTL time.Duration, maxAttempts int) *Worker {
	return &Worker{pool: pool, logger: logger, offerTTL: offerTTL, maxAttempts: maxAttempts}
}

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := w.expireOffers(ctx); err != nil {
				w.logger.Error("expire offers", "error", err)
			}
			for i := 0; i < 20; i++ {
				allocated, err := w.allocateOne(ctx)
				if err != nil {
					w.logger.Error("allocate booking", "error", err)
					break
				}
				if !allocated {
					break
				}
			}
		}
	}
}

func (w *Worker) expireOffers(ctx context.Context) error {
	_, err := w.pool.Exec(ctx, `
WITH expired AS (
  UPDATE booking_offers SET status = 'expired', responded_at = now()
  WHERE status = 'pending' AND expires_at <= now()
  RETURNING booking_id
), retried AS (
  UPDATE bookings b
  SET status = CASE WHEN b.allocation_attempt + 1 >= $1 THEN 'unfulfilled'::booking_status ELSE 'requested'::booking_status END,
      allocation_attempt = allocation_attempt + 1,
      next_allocation_at = now() + make_interval(secs => least(30, power(2, b.allocation_attempt)::int)),
      updated_at = now()
  FROM expired e WHERE b.id = e.booking_id AND b.status = 'offered'
  RETURNING b.id, b.tenant_id, b.status
)
INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
SELECT 'booking', id,
       CASE WHEN status = 'unfulfilled' THEN 'booking.unfulfilled' ELSE 'booking.offer.expired' END,
       jsonb_build_object('bookingId', id, 'tenantId', tenant_id, 'status', status)
FROM retried`, w.maxAttempts)
	return err
}

func (w *Worker) allocateOne(ctx context.Context) (bool, error) {
	tx, err := w.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var bookingID, tenantID, categoryID string
	var scheduledFor time.Time
	err = tx.QueryRow(ctx, `
SELECT id, tenant_id, category_id, scheduled_for
FROM bookings
WHERE status = 'requested' AND allocation_attempt < $1 AND next_allocation_at <= now()
ORDER BY requested_at
FOR UPDATE SKIP LOCKED
LIMIT 1`, w.maxAttempts).Scan(&bookingID, &tenantID, &categoryID, &scheduledFor)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE bookings SET status = 'allocating', updated_at = now() WHERE id = $1`, bookingID); err != nil {
		return false, err
	}

	var professionalID string
	var distance float64
	err = tx.QueryRow(ctx, `
SELECT p.id, ST_Distance(p.location, b.pickup) AS distance_m
FROM bookings b
JOIN professionals p ON p.tenant_id = b.tenant_id
JOIN professional_services ps ON ps.professional_id = p.id AND ps.category_id = b.category_id AND ps.active
WHERE b.id = $1
  AND p.status = 'available'
  AND p.location IS NOT NULL
  AND p.location_recorded_at > now() - interval '2 minutes'
  AND ST_DWithin(p.location, b.pickup, p.service_radius_m)
  AND ST_Distance(p.location, b.pickup) / 8.33 + 120 <= b.max_eta_seconds
  AND NOT EXISTS (
    SELECT 1 FROM booking_offers previous
    WHERE previous.booking_id = b.id AND previous.professional_id = p.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM professional_assignments pa
    WHERE pa.professional_id = p.id AND pa.active
      AND pa.service_window && tstzrange(b.scheduled_for, b.scheduled_for + b.expected_duration, '[)')
  )
ORDER BY ST_Distance(p.location, b.pickup) - p.rating * 80
LIMIT 1
FOR UPDATE OF p SKIP LOCKED`, bookingID).Scan(&professionalID, &distance)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(ctx, `
UPDATE bookings SET status = CASE WHEN allocation_attempt + 1 >= $2 THEN 'unfulfilled'::booking_status ELSE 'requested'::booking_status END,
  allocation_attempt = allocation_attempt + 1,
  next_allocation_at = now() + make_interval(secs => least(30, power(2, allocation_attempt)::int)),
  updated_at = now() WHERE id = $1`, bookingID, w.maxAttempts); err != nil {
			return false, err
		}
		if _, err = tx.Exec(ctx, `
INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
SELECT 'booking',id,'booking.unfulfilled',
 jsonb_build_object('bookingId',id,'tenantId',tenant_id,'status',status)
FROM bookings WHERE id=$1 AND status='unfulfilled'`, bookingID); err != nil {
			return false, err
		}
		return true, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}

	etaSeconds := int(distance/8.33) + 120 // 30 km/h plus dispatch overhead
	var offerID string
	err = tx.QueryRow(ctx, `
INSERT INTO booking_offers (booking_id, professional_id, attempt, distance_m, eta_seconds, expires_at)
SELECT id, $2, allocation_attempt, $3, $4, now() + $5::interval
FROM bookings WHERE id = $1 RETURNING id`,
		bookingID, professionalID, int(distance), etaSeconds, fmt.Sprintf("%f seconds", w.offerTTL.Seconds())).Scan(&offerID)
	if err != nil {
		return false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE bookings SET status = 'offered', updated_at = now() WHERE id = $1`, bookingID); err != nil {
		return false, err
	}
	payload, _ := json.Marshal(map[string]any{
		"bookingId": bookingID, "offerId": offerID, "professionalId": professionalID,
		"distanceMetres": int(distance), "etaSeconds": etaSeconds, "tenantId": tenantID,
		"categoryId": categoryID, "scheduledFor": scheduledFor,
	})
	if _, err = tx.Exec(ctx, `
INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
VALUES ('booking', $1, 'booking.offer.created', $2::jsonb)`, bookingID, payload); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	w.logger.Info("offered booking", "booking_id", bookingID, "professional_id", professionalID, "offer_id", offerID)
	return true, nil
}
