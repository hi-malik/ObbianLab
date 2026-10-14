#!/usr/bin/env node
/** Real outbox -> Kafka -> PostgreSQL load/replay check. Requires a migrated scratch DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Pool } from 'pg';
import { Kafka, logLevel } from 'kafkajs';

const databaseUrl = process.env.PIPELINE_BENCHMARK_DATABASE_URL;
if (!databaseUrl || !/test|review|benchmark/.test(new URL(databaseUrl).pathname)) {
  throw new Error('PIPELINE_BENCHMARK_DATABASE_URL must name a migrated test/review/benchmark database');
}
const recordCount = Number(process.env.PIPELINE_BENCHMARK_RECORDS ?? 12000);
assert(Number.isSafeInteger(recordCount) && recordCount >= 60 && recordCount % 6 === 0);
const run = randomUUID();
const consumerName = `benchmark-${run}`;
const topics = ['events', 'retry', 'dlq'].map((kind) => `pipeline-benchmark-${kind}-${run}`);
const kafka = new Kafka({ clientId: consumerName, brokers: (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(','), logLevel: logLevel.ERROR });
const admin = kafka.admin();
const producer = kafka.producer({ idempotent: true });
const pool = new Pool({ connectionString: databaseUrl });
const tenant = randomUUID(), customer = randomUUID(), category = randomUUID();
const healthPort = Number(process.env.PIPELINE_BENCHMARK_HEALTH_PORT ?? 18090);
let worker;
let logs = '';
async function until(check, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (worker?.exitCode !== null && worker?.exitCode !== undefined) throw new Error(`worker exited: ${logs}`);
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${logs}`);
}
async function metrics() {
  return (await pool.query(`SELECT currency,sum(requested_count)::text AS requested,sum(completed_count)::text AS completed,
    sum(cancelled_count)::text AS cancelled,sum(gross_amount_minor)::text AS gross,sum(refund_amount_minor)::text AS refunded
    FROM daily_booking_metrics WHERE tenant_id=$1 GROUP BY currency ORDER BY currency`, [tenant])).rows;
}
try {
  await admin.connect(); await producer.connect();
  await admin.createTopics({ waitForLeaders: true, topics: topics.map((topic) => ({ topic, numPartitions: 12, replicationFactor: 1 })) });
  await pool.query('INSERT INTO tenants (id,name) VALUES ($1,$2)', [tenant,`pipeline benchmark ${run}`]);
  await pool.query("INSERT INTO app_users (id,tenant_id,external_subject,display_name,roles) VALUES ($1,$2,$3,'Benchmark',ARRAY['customer'])", [customer,tenant,customer]);
  await pool.query("INSERT INTO service_categories (id,tenant_id,slug,name) VALUES ($1,$2,'benchmark','Benchmark')", [category,tenant]);
  const bookings = Array.from({ length: recordCount / 3 }, () => randomUUID());
  await pool.query(`INSERT INTO bookings (id,tenant_id,customer_id,category_id,pickup,address,scheduled_for,expected_duration)
    SELECT id,$2,$3,$4,ST_SetSRID(ST_MakePoint(77,28),4326)::geography,'Benchmark',now(),interval '1 hour'
    FROM unnest($1::uuid[]) AS id`, [bookings,tenant,customer,category]);
  const events = [];
  for (let i = 0; i < bookings.length; i += 2) {
    const paymentId = randomUUID();
    for (const [type, bookingId] of [
      ['booking.requested',bookings[i]], ['booking.completed',bookings[i]],
      ['payment.captured',bookings[i]], ['payment.refunded',bookings[i]],
      ['booking.requested',bookings[i+1]], ['booking.cancelled',bookings[i+1]],
    ]) {
      const payload = { tenantId: tenant, bookingId, traceId: run };
      if (type === 'booking.requested') Object.assign(payload, { customerId: customer, categoryId: category, scheduledFor: '2026-01-01T00:00:00Z' });
      if (type.startsWith('payment.')) Object.assign(payload, { paymentId, amountMinor: type === 'payment.captured' ? 10000 : 2500, currency: 'INR' });
      events.push({ id: randomUUID(), type, schemaVersion: 1,
        aggregateId: type.startsWith('payment.') ? paymentId : bookingId,
        tenantId: tenant, occurredAt: '2026-01-01T00:00:00.000Z', traceId: run, payload });
    }
  }
  worker = spawn(process.execPath, ['services/pipeline/dist/index.js'], { env: { ...process.env,
    DATABASE_URL: databaseUrl, CONSUMER_NAME: consumerName, EVENT_TOPIC: topics[0], RETRY_TOPIC: topics[1], DLQ_TOPIC: topics[2],
    HEALTH_PORT: String(healthPort), CONSUMER_CONCURRENCY: '8' }, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [worker.stdout,worker.stderr]) stream.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${healthPort}/health/ready`)).ok; } catch { return false; } }, 60);
  const start = performance.now();
  for (let offset = 0; offset < events.length; offset += 500) {
    await pool.query(`INSERT INTO outbox_events (id,aggregate_type,aggregate_id,event_type,payload,occurred_at)
      SELECT id,split_part(type,'.',1),"aggregateId",type,payload,"occurredAt"
      FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,type text,"aggregateId" uuid,payload jsonb,"occurredAt" timestamptz)`,
    [JSON.stringify(events.slice(offset,offset+500))]);
  }
  await until(async () => Number((await pool.query('SELECT count(*) FROM consumer_inbox WHERE consumer_name=$1', [consumerName])).rows[0].count) === events.length);
  const elapsedSeconds = (performance.now() - start) / 1000;
  const before = await metrics();
  const groups = recordCount / 6;
  assert.deepEqual(before, [
    { currency: 'INR', requested: '0', completed: '0', cancelled: '0', gross: String(groups*10000), refunded: String(groups*2500) },
    { currency: 'XXX', requested: String(groups*2), completed: String(groups), cancelled: String(groups), gross: '0', refunded: '0' },
  ]);
  const duplicateCount = Math.floor(recordCount / 10);
  await producer.send({ topic: topics[0], acks: -1,
    messages: events.slice(0,duplicateCount).map((event) => ({ key: event.aggregateId, value: JSON.stringify(event) })) });
  // Wait for committed group offsets, proving duplicates actually reached the consumer.
  const offsets = await admin.fetchTopicOffsets(topics[0]);
  await until(async () => {
    const group = await admin.fetchOffsets({ groupId: consumerName, topics: [topics[0]] });
    const positions = group[0]?.partitions ?? [];
    return offsets.every((expected) => BigInt(positions.find((p) => p.partition === expected.partition)?.offset ?? '-1') >= BigInt(expected.offset));
  }, 30);
  assert.deepEqual(await metrics(), before);
  assert.equal(Number((await pool.query('SELECT count(*) FROM dead_letters WHERE consumer_name=$1', [consumerName])).rows[0].count), 0);
  const result = {
    measuredAt: new Date().toISOString(), status: 'passed', path: 'PostgreSQL outbox -> Kafka (12 partitions) -> PostgreSQL reporting',
    records: recordCount, duplicateDeliveries: duplicateCount, concurrency: 8,
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)), recordsPerSecond: Number((recordCount/elapsedSeconds).toFixed(2)),
    equivalentRecordsPerDay: Math.floor(recordCount/elapsedSeconds*86400), targetRecordsPerDay: 2000000,
    meetsAverageTarget: recordCount/elapsedSeconds >= 2000000/86400,
    aggregateRows: before, assertions: ['all six event facts accounted for', 'exact totals', '10% replay does not double count', 'no dead letters'],
    limits: 'Single local Redpanda broker and PostgreSQL; short synthetic run, not a 24-hour durability or AWS capacity certification.',
  };
  assert(result.meetsAverageTarget, 'measured throughput below 2M/day average');
  await mkdir('benchmarks/results', { recursive: true });
  await writeFile('benchmarks/results/pipeline-latest.json', JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  if (worker && worker.exitCode === null) { worker.kill('SIGTERM'); await once(worker,'exit'); }
  await producer.disconnect().catch(() => {});
  await admin.deleteTopics({ topics }).catch(() => {});
  await admin.disconnect().catch(() => {});
  await pool.end();
}
