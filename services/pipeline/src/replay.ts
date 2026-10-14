import { Pool } from 'pg';
import { config } from './config';
import { createKafka } from './outbox';
import { FailureQueue } from './retry';

async function main() {
  const id = process.argv[2];
  if (!id) throw new Error('usage: npm run replay -w @obbian/pipeline -- EVENT_UUID');
  const pool = new Pool({ connectionString: config.databaseUrl });
  // Replay is durably queued in PostgreSQL; the running worker publishes it.
  try {
    await new FailureQueue(pool, createKafka().producer()).replay(id);
    console.log(JSON.stringify({ status: 'queued', eventId: id }));
  } finally { await pool.end(); }
}
void main().catch((error) => { console.error(String(error)); process.exitCode = 1; });
