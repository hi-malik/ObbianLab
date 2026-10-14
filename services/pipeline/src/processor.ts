import { DomainEvent, parseEvent } from '@obbian/contracts';
import { Pool, PoolClient } from 'pg';

export class PermanentEventError extends Error {}

export class EventProcessor {
  constructor(private readonly pool: Pool, private readonly consumerName: string) {}

  async process(input: DomainEvent): Promise<'processed' | 'duplicate'> {
    const event = parseEvent(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inbox = await client.query(
        `INSERT INTO consumer_inbox (consumer_name, event_id, event_type, event_payload)
         VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING event_id`,
        [this.consumerName, event.id, event.type, JSON.stringify(event)],
      );
      if (!inbox.rowCount) {
        const existing = await client.query<{ matches: boolean }>(
          `SELECT event_payload = $3::jsonb AS matches FROM consumer_inbox
           WHERE consumer_name = $1 AND event_id = $2`,
          [this.consumerName, event.id, JSON.stringify(event)],
        );
        if (!existing.rows[0]?.matches) throw new PermanentEventError('event ID reused with a different or unverifiable payload');
        await client.query('ROLLBACK');
        return 'duplicate';
      }
      await this.apply(client, event);
      await client.query(
        `UPDATE consumer_inbox SET processed_at = now() WHERE consumer_name = $1 AND event_id = $2`,
        [this.consumerName, event.id],
      );
      await client.query(
        `UPDATE dead_letters SET recovered_at = now() WHERE consumer_name = $1 AND event_id = $2 AND replayed_at IS NOT NULL`,
        [this.consumerName, event.id],
      );
      await client.query('COMMIT');
      return 'processed';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async apply(client: PoolClient, event: DomainEvent): Promise<void> {
    const counts = metricDeltas(event.type);
    if (Object.values(counts).every((value) => value === 0)) return;
    const bookingId = String(event.payload.bookingId ?? event.aggregateId);
    const booking = await client.query<{ tenant_id: string; category_id: string }>(
      'SELECT tenant_id, category_id FROM bookings WHERE id = $1', [bookingId],
    );
    // A delayed parent fact must retry: do not permanently acknowledge a zero-row aggregate.
    if (!booking.rowCount) throw new Error(`booking ${bookingId} is not available yet`);
    if (booking.rows[0].tenant_id !== event.tenantId) throw new PermanentEventError('event tenant does not own booking');
    if (event.payload.categoryId !== undefined && event.payload.categoryId !== booking.rows[0].category_id) {
      throw new PermanentEventError('event category does not match booking');
    }
    const amount = String(event.payload.amountMinor ?? 0);
    const currency = counts.gross || counts.refund ? String(event.payload.currency) : 'XXX';
    await client.query(
      `INSERT INTO daily_booking_metrics
        (tenant_id, day, category_id, currency, requested_count, completed_count, cancelled_count,
         gross_amount_minor, refund_amount_minor)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, $3, $4, $5, $6, $7, $8::bigint, $9::bigint)
       ON CONFLICT (tenant_id, day, category_id, currency) DO UPDATE SET
         requested_count = daily_booking_metrics.requested_count + EXCLUDED.requested_count,
         completed_count = daily_booking_metrics.completed_count + EXCLUDED.completed_count,
         cancelled_count = daily_booking_metrics.cancelled_count + EXCLUDED.cancelled_count,
         gross_amount_minor = daily_booking_metrics.gross_amount_minor + EXCLUDED.gross_amount_minor,
         refund_amount_minor = daily_booking_metrics.refund_amount_minor + EXCLUDED.refund_amount_minor,
         updated_at = now()`,
      [event.tenantId, event.occurredAt, booking.rows[0].category_id, currency,
        counts.requested, counts.completed, counts.cancelled, counts.gross ? amount : '0', counts.refund ? amount : '0'],
    );
  }
}

export function metricDeltas(type: string) {
  return {
    requested: type === 'booking.requested' ? 1 : 0,
    completed: type === 'booking.completed' ? 1 : 0,
    cancelled: type === 'booking.cancelled' ? 1 : 0,
    gross: type === 'payment.captured' ? 1 : 0,
    refund: type === 'payment.refunded' ? 1 : 0,
  };
}
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}
