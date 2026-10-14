import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhookSignature } from '../src/payments/signature';

describe('sandbox webhook signatures', () => {
  it('accepts the exact signed payload', () => {
    const body = JSON.stringify({ eventId: 'evt_1', amountMinor: 1000 });
    expect(verifyWebhookSignature(body, signWebhook(body, 'secret'), 'secret')).toBe(true);
  });

  it('rejects malformed and modified signatures without throwing', () => {
    const body = '{}';
    expect(verifyWebhookSignature(body, 'nope', 'secret')).toBe(false);
    expect(verifyWebhookSignature('{"changed":true}', signWebhook(body, 'secret'), 'secret')).toBe(false);
  });
});
