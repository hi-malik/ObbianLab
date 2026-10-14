import { describe, expect, it } from 'vitest';
import { metricDeltas, retryDelayMs } from '../src/processor';

describe('pipeline policies', () => {
  it('maps facts to additive metric deltas', () => {
    expect(metricDeltas('booking.completed')).toEqual({ requested: 0, completed: 1, cancelled: 0, gross: 0, refund: 0 });
    expect(metricDeltas('payment.refunded').refund).toBe(1);
    expect(metricDeltas('booking.offer.created').requested).toBe(0);
  });

  it('uses bounded exponential backoff', () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(5)).toBe(16000);
    expect(retryDelayMs(20)).toBe(60000);
  });
});
