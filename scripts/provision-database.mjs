#!/usr/bin/env node
/** One-time privileged bootstrap. Run from a trusted host with VPC DB reachability.
 * DATABASE_ADMIN_URL=... node scripts/provision-database.mjs --secret-id ARN --region REGION
 * Secret must contain {API,ALLOCATION,PIPELINE,AI,MIGRATION}_DATABASE_URL.
 * No passwords, URL values or raw database errors are printed.
 */
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) =>
  i % 2 === 0 ? [...pairs,[value.replace(/^--/,''),all[i+1]]] : pairs, []));
const keys = ['API','ALLOCATION','PIPELINE','AI','MIGRATION'];
const quoteIdentifier = (value) => '"'+value.replaceAll('"','""')+'"';
const quoteLiteral = (value) => "'"+value.replaceAll("'","''")+"'";
let pool;
try {
  if (!flags['secret-id'] || !flags.region || !process.env.DATABASE_ADMIN_URL) throw new Error('bootstrap inputs missing');
  const secret = JSON.parse(execFileSync('aws',['secretsmanager','get-secret-value','--secret-id',flags['secret-id'],
    '--region',flags.region,'--query','SecretString','--output','text'], { encoding:'utf8',stdio:['ignore','pipe','pipe'] }));
  const adminUrl = new URL(process.env.DATABASE_ADMIN_URL);
  const identities = keys.map((key) => {
    const url = new URL(secret[`${key}_DATABASE_URL`]);
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !/^[a-z][a-z0-9_]{2,62}$/.test(user)
      || user.startsWith('pg_') || user === decodeURIComponent(adminUrl.username) || password.length < 32
      || url.hostname !== adminUrl.hostname || (url.port || '5432') !== (adminUrl.port || '5432') || url.pathname !== adminUrl.pathname) {
      throw new Error('invalid database identity configuration');
    }
    return { key,user,password };
  });
  if (new Set(identities.map(({user}) => user)).size !== keys.length) throw new Error('database users must be distinct');
  if (/\.rds\.amazonaws\.com(?:\.cn)?$/.test(adminUrl.hostname)) {
    adminUrl.searchParams.set('sslmode','verify-full');
    adminUrl.searchParams.set('sslrootcert',fileURLToPath(new URL('../infra/certs/global-bundle.pem',import.meta.url)));
  }
  pool = new Pool({ connectionString: adminUrl.toString(), max:1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(713648211)');
    for (const extension of ['pgcrypto','postgis','btree_gist','vector']) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)}`);
    }
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    const database = decodeURIComponent(adminUrl.pathname.slice(1));
    for (const {user,password} of identities) {
      const existing = await client.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[user]);
      if (existing.rows.some((role) => role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls)) {
        throw new Error('refusing to repurpose a privileged database role');
      }
      if (!existing.rowCount) await client.query(`CREATE ROLE ${quoteIdentifier(user)} NOLOGIN`);
      await client.query(`ALTER ROLE ${quoteIdentifier(user)} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(password)}`);
      const member = await client.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[user]);
      if (member.rowCount) throw new Error('runtime/migration roles must not inherit additional memberships');
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(user)}`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(user)}`);
      await client.query(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(user)}`);
      await client.query(`ALTER ROLE ${quoteIdentifier(user)} SET search_path=public`);
    }
    const migrator = identities.find(({key}) => key === 'MIGRATION').user;
    await client.query(`GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(migrator)}`);
    await client.query('COMMIT');
    console.log('Database identities and extensions bootstrapped. Deploy migrations next; runtime grants are applied by the deployment job.');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
} catch(error) {
  console.error('Database bootstrap failed. Check inputs, distinct roles, administrator privileges, AWS secret access and database connectivity. No secret values were logged.');
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
