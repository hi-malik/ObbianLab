import { describe, expect, it } from 'vitest';
import { canTransition, isOfferAcceptable, requireTransition } from '../src/bookings/booking.domain';

describe('booking state machine', () => {
  it('does not revive terminal bookings', () => {
    expect(canTransition('completed', 'confirmed')).toBe(false);
    expect(() => requireTransition('cancelled', 'requested')).toThrow(/invalid/);
  });

  it('treats an offer expiring exactly now as expired', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    expect(isOfferAcceptable('pending', now, now)).toBe(false);
    expect(isOfferAcceptable('pending', new Date(now.getTime() + 1), now)).toBe(true);
    expect(isOfferAcceptable('rejected', new Date(now.getTime() + 1), now)).toBe(false);
  });
});
