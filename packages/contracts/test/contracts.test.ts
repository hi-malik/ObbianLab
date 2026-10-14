import { describe, expect, it } from 'vitest';
import { parseEvent } from '../src';
const id = '8b24dc93-0a03-4e1a-8867-0234520fc71f';
const bookingId = '286f88e9-c3b5-480a-b9f8-352126e78c42';
const tenantId = 'b257bfa9-ce90-4d4d-88b1-a1b958ee2d32';
const event = { id, type: 'payment.captured', schemaVersion: 1, aggregateId: id, tenantId,
  occurredAt: '2026-01-12T08:30:00+00:00', traceId: 'demo-1',
  payload: { paymentId: id, bookingId, amountMinor: 100, currency: 'INR', futureField: true } };

describe('event contracts', () => {
  it('preserves compatible extension fields while validating payment facts', () => {
    expect(parseEvent(event).payload.futureField).toBe(true);
  });
  it('rejects missing identity and unsupported event types', () => {
    expect(() => parseEvent({ type: 'booking.requested' })).toThrow();
    expect(() => parseEvent({ ...event, type: 'payment.unknown' })).toThrow();
  });
  it.each([NaN, Infinity, -1, 0, 1.5, 9007199254740992, 'NaN', '-1', '9223372036854775808'])(
    'rejects invalid or inexact amount %s', (amountMinor) => {
      expect(() => parseEvent({ ...event, payload: { ...event.payload, amountMinor } })).toThrow();
    });
  it('accepts exact bigint strings without rounding', () => {
    expect(parseEvent({ ...event, payload: { ...event.payload, amountMinor: '9007199254740993' } }).payload.amountMinor)
      .toBe('9007199254740993');
  });
  it('rejects cross-tenant and mismatched aggregate payloads', () => {
    expect(() => parseEvent({ ...event, payload: { ...event.payload, tenantId: id } })).toThrow();
    expect(() => parseEvent({ ...event, payload: { ...event.payload, paymentId: bookingId } })).toThrow();
  });
  it('does not accept empty booking or payment facts', () => {
    expect(() => parseEvent({ ...event, type: 'booking.requested', payload: {} })).toThrow();
    expect(() => parseEvent({ ...event, payload: {} })).toThrow();
  });
});
