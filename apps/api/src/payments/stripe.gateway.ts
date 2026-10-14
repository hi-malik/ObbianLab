import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../auth/identity';
import { SandboxWebhookDto } from './payment.dto';

// Deliberately test-mode-only. No raw card numbers or live gateway keys accepted.
export class StripeTestGateway {
  private async request(path: string, method: 'GET' | 'POST', values?: Record<string,string>, key?: string): Promise<any> {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret?.startsWith('sk_test_')) throw new ServiceUnavailableException('Stripe test key is not configured');
    let response: Response;
    try {
      response = await fetch(`https://api.stripe.com/v1/${path}`, {
        method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded',
          ...(key ? { 'idempotency-key': key } : {}) },
        ...(values ? { body: new URLSearchParams(values).toString() } : {}),
        signal: AbortSignal.timeout(10000),
      });
    } catch { throw new ServiceUnavailableException('Stripe request incomplete; retry with the same idempotency key'); }
    const body: any = await response.json();
    if (!response.ok) {
      if (response.status === 400 || response.status === 402) throw new BadRequestException(`Stripe test request rejected: ${body.error?.code ?? 'invalid_request'}`);
      throw new ServiceUnavailableException('Stripe request unavailable; retry with the same idempotency key');
    }
    if (body.livemode === true) throw new ServiceUnavailableException('live gateway objects are not allowed');
    return body;
  }
  connectDestination(professionalId: string): string {
    if (!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) throw new ServiceUnavailableException('Stripe test key is not configured');
    let destinations: Record<string,string>;
    try { destinations = JSON.parse(process.env.STRIPE_CONNECT_DESTINATIONS ?? '{}'); }
    catch { throw new ServiceUnavailableException('Stripe Connect destination configuration is invalid'); }
    const destination = destinations[professionalId];
    if (!/^acct_[a-zA-Z0-9]+$/.test(destination ?? '')) throw new ServiceUnavailableException('professional has no configured Stripe Connect test destination');
    return destination;
  }
  transfer(settlementId: string, amount: string, currency: string, destination: string) {
    return this.request('transfers','POST',{amount,currency:currency.toLowerCase(),destination,
      transfer_group:`obbian:settlement:${settlementId}`,'metadata[obbian_settlement_id]':settlementId},`obbian:settlement:${settlementId}`);
  }
  async findTransfer(settlementId: string) {
    const result = await this.request(`transfers?${new URLSearchParams({transfer_group:`obbian:settlement:${settlementId}`,limit:'100'})}`,'GET');
    if (result.has_more || result.data.length > 1) throw new ServiceUnavailableException('multiple gateway transfers require manual reconciliation');
    return result.data[0] ?? null;
  }
  createPayment(paymentId: string, amount: string, currency: string) {
    return this.request('payment_intents', 'POST', {
      amount, currency: currency.toLowerCase(), 'payment_method_types[0]': 'card',
      'metadata[obbian_payment_id]': paymentId,
    }, `obbian:payment:${paymentId}`);
  }
  confirmPayment(gatewayId: string, paymentId: string) {
    return this.request(`payment_intents/${encodeURIComponent(gatewayId)}/confirm`, 'POST', { payment_method: 'pm_card_visa' }, `obbian:confirm:${paymentId}`);
  }
  refund(gatewayId: string, amount: number, operationId: string) {
    return this.request('refunds', 'POST', { payment_intent: gatewayId, amount: String(amount), 'metadata[obbian_operation_id]': operationId }, `obbian:refund:${operationId}`);
  }
  retrievePayment(gatewayId: string) { return this.request(`payment_intents/${encodeURIComponent(gatewayId)}`, 'GET'); }
  async listRefunds(gatewayId: string) {
    const rows: any[] = []; let after = '';
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({ payment_intent: gatewayId, limit: '100', ...(after ? { starting_after: after } : {}) });
      const result = await this.request(`refunds?${params}`, 'GET');
      rows.push(...result.data);
      if (!result.has_more) return rows;
      after = result.data.at(-1).id;
    }
    throw new ServiceUnavailableException('refund statement exceeds reconciliation page limit');
  }
}

export function parseStripeWebhook(rawBody: string, signature: string | undefined, secret: string | undefined, now = Date.now()): SandboxWebhookDto | null {
  if (!signature || !secret?.startsWith('whsec_')) throw new UnauthorizedException('Stripe webhook secret/signature is missing');
  const parts = signature.split(',').map((part) => part.trim().split('='));
  const timestamp = Number(parts.find(([kind]) => kind === 't')?.[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) throw new UnauthorizedException('Stripe webhook timestamp is outside tolerance');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (!parts.some(([kind,value]) => kind === 'v1' && !!value && constantTimeEqual(value,expected))) throw new UnauthorizedException('invalid Stripe webhook signature');
  let event: any;
  try { event = JSON.parse(rawBody); } catch { throw new BadRequestException('invalid Stripe event JSON'); }
  if (event.livemode !== false || !event.id || !event.data?.object) throw new BadRequestException('only Stripe test snapshot events are accepted');
  const object = event.data.object;
  let type: SandboxWebhookDto['type']; let gatewayPaymentId: string; let amount: number; let refundId: string | undefined;
  if (event.type === 'payment_intent.succeeded') { type = 'payment.captured'; gatewayPaymentId = object.id; amount = object.amount_received; }
  else if (event.type === 'payment_intent.payment_failed') { type = 'payment.failed'; gatewayPaymentId = object.id; amount = object.amount; }
  else if (event.type === 'payment_intent.amount_capturable_updated') { type = 'payment.authorized'; gatewayPaymentId = object.id; amount = object.amount; }
  else if (['refund.created','refund.updated'].includes(event.type) && object.status === 'succeeded') {
    type = 'payment.refunded'; gatewayPaymentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
    amount = object.amount; refundId = object.id;
  } else return null;
  if (!gatewayPaymentId || !Number.isSafeInteger(amount) || amount <= 0 || !/^[a-zA-Z]{3}$/.test(object.currency ?? '')) throw new BadRequestException('invalid Stripe money event');
  return { eventId: event.id, type, gatewayPaymentId, amountMinor: amount, currency: object.currency.toUpperCase(), ...(refundId ? { refundId } : {}) };
}
