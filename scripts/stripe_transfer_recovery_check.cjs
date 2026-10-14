/* Run against the built API container:
 * docker compose exec -T api node < scripts/stripe_transfer_recovery_check.cjs
 * PostgreSQL/ledger are real; only the external Stripe transport is simulated.
 * No external API or live financial action occurs.
 */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { Database } = require('./dist/database');
const { PaymentService } = require('./dist/payments/payment.service');
async function main() {
  assert.ok(!process.env.STRIPE_SECRET_KEY, 'Run the mocked transport regression only on the credential-free local stack');
  const pool = new Pool({connectionString:process.env.DATABASE_URL});
  const db = new Database(pool);
  const [tenant,user,professional,professionalAccount,gatewayAccount,transaction] = Array.from({length:6},()=>randomUUID());
  await db.transaction(async client => {
    await client.query('INSERT INTO tenants(id,name) VALUES ($1,$2)',[tenant,'Stripe transfer recovery regression']);
    await client.query("INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES ($1,$2,'pro','Regression professional',ARRAY['professional','finance'])",[user,tenant]);
    await client.query('INSERT INTO professionals(id,tenant_id,user_id) VALUES ($1,$2,$3)',[professional,tenant,user]);
    await client.query(`INSERT INTO ledger_accounts(id,tenant_id,owner_type,owner_id,code,currency) VALUES
      ($1,$3,'professional',$4,'professional_payable:stripe_test','USD'),
      ($2,$3,'gateway',$3,'gateway_clearing:stripe_test','USD')`,[professionalAccount,gatewayAccount,tenant,professional]);
    await client.query("INSERT INTO ledger_transactions(id,tenant_id,reference_type,reference_id,kind,idempotency_key) VALUES ($1,$2,'regression',$1,'fixture','fixture')",[transaction,tenant]);
    await client.query(`INSERT INTO ledger_entries(transaction_id,account_id,direction,amount_minor,currency) VALUES
      ($1,$2,'debit',85,'USD'),($1,$3,'credit',85,'USD')`,[transaction,gatewayAccount,professionalAccount]);
  });
  process.env.PAYMENT_GATEWAY='stripe_test';
  const ctx={tenantId:tenant,actorId:user,roles:['finance'],traceId:randomUUID()};
  const key=randomUUID();
  const dto={professionalId:professional,currency:'USD',periodStart:new Date(Date.now()-86400000).toISOString(),periodEnd:new Date(Date.now()+1000).toISOString()};
  let remote = null; let remoteTransferCalls=0;
  const stripe={
    connectDestination:()=> 'acct_regression',
    findTransfer:async()=>remote,
    transfer:async(id,amount,currency,destination)=>{
      remoteTransferCalls++;
      remote={id:'tr_regression_'+id,livemode:false,amount:Number(amount),currency:currency.toLowerCase(),destination,amount_reversed:0,reversed:false};
      throw new Error('simulated crash after gateway transfer, before local response');
    },
  };
  function service() { const app=new PaymentService(db,{validatePayment:async()=>{}}); app.stripe=stripe; return app; }
  await assert.rejects(service().createSettlement(ctx,key,dto),/simulated crash/);
  const held = await db.query('SELECT * FROM settlements WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key]);
  assert.equal(held.rows[0].status,'submitted');
  const balance=await db.query("SELECT sum(CASE WHEN direction='credit' THEN amount_minor ELSE -amount_minor END)::text AS amount FROM ledger_entries WHERE account_id=$1",[professionalAccount]);
  assert.equal(balance.rows[0].amount,'0');
  await assert.rejects(service().createSettlement(ctx,randomUUID(),dto),/no unsettled earnings/);
  // Removing current configuration must not change an already persisted payee.
  stripe.connectDestination=()=>{throw new Error('mapping removed after reservation');};
  const recovered=await service().createSettlement(ctx,key,dto);
  assert.equal(recovered.status,'paid'); assert.equal(recovered.gatewayPayoutId,remote.id);
  assert.deepEqual(await service().createSettlement(ctx,key,dto),recovered);
  assert.equal(remoteTransferCalls,1);
  const pending=await db.query(`SELECT sum(CASE WHEN e.direction='credit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS amount
    FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.account_id WHERE a.tenant_id=$1 AND a.code='settlement_pending:stripe_test'`,[tenant]);
  assert.equal(pending.rows[0].amount,'0');
  const posts=await db.query("SELECT kind,count(*)::int AS count FROM ledger_transactions WHERE reference_id=$1 GROUP BY kind",[recovered.id]);
  assert.deepEqual(Object.fromEntries(posts.rows.map(r=>[r.kind,r.count])),{settlement_reserved:1,settlement:1});
  stripe.connectDestination=()=> 'acct_regression';
  await assert.rejects(service().createSettlement(ctx,randomUUID(),dto),/no unsettled earnings/);
  console.log(JSON.stringify({status:'passed',tenantId:tenant,settlementId:recovered.id,remoteTransferCalls,
    checks:['durable pending reservation after post-transfer crash','restart recovers existing gateway transfer','one reserve and one final ledger post','retry/new key cannot transfer twice','pending reservation blocks competing key','persisted destination survives configuration change'],externalGateway:'simulated transport; real PostgreSQL'},null,2));
  await pool.end();
}
main().catch(error=>{console.error(error);process.exit(1);});
