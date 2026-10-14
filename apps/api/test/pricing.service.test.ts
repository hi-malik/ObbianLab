import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolClient } from 'pg';
import { configuredPrice, PricingService } from '../src/payments/pricing.service';
import { Database } from '../src/database';

const ctx = { tenantId: 'tenant', actorId: 'customer', roles: ['customer'], traceId: 'test' };
const policy = JSON.stringify({ electrician: { amountMinor: 12345, currency: 'inr' } });
afterEach(() => vi.unstubAllEnvs());

function fixture() {
  let stored: any = null;
  const query = vi.fn(async (sql: string, values: any[]) => {
    if (sql.includes('FROM bookings b')) return { rowCount: values[1] === ctx.tenantId && values[2] === ctx.actorId ? 1 : 0, rows: [{ slug: 'electrician' }] };
    if (sql.includes('FROM booking_quotes')) return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
    if (sql.includes('INSERT INTO booking_quotes')) {
      stored = { amount_minor: String(values[4]), currency: values[5], category_slug: values[3], created_at: new Date('2026-10-14T00:00:00Z') };
      return { rowCount: 1, rows: [stored] };
    }
    throw new Error('unexpected query');
  });
  const client = { query } as unknown as PoolClient;
  const database = { transaction: async (work: (client: PoolClient) => Promise<unknown>) => work(client) } as unknown as Database;
  return { client, service: new PricingService(database), query };
}

describe('trusted service price policy', () => {
  it('normalizes trusted currency and gives the same stable policy hash', () => {
    const price = configuredPrice('electrician', policy, false)!;
    expect(price.amountMinor).toBe(12345);
    expect(price.currency).toBe('INR');
    expect(price.policyHash).toHaveLength(64);
    expect(configuredPrice('electrician', policy, false)).toEqual(price);
  });

  it('fails closed for missing/invalid policy outside explicit demo', () => {
    expect(() => configuredPrice('electrician', '', false)).toThrow('not configured');
    expect(configuredPrice('electrician', '', true)).toBeNull();
    for (const value of ['invalid', 'null', '[]', '{}', '{"electrician":{"amountMinor":0,"currency":"INR"}}', '{"electrician":{"amountMinor":1.1,"currency":"INR"}}', '{"electrician":{"amountMinor":"100","currency":"INR"}}', '{"electrician":{"amountMinor":9007199254740992,"currency":"INR"}}']) {
      expect(() => configuredPrice('electrician', value, false)).toThrow();
    }
    expect(() => configuredPrice('plumber', policy, true)).toThrow('unavailable');
    expect(() => configuredPrice('constructor', policy, false)).toThrow('unavailable');
  });

  it('persists the quote once and preserves it across policy deployments', async () => {
    vi.stubEnv('AUTH_MODE', 'strict'); vi.stubEnv('SERVICE_PRICES_JSON', policy);
    const { service, query, client } = fixture();
    const initial = await service.quote(ctx, 'booking');
    vi.stubEnv('SERVICE_PRICES_JSON', JSON.stringify({ electrician: { amountMinor: 99999, currency: 'USD' } }));
    expect(await service.quote(ctx, 'booking')).toEqual(initial);
    await expect(service.validatePayment(client, ctx, 'booking', 12345, 'inr')).resolves.toBeUndefined();
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO booking_quotes'))).toHaveLength(1);
  });

  it('rejects amount and currency tampering', async () => {
    vi.stubEnv('AUTH_MODE', 'strict'); vi.stubEnv('SERVICE_PRICES_JSON', policy);
    const { service, client } = fixture();
    await expect(service.validatePayment(client, ctx, 'booking', 1, 'INR')).rejects.toThrow('server booking quote');
    await expect(service.validatePayment(client, ctx, 'booking', 12345, 'USD')).rejects.toThrow('server booking quote');
  });

  it('binds quote access to the booking tenant and owner', async () => {
    vi.stubEnv('SERVICE_PRICES_JSON', policy);
    const { service } = fixture();
    await expect(service.quote({ ...ctx, actorId: 'attacker' }, 'booking')).rejects.toThrow('not found');
    await expect(service.quote({ ...ctx, tenantId: 'other-tenant' }, 'booking')).rejects.toThrow('not found');
  });

  it('labels unpriced demo simulation and cannot override an already authoritative quote', async () => {
    vi.stubEnv('AUTH_MODE', 'demo'); vi.stubEnv('SERVICE_PRICES_JSON', '');
    const { service, client } = fixture();
    expect(await service.quote(ctx, 'booking')).toEqual({ bookingId: 'booking', amountMinor: null, currency: null, source: 'demo-client-amount' });
    await expect(service.validatePayment(client, ctx, 'booking', 101, 'USD')).resolves.toBeUndefined();
    vi.stubEnv('SERVICE_PRICES_JSON', policy);
    await service.quote(ctx, 'booking');
    vi.stubEnv('SERVICE_PRICES_JSON', '');
    await expect(service.validatePayment(client, ctx, 'booking', 101, 'USD')).rejects.toThrow('server booking quote');
  });
});
