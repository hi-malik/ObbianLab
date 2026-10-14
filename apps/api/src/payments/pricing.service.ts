import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { RequestContextValue } from '../auth/request-context';
import { Database } from '../database';

export type ServicePrice = { amountMinor: number; currency: string; policyHash: string };
export type BookingQuote = { bookingId: string; category: string; amountMinor: number; currency: string; source: 'server-policy'; createdAt: Date };

/** The trusted deployment policy is a flat fee per booking/category, in minor units. */
export function configuredPrice(category: string, raw = process.env.SERVICE_PRICES_JSON, demo = process.env.AUTH_MODE === 'demo'): ServicePrice | null {
  if (!raw?.trim()) {
    if (demo) return null;
    throw new ServiceUnavailableException('Server pricing is not configured for this service');
  }
  let policy: Record<string, unknown>;
  try { policy = JSON.parse(raw); }
  catch { throw new ServiceUnavailableException('Server pricing configuration is invalid'); }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new ServiceUnavailableException('Server pricing configuration is invalid');
  const price = Object.hasOwn(policy, category) ? policy[category] as { amountMinor?: unknown; currency?: unknown } : undefined;
  if (!price || typeof price !== 'object' || Array.isArray(price)
      || !Number.isSafeInteger(price.amountMinor) || Number(price.amountMinor) <= 0
      || typeof price.currency !== 'string' || !/^[A-Za-z]{3}$/.test(price.currency)) {
    throw new ServiceUnavailableException('Server pricing is unavailable for this service');
  }
  const amountMinor = price.amountMinor as number, currency = price.currency.toUpperCase();
  return { amountMinor, currency, policyHash: createHash('sha256').update(JSON.stringify({ category, amountMinor, currency })).digest('hex') };
}

@Injectable()
export class PricingService {
  constructor(private readonly database: Database) {}

  async quote(ctx: RequestContextValue, bookingId: string) {
    return this.database.transaction(async client => {
      const quote = await this.ensureQuote(client, ctx, bookingId);
      return quote ?? { bookingId, amountMinor: null, currency: null, source: 'demo-client-amount' };
    });
  }

  async validatePayment(client: PoolClient, ctx: RequestContextValue, bookingId: string, amountMinor: number, currency: string): Promise<void> {
    const quote = await this.ensureQuote(client, ctx, bookingId);
    if (quote && (quote.amountMinor !== amountMinor || quote.currency !== currency.toUpperCase())) {
      throw new ConflictException('Payment amount and currency must match the server booking quote');
    }
  }

  private async ensureQuote(client: PoolClient, ctx: RequestContextValue, bookingId: string): Promise<BookingQuote | null> {
    // All creators lock the booking first. This gives a single immutable price
    // even across replicas or a policy deployment while requests are in flight.
    const booking = await client.query<{ slug: string }>(`SELECT c.slug FROM bookings b
      JOIN service_categories c ON c.id=b.category_id AND c.tenant_id=b.tenant_id
      WHERE b.id=$1 AND b.tenant_id=$2 AND b.customer_id=$3 FOR UPDATE OF b`,
      [bookingId, ctx.tenantId, ctx.actorId]);
    if (!booking.rowCount) throw new NotFoundException('booking not found');
    const stored = await client.query<{ amount_minor: string; currency: string; category_slug: string; created_at: Date }>(
      'SELECT amount_minor,currency,category_slug,created_at FROM booking_quotes WHERE booking_id=$1 AND tenant_id=$2 AND customer_id=$3',
      [bookingId, ctx.tenantId, ctx.actorId]);
    if (stored.rowCount) {
      const value = stored.rows[0];
      return { bookingId, category: value.category_slug, amountMinor: Number(value.amount_minor), currency: value.currency, source: 'server-policy', createdAt: value.created_at };
    }
    const category = booking.rows[0].slug;
    const price = configuredPrice(category);
    if (!price) return null; // AUTH_MODE=demo, with no configured policy only.
    const saved = await client.query<{ created_at: Date }>(`INSERT INTO booking_quotes
      (booking_id,tenant_id,customer_id,category_slug,amount_minor,currency,policy_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
      [bookingId, ctx.tenantId, ctx.actorId, category, price.amountMinor, price.currency, price.policyHash]);
    return { bookingId, category, amountMinor: price.amountMinor, currency: price.currency, source: 'server-policy', createdAt: saved.rows[0].created_at };
  }
}
