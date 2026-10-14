import { createHash, randomUUID } from 'node:crypto';
import { parseEvent } from '@obbian/contracts';
import { Producer } from 'kafkajs';
import { Pool } from 'pg';
import { config } from './config';
import { retryDelayMs } from './processor';

// Kafka redelivery of the same malformed record must refer to the same DLQ entry.
export function sourceEventId(source: string): string {
  const hex = createHash('sha256').update(source).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class FailureQueue {
  constructor(private readonly pool: Pool, private readonly producer: Producer,
    private readonly consumerName = config.consumerName) {}

  async record(raw: unknown, eventId: string | undefined, eventType: string | undefined,
    reason: string, retryable = true, deliveredAttempt = 0, source?: string) {
    const validEventId = eventId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId);
    const id = validEventId ? eventId : source ? sourceEventId(source) : randomUUID();
    const attempt = deliveredAttempt + 1;
    if (!retryable || !validEventId || attempt >= config.maxAttempts) {
      // Database is authoritative. Notification publication is retried separately.
      await this.pool.query(
        `INSERT INTO dead_letters (consumer_name, event_id, event_type, reason, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (consumer_name, event_id) DO UPDATE SET
           reason = EXCLUDED.reason, payload = EXCLUDED.payload, failed_at = now(),
           published_at = NULL, replayed_at = NULL, recovered_at = NULL`,
        [this.consumerName, id, eventType ?? 'invalid', reason.slice(0, 2000), JSON.stringify(raw ?? null)],
      );
      return;
    }
    // Attempt comes from the delivered message, not max(attempt): concurrent duplicate
    // deliveries schedule one retry and cannot exhaust the retry budget early.
    await this.pool.query(
      `INSERT INTO processing_failures
        (consumer_name, event_id, attempt, available_at, error_code, error_detail, payload)
       VALUES ($1, $2, $3, $4, 'PROCESSING_ERROR', $5, $6::jsonb) ON CONFLICT DO NOTHING`,
      [this.consumerName, id, attempt, new Date(Date.now() + retryDelayMs(attempt)), reason.slice(0, 2000), JSON.stringify(raw ?? null)],
    );
  }

  async replay(eventId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ payload: unknown }>(
        'SELECT payload FROM dead_letters WHERE consumer_name = $1 AND event_id = $2 FOR UPDATE',
        [this.consumerName, eventId],
      );
      if (!result.rowCount) throw new Error('dead letter not found');
      const event = parseEvent(result.rows[0].payload);
      if (event.id !== eventId) throw new Error('invalid dead-letter event identity');
      const processed = await client.query('SELECT 1 FROM consumer_inbox WHERE consumer_name = $1 AND event_id = $2',
        [this.consumerName, eventId]);
      if (processed.rowCount) throw new Error('already processed event cannot be replayed from a conflicting payload');
      await client.query('DELETE FROM processing_failures WHERE consumer_name = $1 AND event_id = $2', [this.consumerName, eventId]);
      await client.query(
        `INSERT INTO processing_failures (consumer_name, event_id, attempt, available_at, error_code, error_detail, payload)
         VALUES ($1, $2, 0, now(), 'OPERATOR_REPLAY', 'explicit replay after recovery', $3::jsonb)`,
        [this.consumerName, eventId, JSON.stringify(event)],
      );
      await client.query('UPDATE dead_letters SET replayed_at = now(), recovered_at = NULL WHERE consumer_name = $1 AND event_id = $2',
        [this.consumerName, eventId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async pumpOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ event_id: string; attempt: number; payload: any }>(
        `SELECT f.event_id, f.attempt, f.payload FROM processing_failures f
         WHERE f.consumer_name = $1 AND f.available_at <= now() AND f.dispatched_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM consumer_inbox i WHERE i.consumer_name = f.consumer_name AND i.event_id = f.event_id)
           AND NOT EXISTS (SELECT 1 FROM dead_letters d WHERE d.consumer_name = f.consumer_name AND d.event_id = f.event_id AND d.replayed_at IS NULL)
         ORDER BY f.available_at FOR UPDATE OF f SKIP LOCKED LIMIT 100`,
        [this.consumerName],
      );
      if (result.rowCount) {
        await this.producer.send({
          topic: config.retryTopic, acks: -1,
          messages: result.rows.map((row) => ({ key: String(row.payload.aggregateId ?? row.event_id),
            value: JSON.stringify(row.payload), headers: { attempt: String(row.attempt) } })),
        });
        // Mark exactly the selected event+attempt pairs; future attempts remain pending.
        await client.query(
          `UPDATE processing_failures f SET dispatched_at = now()
           FROM unnest($2::uuid[], $3::int[]) AS selected(event_id, attempt)
           WHERE f.consumer_name = $1 AND f.event_id = selected.event_id AND f.attempt = selected.attempt`,
          [this.consumerName, result.rows.map((row) => row.event_id), result.rows.map((row) => row.attempt)],
        );
      }
      const dead = await client.query<{ event_id: string; payload: unknown }>(
        `SELECT event_id, payload FROM dead_letters WHERE consumer_name = $1 AND published_at IS NULL
         ORDER BY failed_at FOR UPDATE SKIP LOCKED LIMIT 100`, [this.consumerName],
      );
      if (dead.rowCount) {
        await this.producer.send({ topic: config.dlqTopic, acks: -1,
          messages: dead.rows.map((row) => ({ key: row.event_id, value: JSON.stringify(row.payload) })) });
        await client.query('UPDATE dead_letters SET published_at = now() WHERE consumer_name = $1 AND event_id = ANY($2::uuid[])',
          [this.consumerName, dead.rows.map((row) => row.event_id)]);
      }
      await client.query('COMMIT');
      return (result.rowCount ?? 0) + (dead.rowCount ?? 0);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
