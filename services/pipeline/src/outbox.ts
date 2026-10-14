import { Kafka, Producer } from 'kafkajs';
import { generateAuthToken } from 'aws-msk-iam-sasl-signer-js';
import { Pool } from 'pg';
import { config } from './config';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export class OutboxPublisher {
  private stopped = false;

  constructor(private readonly pool: Pool, private readonly producer: Producer) {}

  stop() { this.stopped = true; }

  async run() {
    let failures = 0;
    while (!this.stopped) {
      try {
        const published = await this.publishBatch();
        failures = 0;
        if (!published) await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        failures += 1;
        const delayMs = Math.min(10_000, 250 * 2 ** Math.min(failures - 1, 5));
        console.error(JSON.stringify({
          level: 'error', component: 'outbox', message: String(error), retryInMs: delayMs,
        }));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async publishBatch(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<OutboxRow>(
        `SELECT id, aggregate_id, event_type, schema_version, payload, occurred_at
         FROM outbox_events WHERE published_at IS NULL
         ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 100`,
      );
      if (!result.rowCount) {
        await client.query('COMMIT');
        return 0;
      }
      await this.producer.send({
        topic: config.eventTopic,
        acks: -1,
        messages: result.rows.map((row) => ({
          key: row.aggregate_id,
          value: JSON.stringify({
            id: row.id,
            type: row.event_type,
            schemaVersion: row.schema_version,
            aggregateId: row.aggregate_id,
            tenantId: row.payload.tenantId,
            occurredAt: row.occurred_at.toISOString(),
            traceId: row.payload.traceId ?? row.id,
            payload: row.payload,
          }),
        })),
      });
      await client.query(
        `UPDATE outbox_events SET published_at = now(), publish_attempts = publish_attempts + 1
         WHERE id = ANY($1::uuid[])`,
        [result.rows.map((row) => row.id)],
      );
      await client.query('COMMIT');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createKafka() {
  return new Kafka({
    clientId: 'obbian-pipeline', brokers: config.brokers, retry: { retries: 8 },
    ...(config.kafkaAuthMode === 'iam' ? {
      ssl: true, sasl: { mechanism: 'oauthbearer' as const, oauthBearerProvider: async () => {
        const token = await generateAuthToken({ region: config.awsRegion! });
        return { value: token.token };
      } },
    } : {}),
  });
}
