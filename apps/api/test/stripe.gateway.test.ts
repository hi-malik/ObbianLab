import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseStripeWebhook, StripeTestGateway } from '../src/payments/stripe.gateway';
const secret = 'whsec_test_secret';
const timestamp = 1900000000;
function signed(body: object) {
  const raw = JSON.stringify(body);
  return { raw, signature: `t=${timestamp},v1=${createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex')}` };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Stripe test mode gateway', () => {
  it('accepts signed snapshot capture events and rejects tampered/expired/live events', () => {
    const event = { id:'evt_1',livemode:false,type:'payment_intent.succeeded',data:{object:{id:'pi_1',amount_received:101,currency:'inr'}} };
    const {raw,signature} = signed(event);
    expect(parseStripeWebhook(raw,signature,secret,timestamp*1000)).toEqual({eventId:'evt_1',type:'payment.captured',gatewayPaymentId:'pi_1',amountMinor:101,currency:'INR'});
    expect(() => parseStripeWebhook(raw+' ',signature,secret,timestamp*1000)).toThrow('signature');
    expect(() => parseStripeWebhook(raw,signature,secret,(timestamp+301)*1000)).toThrow('tolerance');
    const live = signed({...event,livemode:true});
    expect(() => parseStripeWebhook(live.raw,live.signature,secret,timestamp*1000)).toThrow('test');
  });
  it('maps successful refund events with the stable refund business identity', () => {
    const event = signed({id:'evt_refund',livemode:false,type:'refund.updated',data:{object:{id:'re_1',status:'succeeded',payment_intent:'pi_1',amount:10,currency:'inr'}}});
    expect(parseStripeWebhook(event.raw,event.signature,secret,timestamp*1000)).toMatchObject({refundId:'re_1',gatewayPaymentId:'pi_1',type:'payment.refunded',amountMinor:10});
  });
  it('refuses live keys before making a network request', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY','sk_live_do_not_use');
    const fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    await expect(new StripeTestGateway().createPayment('payment-id','101','INR')).rejects.toThrow('test key');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reuses a stable gateway key after a timeout and restricts confirm to test payment method', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY','sk_test_example');
    const fetch = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({ok:true,json:async()=>({id:'pi_1',livemode:false,status:'requires_confirmation'})});
    vi.stubGlobal('fetch',fetch);
    const gateway = new StripeTestGateway();
    await expect(gateway.createPayment('internal-id','101','INR')).rejects.toThrow('same idempotency key');
    await gateway.createPayment('internal-id','101','INR');
    expect(fetch.mock.calls[0][1].headers['idempotency-key']).toBe(fetch.mock.calls[1][1].headers['idempotency-key']);
    await gateway.confirmPayment('pi_1','internal-id');
    expect(fetch.mock.calls[2][1].body).toBe('payment_method=pm_card_visa');
  });
  it('paginates the independent refund statement without silently truncating', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY','sk_test_example');
    const fetch = vi.fn()
      .mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'re_1'}],has_more:true})})
      .mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'re_2'}],has_more:false})});
    vi.stubGlobal('fetch',fetch);
    expect(await new StripeTestGateway().listRefunds('pi_1')).toEqual([{id:'re_1'},{id:'re_2'}]);
    expect(fetch.mock.calls[1][0]).toContain('starting_after=re_1');
  });
});

describe('Stripe Connect test transfers', () => {
  it('requires an operator configured destination and pins the transfer key/group', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY','sk_test_example');
    vi.stubEnv('STRIPE_CONNECT_DESTINATIONS',JSON.stringify({'professional-id':'acct_testDestination'}));
    const fetch = vi.fn().mockResolvedValue({ok:true,json:async()=>({id:'tr_1',livemode:false})});
    vi.stubGlobal('fetch',fetch);
    const gateway = new StripeTestGateway();
    expect(() => gateway.connectDestination('unknown')).toThrow('no configured');
    expect(gateway.connectDestination('professional-id')).toBe('acct_testDestination');
    await gateway.transfer('settlement-id','85','USD','acct_testDestination');
    expect(fetch.mock.calls[0][1].headers['idempotency-key']).toBe('obbian:settlement:settlement-id');
    const request = new URLSearchParams(fetch.mock.calls[0][1].body);
    expect(request.get('transfer_group')).toBe('obbian:settlement:settlement-id');
    expect(request.get('destination')).toBe('acct_testDestination');
  });
  it('recovers a known transfer by group and refuses ambiguous multiple transfers', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY','sk_test_example');
    const fetch = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'tr_1'}],has_more:false})})
      .mockResolvedValueOnce({ok:true,json:async()=>({data:[{id:'tr_1'},{id:'tr_2'}],has_more:false})});
    vi.stubGlobal('fetch',fetch);
    const gateway = new StripeTestGateway();
    expect(await gateway.findTransfer('settlement-id')).toEqual({id:'tr_1'});
    expect(fetch.mock.calls[0][0]).toContain('transfer_group=obbian%3Asettlement%3Asettlement-id');
    await expect(gateway.findTransfer('settlement-id')).rejects.toThrow('multiple');
  });
});
