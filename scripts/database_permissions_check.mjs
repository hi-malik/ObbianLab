#!/usr/bin/env node
/** End-to-end PostgreSQL bootstrap/grants check on an EMPTY migrated-test database.
 * DATABASE_PERMISSION_TEST_ADMIN_URL=postgres://.../roles_test node scripts/database_permissions_check.mjs
 * Test creates permanent test-only roles and schema; use a disposable PostgreSQL instance.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
const adminUrl = process.env.DATABASE_PERMISSION_TEST_ADMIN_URL;
if (!adminUrl || !/test|review/.test(new URL(adminUrl).pathname)) throw new Error('empty scratch test database required');
const prefix = 'review_'+randomBytes(4).toString('hex');
const keys = ['API','ALLOCATION','PIPELINE','AI','MIGRATION'];
const secret = Object.fromEntries(keys.map((key) => {
  const url = new URL(adminUrl); url.username = `${prefix}_${key.toLowerCase()}`; url.password = randomBytes(24).toString('hex');
  return [`${key}_DATABASE_URL`,url.toString()];
}));
const temporary = await mkdtemp(join(tmpdir(),'obbian-grants-'));
const pools = [];
try {
  const admin = new Pool({ connectionString:adminUrl }); pools.push(admin);
  const existing = await admin.query("SELECT 1 FROM pg_class WHERE oid=to_regclass('public.bookings')");
  assert.equal(existing.rowCount,0,'scratch database must be empty');
  const fakeAws = join(temporary,'aws');
  await writeFile(fakeAws,"#!/usr/bin/env node\nprocess.stdout.write(process.env.DATABASE_ROLE_FIXTURE);\n"); await chmod(fakeAws,0o700);
  execFileSync(process.execPath,['scripts/provision-database.mjs','--secret-id','fixture','--region','ap-south-1'], {
    env:{...process.env,PATH:temporary+':'+process.env.PATH,DATABASE_ADMIN_URL:adminUrl,DATABASE_ROLE_FIXTURE:JSON.stringify(secret)},stdio:['ignore','pipe','pipe'],
  });
  const migrator = new Pool({ connectionString:secret.MIGRATION_DATABASE_URL,max:1 }); pools.push(migrator);
  for (const file of (await readdir('db/migrations')).filter((file) => file.endsWith('.sql')).sort()) {
    await migrator.query(await readFile(join('db/migrations',file),'utf8'));
  }
  for (const key of keys.slice(0,4)) await migrator.query('SELECT set_config($1,$2,false)',[`obbian.role.${key.toLowerCase()}`,`${prefix}_${key.toLowerCase()}`]);
  await migrator.query(await readFile('db/provision-runtime.sql','utf8'));
  let assertions = 0;
  async function denied(pool,statement) {
    await assert.rejects(pool.query(statement), (error) => error.code === '42501'); assertions++;
  }
  for (const key of keys.slice(0,4)) {
    const pool = new Pool({ connectionString:secret[`${key}_DATABASE_URL`] }); pools.push(pool);
    await denied(pool,'CREATE TABLE public.unauthorized (id int)');
    if (key === 'API') {
      await pool.query('SELECT * FROM bookings LIMIT 0'); assertions++;
      await denied(pool,'UPDATE ledger_entries SET amount_minor=amount_minor');
      await pool.query('SELECT * FROM booking_quotes LIMIT 0'); assertions++;
      await denied(pool,'UPDATE booking_quotes SET amount_minor=amount_minor');
      await denied(pool,'SELECT * FROM ai_conversations LIMIT 0');
    }
    if (key === 'ALLOCATION') {
      await pool.query('SELECT id FROM professionals FOR UPDATE'); assertions++;
      await denied(pool,'SELECT * FROM payment_intents LIMIT 0');
    }
    if (key === 'PIPELINE') {
      await pool.query('SELECT * FROM bookings LIMIT 0'); assertions++;
      await pool.query('DELETE FROM processing_failures WHERE false'); assertions++;
      await denied(pool,'UPDATE bookings SET status=status');
      await denied(pool,'SELECT * FROM ledger_entries LIMIT 0');
    }
    if (key === 'AI') {
      await pool.query('SELECT id,tenant_id,roles FROM app_users LIMIT 0'); assertions++;
      await denied(pool,'SELECT external_subject FROM app_users LIMIT 0');
      await pool.query('SELECT * FROM knowledge_documents LIMIT 0'); assertions++;
      await denied(pool,'UPDATE bookings SET status=status');
      await denied(pool,'SELECT * FROM ledger_entries LIMIT 0');
      await denied(pool,'INSERT INTO outbox_events DEFAULT VALUES');
      await denied(pool,'SELECT * FROM booking_quotes LIMIT 0');
    }
  }
  console.log(JSON.stringify({status:'passed',assertions,checks:'real role bootstrap, owner migrations, service grants, cross-service denials and DDL denial'}));
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
  await rm(temporary,{recursive:true,force:true});
}
