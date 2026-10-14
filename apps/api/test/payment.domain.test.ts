import { describe, expect, it } from 'vitest';
import { splitAmount, splitRefund } from '../src/payments/payment.domain';

describe('commission split', () => {
  it('keeps every minor unit and rounds commission down deterministically', () => {
    expect(splitAmount(101)).toEqual({ commissionMinor: 15, professionalMinor: 86 });
    const split = splitAmount(Number.MAX_SAFE_INTEGER);
    expect(split.commissionMinor + split.professionalMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reverses the exact original commission across fragmented partial refunds', () => {
    let refunded = 0; let commission = 0; let earnings = 0;
    for (const amount of [1, 2, 3, 17, 78]) {
      const split = splitRefund(refunded, amount);
      commission += split.commissionMinor; earnings += split.professionalMinor; refunded += amount;
    }
    expect({ commissionMinor: commission, professionalMinor: earnings }).toEqual(splitAmount(101));
  });

  it('rejects unsafe or invalid inputs', () => {
    expect(() => splitAmount(0)).toThrow();
    expect(() => splitAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => splitAmount(100, 10_001)).toThrow();
  });
});
