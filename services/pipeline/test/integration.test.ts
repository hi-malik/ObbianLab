import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { Producer } from 'kafkajs';
import { DomainEvent } from '@obbian/contracts';
import { EventProcessor, PermanentEventError } from '../src/processor';
import { FailureQueue, sourceEventId } from '../src/retry';
import { OutboxPublisher } from '../src/outbox';

const databaseUrl = process.env.PIPELINE_TEST_DATABASE_URL;
// Real PostgreSQL tests opt in and must never target an application database.
const suite = databaseUrl ? describe : describe.skip;
suite('real PostgreSQL pipeline integrity', () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const consumer = `test-${randomUUID()}`;
  const processor = new EventProcessor(pool, consumer);
  const tenant = randomUUID(), customer = randomUUID(), category = randomUUID(), booking = randomUUID();
  const send = vi.fn().mockResolvedValue([]);
  const failures = new FailureQueue(pool, { send } as unknown as Producer, consumer);
  function event(type: DomainEvent['type'], overrides: Partial<DomainEvent> = {}): DomainEvent {
    const paymentId = randomUUID();
    return { id: randomUUID(), type, schemaVersion: 1,
      aggregateId: type.startsWith('booking.') ? booking : paymentId, tenantId: tenant,
      occurredAt: '2026-01-01T01:00:00Z', traceId: 'integration',
      payload: type === 'booking.requested'
        ? { bookingId: booking, customerId: customer, categoryId: category, scheduledFor: '2026-01-01T01:00:00Z' }
        : type.startsWith('booking.') ? { bookingId: booking }
        : { bookingId: booking, paymentId, amountMinor: 100, currency: 'INR' }, ...overrides };
  }
  async function createBooking(id: string) {
    await pool.query(`INSERT INTO bookings (id, tenant_id, customer_id, category_id, pickup, address, scheduled_for, expected_duration)
      VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(77,28),4326)::geography,'test',now(),interval '1 hour')`,
    [id,tenant,customer,category]);
  }
  beforeAll(async () => {
    if (!/test|review|benchmark/.test(new URL(databaseUrl!).pathname)) throw new Error('test database name required');
    await pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenant,'Pipeline integration']);
    await pool.query("INSERT INTO app_users (id,tenant_id,external_subject,roles,display_name) VALUES ($1,$2,$3,ARRAY['customer'],'Test')", [customer,tenant,customer]);
    await pool.query("INSERT INTO service_categories (id,tenant_id,slug,name) VALUES ($1,$2,$3,'Test')", [category,tenant,`test-${category}`]);
    await createBooking(booking);
  });
  afterAll(async () => { await pool.end(); });
  it('counts 20 concurrent deliveries exactly once and rejects identity collisions', async () => {
    const fact = event('booking.requested');
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => processor.process(fact)));
    expect(outcomes.filter((value) => value === 'processed')).toHaveLength(1);
    expect(outcomes.filter((value) => value === 'duplicate')).toHaveLength(19);
    await expect(processor.process({ ...fact, traceId: 'changed' })).rejects.toBeInstanceOf(PermanentEventError);
    expect((await pool.query('SELECT requested_count FROM daily_booking_metrics WHERE tenant_id=$1', [tenant])).rows[0].requested_count).toBe('1');
  });
  it('rolls back missing parents, then recovers without losing the fact', async () => {
    const missing = randomUUID();
    const fact = event('booking.completed', { aggregateId: missing, payload: { bookingId: missing } });
    await expect(processor.process(fact)).rejects.toThrow('not available');
    expect((await pool.query('SELECT 1 FROM consumer_inbox WHERE event_id=$1', [fact.id])).rowCount).toBe(0);
    await createBooking(missing);
    expect(await processor.process(fact)).toBe('processed');
  });
  it('rejects cross-tenant data without an inbox commit', async () => {
    const fact = event('booking.cancelled', { tenantId: randomUUID() });
    await expect(processor.process(fact)).rejects.toBeInstanceOf(PermanentEventError);
    expect((await pool.query('SELECT 1 FROM consumer_inbox WHERE event_id=$1', [fact.id])).rowCount).toBe(0);
  });
  it('aggregates late refunds/captures by UTC date and currency with exact bigint values', async () => {
    const capture = event('payment.captured');
    capture.payload.amountMinor = '9007199254740993';
    const refund = event('payment.refunded');
    const usd = event('payment.captured'); usd.payload.currency = 'USD';
    // Refund intentionally arrives before its capture; additive facts are order independent.
    await processor.process(refund); await processor.process(capture); await processor.process(usd);
    const rows = (await pool.query("SELECT currency,gross_amount_minor,refund_amount_minor FROM daily_booking_metrics WHERE tenant_id=$1 AND currency <> 'XXX' ORDER BY currency", [tenant])).rows;
    expect(rows).toEqual([
      { currency: 'INR', gross_amount_minor: '9007199254740993', refund_amount_minor: '100' },
      { currency: 'USD', gross_amount_minor: '100', refund_amount_minor: '0' },
    ]);
  });
  it('schedules one retry on concurrent duplicate failure and retains future attempts', async () => {
    const fact = event('booking.completed');
    await Promise.all(Array.from({ length: 12 }, () => failures.record(fact, fact.id, fact.type, 'transient', true, 0)));
    expect((await pool.query('SELECT 1 FROM processing_failures WHERE event_id=$1', [fact.id])).rowCount).toBe(1);
    await failures.record(fact, fact.id, fact.type, 'future', true, 1);
    await pool.query("UPDATE processing_failures SET available_at=CASE WHEN attempt=1 THEN now()-interval '1 second' ELSE now()+interval '1 hour' END WHERE event_id=$1", [fact.id]);
    await failures.pumpOnce();
    const rows = (await pool.query('SELECT attempt,dispatched_at IS NOT NULL AS sent FROM processing_failures WHERE event_id=$1 ORDER BY attempt', [fact.id])).rows;
    expect(rows).toEqual([{ attempt: 1, sent: true }, { attempt: 2, sent: false }]);
  });
  it('preserves retry on Kafka failure and durably replays an exhausted event', async () => {
    const fact = event('booking.completed');
    await failures.record(fact, fact.id, fact.type, 'exhausted', true, 4);
    expect((await pool.query('SELECT 1 FROM dead_letters WHERE event_id=$1', [fact.id])).rowCount).toBe(1);
    await failures.replay(fact.id);
    send.mockRejectedValueOnce(new Error('broker down'));
    await expect(failures.pumpOnce()).rejects.toThrow('broker down');
    expect((await pool.query('SELECT dispatched_at FROM processing_failures WHERE event_id=$1', [fact.id])).rows[0].dispatched_at).toBeNull();
    await failures.pumpOnce();
    await processor.process(fact);
    expect((await pool.query('SELECT recovered_at IS NOT NULL AS recovered FROM dead_letters WHERE event_id=$1', [fact.id])).rows[0].recovered).toBe(true);
    await expect(failures.replay(fact.id)).rejects.toThrow('already processed');
  });
  it('recovers from Kafka acknowledgement loss before outbox commit without duplicate reports', async () => {
    const fact = event('booking.cancelled');
    await pool.query(`INSERT INTO outbox_events (id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
      VALUES ($1,'booking',$2,$3,$4::jsonb,$5)`, [fact.id,fact.aggregateId,fact.type,
      JSON.stringify({ ...fact.payload, tenantId: fact.tenantId, traceId: fact.traceId }),fact.occurredAt]);
    const deliveries: DomainEvent[] = [];
    let fail = true;
    const crashSend = vi.fn().mockImplementation(async ({ messages }) => {
      deliveries.push(...messages.map((message: { value: string }) => JSON.parse(message.value)));
      if (fail) { fail = false; throw new Error('ack lost after Kafka persisted batch'); }
      return [];
    });
    const publisher = new OutboxPublisher(pool, { send: crashSend } as unknown as Producer);
    await expect(publisher.publishBatch()).rejects.toThrow('ack lost');
    expect((await pool.query('SELECT published_at FROM outbox_events WHERE id=$1', [fact.id])).rows[0].published_at).toBeNull();
    await publisher.publishBatch();
    const sameFact = deliveries.filter((delivery) => delivery.id === fact.id);
    expect(sameFact).toHaveLength(2);
    expect(await processor.process(sameFact[0])).toBe('processed');
    expect(await processor.process(sameFact[1])).toBe('duplicate');
  });
  it('deduplicates malformed Kafka records with original evidence intact', async () => {
    const raw = { source: 'topic:2:7', raw: '{invalid-json' };
    await failures.record(raw, undefined, 'invalid-json', 'parse error', false, 0, raw.source);
    await failures.record(raw, undefined, 'invalid-json', 'parse error', false, 0, raw.source);
    const rows = (await pool.query('SELECT payload FROM dead_letters WHERE consumer_name=$1 AND event_id=$2', [consumer,sourceEventId(raw.source)])).rows;
    expect(rows).toEqual([{ payload: raw }]);
  });
});
