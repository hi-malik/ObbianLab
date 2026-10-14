import { createServer } from 'node:http';
import { parseEvent } from '@obbian/contracts';
import { Pool } from 'pg';
import { config } from './config';
import { createKafka, OutboxPublisher } from './outbox';
import { EventProcessor, PermanentEventError } from './processor';
import { FailureQueue } from './retry';

async function main() {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 15, connectionTimeoutMillis: 5000,
    query_timeout: 15_000, application_name: 'obbian-pipeline' });
  pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', component: 'postgres-pool', message: String(error) })));
  const kafka = createKafka();
  const producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
  const consumer = kafka.consumer({ groupId: config.consumerName, allowAutoTopicCreation: false });
  let ready = false;
  let stopping = false;
  let lastHeartbeat = Date.now();
  consumer.on(consumer.events.HEARTBEAT, () => { lastHeartbeat = Date.now(); });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    ready = false;
    console.error(JSON.stringify({ level: 'fatal', component: 'consumer', error: String(payload.error) }));
    // Crash must trigger container restart; a live but stopped consumer silently loses availability.
    process.exit(1);
  });
  const health = createServer(async (req, res) => {
    if (req.url !== '/health/live' && req.url !== '/health/ready') { res.writeHead(404).end(); return; }
    let healthy = !stopping;
    if (req.url === '/health/ready') {
      healthy = healthy && ready && Date.now() - lastHeartbeat < 45_000;
      if (healthy) { try { await pool.query('SELECT 1'); } catch { healthy = false; } }
    }
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }));
  }).listen(config.healthPort, '0.0.0.0');
  await producer.connect();
  await consumer.connect();
  // New groups must process durable backlog created before their first deployment.
  await consumer.subscribe({ topics: [config.eventTopic, config.retryTopic], fromBeginning: true });
  const outbox = new OutboxPublisher(pool, producer);
  const processor = new EventProcessor(pool, config.consumerName);
  const failures = new FailureQueue(pool, producer);
  let pumpRunning: Promise<unknown> | undefined;
  const retryTimer = setInterval(() => {
    if (!pumpRunning) pumpRunning = failures.pumpOnce().catch((error) => {
      console.error(JSON.stringify({ level: 'error', component: 'retry-pump', message: String(error) }));
    }).finally(() => { pumpRunning = undefined; });
  }, 500);
  const outboxTask = outbox.run();
  const shutdown = async () => {
    if (stopping) return;
    stopping = true; ready = false; clearInterval(retryTimer); outbox.stop();
    const deadline = setTimeout(() => process.exit(1), 25_000).unref();
    await consumer.stop();
    await consumer.disconnect();
    await Promise.all([outboxTask, pumpRunning]);
    await producer.disconnect();
    await pool.end();
    health.close(); clearTimeout(deadline);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await consumer.run({
    partitionsConsumedConcurrently: config.concurrency,
    eachMessage: async ({ topic, partition, message }) => {
      const source = `${topic}:${partition}:${message.offset}`;
      const attemptHeader = String(message.headers?.attempt ?? '0');
      const attempt = /^\d{1,3}$/.test(attemptHeader) ? Number(attemptHeader) : 0;
      let raw: unknown;
      try { raw = JSON.parse(message.value?.toString('utf8') ?? 'null'); }
      catch (error) {
        await failures.record({ source, raw: message.value?.toString('utf8') ?? null }, undefined, 'invalid-json', String(error), false, 0, source);
        return;
      }
      let event;
      try { event = parseEvent(raw); }
      catch (error) {
        const candidate = raw as { id?: string; type?: string } | undefined;
        await failures.record(raw, candidate?.id, candidate?.type, String(error), false, 0, source);
        return;
      }
      try { await processor.process(event); }
      catch (error) {
        await failures.record(raw, event.id, event.type, String(error), !(error instanceof PermanentEventError), attempt, source);
      }
    },
  });
  ready = true;
}
void main().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', message: String(error), stack: error?.stack }));
  process.exit(1);
});
