import { createHmac } from 'node:crypto';
const [actorId, tenantId] = process.argv.slice(2);
const secret = process.env.AUTH_SIGNING_SECRET;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!secret || secret.length < 32 || !uuid.test(actorId) || !uuid.test(tenantId)) {
  console.error('Set AUTH_SIGNING_SECRET (32+ characters), then node scripts/issue-token.mjs ACTOR_UUID TENANT_UUID. Only issue tokens for verified, provisioned users.');
  process.exit(1);
}
const encode = x => Buffer.from(JSON.stringify(x)).toString('base64url');
const body = `${encode({ alg:'HS256', typ:'JWT' })}.${encode({ sub:actorId, tenantId, aud:'obbian', exp:Math.floor(Date.now()/1000)+3600 })}`;
process.stdout.write(`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}\n`);
