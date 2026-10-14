import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/database';
import { PricingService } from '../src/payments/pricing.service';

const url = process.env.TEST_DATABASE_URL;
describe.runIf(!!url)('authoritative booking quotes in PostgreSQL', () => {
  const pool = new Pool({ connectionString: url, max: 10 });
  const database = new Database(pool);
  const pricing = new PricingService(database);
  const tenant = randomUUID(), customer = randomUUID(), category = randomUUID(), booking = randomUUID();
  const ctx = { tenantId: tenant, actorId: customer, roles: ['customer'], traceId: 'pricing-integration' };
  beforeAll(async () => {
    vi.stubEnv('AUTH_MODE', 'strict');
    vi.stubEnv('SERVICE_PRICES_JSON', JSON.stringify({ electrician: { amountMinor: 2500, currency: 'INR' } }));
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Pricing integration')", [tenant]);
    await pool.query("INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES($1,$2,$3,'Pricing customer',ARRAY['customer'])", [customer, tenant, customer]);
    await pool.query("INSERT INTO service_categories(id,tenant_id,slug,name) VALUES($1,$2,'electrician','Electrician')", [category, tenant]);
    await pool.query(`INSERT INTO bookings(id,tenant_id,customer_id,category_id,pickup,address,scheduled_for,status)
      VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint(77,28),4326)::geography,'Pricing test',now()+interval '1 day','confirmed')`,
      [booking, tenant, customer, category]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM payment_intents WHERE booking_id=$1', [booking]);
    await pool.query('DELETE FROM booking_quotes WHERE booking_id=$1', [booking]);
    await pool.query('DELETE FROM bookings WHERE id=$1', [booking]);
    await pool.query('DELETE FROM service_categories WHERE id=$1', [category]);
    await pool.query('DELETE FROM app_users WHERE id=$1', [customer]);
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenant]);
    vi.unstubAllEnvs();
    await pool.end();
  });

  it('serializes simultaneous quote creation and preserves policy across changes', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => pricing.quote(ctx, booking)));
    expect(results.every(quote => quote.amountMinor === 2500 && quote.currency === 'INR')).toBe(true);
    expect(Number((await pool.query('SELECT count(*) FROM booking_quotes WHERE booking_id=$1', [booking])).rows[0].count)).toBe(1);
    vi.stubEnv('SERVICE_PRICES_JSON', JSON.stringify({ electrician: { amountMinor: 9999, currency: 'USD' } }));
    expect(await pricing.quote(ctx, booking)).toEqual(results[0]);
  });

  it('rejects cross-tenant access and payment tampering before gateway work', async () => {
    await expect(pricing.quote({ ...ctx, tenantId: randomUUID() }, booking)).rejects.toThrow('not found');
    await expect(database.transaction(client => pricing.validatePayment(client, ctx, booking, 1, 'INR'))).rejects.toThrow('server booking quote');
    await expect(database.transaction(client => pricing.validatePayment(client, ctx, booking, 2500, 'USD'))).rejects.toThrow('server booking quote');
    await expect(database.transaction(client => pricing.validatePayment(client, ctx, booking, 2500, 'INR'))).resolves.toBeUndefined();
  });

  it('database guards stop changing quotes or posting mismatched payment amounts', async () => {
    await expect(pool.query('UPDATE booking_quotes SET amount_minor=1 WHERE booking_id=$1', [booking])).rejects.toThrow('immutable');
    const insert = `INSERT INTO payment_intents(tenant_id,booking_id,gateway,gateway_payment_id,idempotency_key,currency,amount_minor)
      VALUES($1,$2,'sandbox',$3,$4,'INR',$5)`;
    await expect(pool.query(insert, [tenant, booking, `sbx_${randomUUID()}`, randomUUID(), 1])).rejects.toThrow('authoritative booking quote');
    await expect(pool.query(insert, [tenant, booking, `sbx_${randomUUID()}`, randomUUID(), 2500])).resolves.toBeDefined();
  });
});
