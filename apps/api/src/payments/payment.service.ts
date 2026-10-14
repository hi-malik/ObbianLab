import { ConflictException, Injectable, NotFoundException, UnauthorizedException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { RequestContextValue } from '../auth/request-context';
import { Database } from '../database';
import { CreatePaymentDto, CreateSettlementDto, SandboxWebhookDto } from './payment.dto';
import { verifyWebhookSignature } from './signature';
import { splitAmount, splitRefund } from './payment.domain';
import { parseStripeWebhook, StripeTestGateway } from './stripe.gateway';
import { PricingService } from './pricing.service';

interface PaymentRow {
  id: string;
  gateway: string;
  tenant_id: string;
  booking_id: string;
  amount_minor: string;
  refunded_minor: string;
  currency: string;
  status: string;
  professional_id: string | null;
}

@Injectable()
export class PaymentService implements OnModuleInit, OnModuleDestroy {
  private retryTimer?: ReturnType<typeof setInterval>;
  private recovering = false;
  private readonly stripe = new StripeTestGateway();
  onModuleInit() {
    this.retryTimer = setInterval(() => { void this.recoverPendingWebhooks(); }, 2000);
    this.retryTimer.unref();
  }
  onModuleDestroy() { if (this.retryTimer) clearInterval(this.retryTimer); }
  private async recoverPendingWebhooks() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const pending = await this.database.query<{ gateway_event_id: string; gateway: string }>(`SELECT gateway_event_id,gateway
        FROM payment_webhook_inbox WHERE processed_at IS NULL
          AND processing_attempts < 20 AND next_attempt_at <= now() ORDER BY received_at LIMIT 25`);
      for (const event of pending.rows) {
        try { await this.processWebhook(event.gateway_event_id,event.gateway); } catch { /* durable error retained for reconciliation */ }
      }
      const settlements = await this.database.query<{id:string}>(`SELECT s.id FROM settlements s
        JOIN idempotency_keys k ON k.tenant_id=s.tenant_id AND k.scope='stripe-settlement' AND k.key=s.id::text
        WHERE s.status='submitted' AND COALESCE((k.response_body->>'attempts')::int,0)<20
        AND COALESCE((k.response_body->>'nextAttemptAt')::timestamptz,now())<=now() ORDER BY s.created_at LIMIT 10`);
      for (const settlement of settlements.rows) {
        try { await this.completeStripeSettlement(settlement.id); } catch { /* reservation remains recoverable */ }
      }
    } catch { /* readiness/logging surfaces database outages; next tick retries */ }
    finally { this.recovering = false; }
  }

  constructor(private readonly database: Database, private readonly pricing: PricingService) {}

  async create(ctx: RequestContextValue, key: string, dto: CreatePaymentDto) {
    if (!key || key.length > 200) throw new ConflictException('a valid Idempotency-Key is required');
    const reserved = await this.database.transaction(async (client) => {
      const booking = await client.query<{ status: string }>(`SELECT status FROM bookings
        WHERE id=$1 AND tenant_id=$2 AND customer_id=$3 FOR UPDATE`, [dto.bookingId, ctx.tenantId, ctx.actorId]);
      if (!booking.rowCount) throw new NotFoundException('booking not found');
      await this.pricing.validatePayment(client,ctx,dto.bookingId,dto.amountMinor,dto.currency);
      const existing = await client.query<{ id: string; booking_id: string; amount_minor: string; currency: string; status: string; gateway_payment_id: string }>(
        `SELECT * FROM payment_intents WHERE tenant_id=$1 AND (idempotency_key=$2 OR booking_id=$3)`,
        [ctx.tenantId, key, dto.bookingId]);
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (existing.rowCount !== 1 || row.booking_id !== dto.bookingId || Number(row.amount_minor) !== dto.amountMinor || row.currency !== dto.currency.toUpperCase()) {
          throw new ConflictException('booking payment or idempotency key already exists with different details');
        }
        return { id: row.id, status: row.status, gatewayPaymentId: row.gateway_payment_id };
      }
      if (!['confirmed', 'in_progress', 'completed'].includes(booking.rows[0].status)) {
        throw new ConflictException('booking must be confirmed before creating a payment');
      }
      const id = randomUUID();
      const gateway = process.env.PAYMENT_GATEWAY === 'stripe_test' ? 'stripe_test' : 'sandbox';
      const gatewayPaymentId = gateway === 'sandbox' ? `sbx_${id.replaceAll('-', '')}` : null;
      const result = await client.query<{ id: string; status: string; gateway_payment_id: string }>(
        `INSERT INTO payment_intents
          (id, tenant_id, booking_id, gateway, gateway_payment_id, idempotency_key, currency, amount_minor)
         VALUES ($1,$2,$3,$8,$4,$5,upper($6),$7)
         RETURNING id,status,gateway_payment_id`, [id,ctx.tenantId,dto.bookingId,gatewayPaymentId,key,dto.currency,dto.amountMinor,gateway]);
      const row = result.rows[0];
      return { id: row.id, status: row.status, gatewayPaymentId: row.gateway_payment_id };
    }, 'SERIALIZABLE').catch((error: any) => {
      if (error?.code === '23505') throw new ConflictException('payment key or booking already has a payment');
      throw error;
    });
    return this.provisionPayment(reserved.id);
  }

  private async provisionPayment(paymentId: string) {
    const result = await this.database.query('SELECT * FROM payment_intents WHERE id=$1', [paymentId]);
    const payment = result.rows[0];
    if (payment.gateway === 'stripe_test' && !payment.gateway_payment_id) {
      if (Date.now() - new Date(payment.created_at).getTime() > 23 * 60 * 60 * 1000) {
        throw new ConflictException('gateway provisioning exceeded safe idempotency window; reconcile before retry');
      }
      const remote = await this.stripe.createPayment(payment.id,payment.amount_minor,payment.currency);
      await this.database.query(`UPDATE payment_intents SET gateway_payment_id=$2,updated_at=now()
        WHERE id=$1 AND gateway_payment_id IS NULL`, [payment.id,remote.id]);
      payment.gateway_payment_id = remote.id;
    }
    return { id: payment.id, status: payment.status, gatewayPaymentId: payment.gateway_payment_id };
  }

  async get(ctx: RequestContextValue, paymentId: string) {
    const result = await this.database.query(
      `SELECT pi.id, pi.booking_id AS "bookingId", pi.status, pi.amount_minor AS "amountMinor",
              pi.refunded_minor AS "refundedMinor", pi.currency, pi.gateway_payment_id AS "gatewayPaymentId"
       FROM payment_intents pi JOIN bookings b ON b.id = pi.booking_id
       WHERE pi.id = $1 AND pi.tenant_id = $2 AND b.customer_id = $3`,
      [paymentId, ctx.tenantId, ctx.actorId],
    );
    if (!result.rowCount) throw new NotFoundException('payment not found');
    return result.rows[0];
  }

  async reconciliationReport(ctx: RequestContextValue) {
    if (!ctx.roles.includes('finance')) throw new UnauthorizedException('finance role required');
    const result = await this.database.query<{
      id: string; status: string; amount_minor: string; refunded_minor: string;
      gateway_captured_minor: string; gateway_refunded_minor: string; gateway_capture_events: string;
      gateway_refund_events: string;
      ledger_captures: string; ledger_refunds: string; ledger_captured_minor: string; ledger_refunded_minor: string;
    }>(
      `WITH gateway AS (
         SELECT gateway, payload->>'gatewayPaymentId' AS gateway_payment_id,
                COALESCE(max(CASE WHEN payload->>'type' = 'payment.captured'
                  THEN (payload->>'amountMinor')::bigint END), 0) AS captured_minor,
                COALESCE(sum(CASE WHEN payload->>'type' = 'payment.refunded'
                  THEN (payload->>'amountMinor')::bigint ELSE 0 END), 0) AS refunded_minor,
                count(*) FILTER (WHERE payload->>'type' = 'payment.captured') AS capture_events,
                count(*) FILTER (WHERE payload->>'type' = 'payment.refunded') AS refund_events
         FROM payment_webhook_inbox WHERE processed_at IS NOT NULL AND applied GROUP BY 1,2
       ), ledger AS (
         SELECT reference_id AS payment_id,
                count(*) FILTER (WHERE kind = 'capture') AS captures,
                count(*) FILTER (WHERE kind = 'refund') AS refunds
         FROM ledger_transactions
         WHERE tenant_id = $1 AND reference_type = 'payment' GROUP BY reference_id
       ), ledger_amounts AS (
         SELECT t.reference_id AS payment_id,
           COALESCE(sum(e.amount_minor) FILTER (WHERE t.kind='capture' AND e.direction='debit'),0) AS captured_minor,
           COALESCE(sum(e.amount_minor) FILTER (WHERE t.kind='refund' AND e.direction='credit'),0) AS refunded_minor
         FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id=t.id
         JOIN ledger_accounts a ON a.id=e.account_id AND a.code IN ('gateway_clearing','gateway_clearing:stripe_test')
         WHERE t.tenant_id=$1 AND t.reference_type='payment' GROUP BY t.reference_id
       )
       SELECT pi.id, pi.status, pi.amount_minor, pi.refunded_minor,
              COALESCE(g.captured_minor, 0) AS gateway_captured_minor,
              COALESCE(g.refunded_minor, 0) AS gateway_refunded_minor,
              COALESCE(g.capture_events, 0) AS gateway_capture_events,
              COALESCE(g.refund_events, 0) AS gateway_refund_events,
              COALESCE(l.captures, 0) AS ledger_captures,
              COALESCE(l.refunds, 0) AS ledger_refunds,
              COALESCE(la.captured_minor,0) AS ledger_captured_minor,
              COALESCE(la.refunded_minor,0) AS ledger_refunded_minor
       FROM payment_intents pi
       LEFT JOIN gateway g ON g.gateway_payment_id = pi.gateway_payment_id AND g.gateway=pi.gateway
       LEFT JOIN ledger l ON l.payment_id = pi.id
       LEFT JOIN ledger_amounts la ON la.payment_id=pi.id
       WHERE pi.tenant_id = $1 ORDER BY pi.created_at`,
      [ctx.tenantId],
    );
    const mismatches = result.rows.flatMap((row) => {
      const reasons: string[] = [];
      const captured = ['captured', 'partially_refunded', 'refunded'].includes(row.status);
      if (captured && BigInt(row.gateway_captured_minor) !== BigInt(row.amount_minor)) {
        reasons.push('captured amount differs from processed gateway event');
      }
      if (BigInt(row.ledger_captured_minor) !== (captured ? BigInt(row.amount_minor) : 0n)) reasons.push('capture ledger amount differs from payment');
      if (BigInt(row.ledger_refunded_minor) !== BigInt(row.refunded_minor)) reasons.push('refund ledger amount differs from payment');
      if (captured && Number(row.ledger_captures) !== 1) reasons.push('capture ledger transaction count is not one');
      if (Number(row.gateway_capture_events) !== Number(row.ledger_captures)) {
        reasons.push('capture event and ledger transaction counts differ');
      }
      if (BigInt(row.gateway_refunded_minor) !== BigInt(row.refunded_minor)) {
        reasons.push('refunded amount differs from processed gateway events');
      }
      if (Number(row.gateway_refund_events) !== Number(row.ledger_refunds)) {
        reasons.push('refund event and ledger transaction counts differ');
      }
      return reasons.length ? [{ paymentId: row.id, status: row.status, reasons }] : [];
    });
    const pending = await this.database.query(`SELECT gateway_event_id AS "eventId", processing_attempts AS attempts,
      processing_error AS error FROM payment_webhook_inbox w
      JOIN payment_intents pi ON pi.gateway_payment_id=w.payload->>'gatewayPaymentId' AND pi.gateway=w.gateway
      WHERE pi.tenant_id=$1 AND w.processed_at IS NULL ORDER BY w.received_at`, [ctx.tenantId]);
    return {
      pendingWebhooks: pending.rows,
      checkedAt: new Date().toISOString(), checkedPayments: result.rowCount ?? 0,
      mismatchCount: mismatches.length, mismatches,
    };
  }

  async handleSandboxWebhook(dto: SandboxWebhookDto, signature: string | undefined, rawBody: string) {
    const secret = process.env.SANDBOX_WEBHOOK_SECRET;
    if (!secret || !verifyWebhookSignature(rawBody, signature, secret)) throw new UnauthorizedException('invalid webhook signature');
    return this.ingestWebhook(dto,signature!,'sandbox');
  }

  async handleStripeWebhook(rawBody: string, signature: string | undefined) {
    const dto = parseStripeWebhook(rawBody,signature,process.env.STRIPE_WEBHOOK_SECRET);
    if (!dto) return { accepted: true, ignored: true };
    return this.ingestWebhook(dto,signature!,'stripe_test');
  }

  private async ingestWebhook(dto: SandboxWebhookDto, signature: string, gateway: string) {
    // Persist before processing, so a crash or out-of-order delivery never loses a verified event.
    await this.database.query(`INSERT INTO payment_webhook_inbox
      (gateway, gateway_event_id, signature_digest, payload) VALUES ($4,$1,$2,$3::jsonb)
      ON CONFLICT DO NOTHING`, [dto.eventId, signature, JSON.stringify(dto),gateway]);
    const prior = await this.database.query<{ payload: SandboxWebhookDto; processed_at: Date | null }>(
      `SELECT payload,processed_at FROM payment_webhook_inbox WHERE gateway=$2 AND gateway_event_id=$1`, [dto.eventId,gateway]);
    const previous = prior.rows[0];
    if (JSON.stringify(previous.payload, Object.keys(previous.payload).sort()) !== JSON.stringify(dto, Object.keys(dto).sort())) {
      throw new ConflictException('gateway event id was reused with different details');
    }
    if (previous.processed_at) return { accepted: true, duplicate: true };
    try { return await this.processWebhook(dto.eventId,gateway); }
    catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) return { accepted: true, deferred: true };
      throw error;
    }
  }

  private async processWebhook(eventId: string, gateway = 'sandbox') {
    try {
      return await this.database.transaction(async (client) => {
        const inbox = await client.query<{ payload: SandboxWebhookDto; processed_at: Date | null }>(
          `SELECT payload,processed_at FROM payment_webhook_inbox
           WHERE gateway=$2 AND gateway_event_id=$1 FOR UPDATE`, [eventId,gateway]);
        if (!inbox.rowCount || inbox.rows[0].processed_at) return { accepted: true, duplicate: true };
        const dto = inbox.rows[0].payload;
        const paymentResult = await client.query<PaymentRow>(
          `SELECT pi.*, b.assigned_professional_id AS professional_id
           FROM payment_intents pi JOIN bookings b ON b.id=pi.booking_id
           WHERE pi.gateway=$2 AND pi.gateway_payment_id=$1 FOR UPDATE OF pi,b`, [dto.gatewayPaymentId,gateway]);
        const payment = paymentResult.rows[0];
        if (!payment) throw new NotFoundException('payment intent not found');
        if (dto.type !== 'payment.refunded' && Number(payment.amount_minor) !== dto.amountMinor) {
          throw new ConflictException('gateway amount does not match payment intent');
        }
        if (dto.currency && dto.currency.toUpperCase() !== payment.currency) throw new ConflictException('gateway currency does not match payment');
        let applied = false;
        if (dto.type === 'payment.captured') applied = await this.capture(client, payment, dto.eventId);
        if (dto.type === 'payment.refunded') {
          const refund = await client.query(`INSERT INTO payment_refunds (payment_id,gateway_refund_id,amount_minor)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING gateway_refund_id`,
            [payment.id,dto.refundId ?? dto.eventId,dto.amountMinor]);
          if (refund.rowCount) { await this.refund(client, payment, dto.amountMinor, dto.eventId); applied = true; }
          else {
            const existing = await client.query<{ amount_minor: string }>('SELECT amount_minor FROM payment_refunds WHERE payment_id=$1 AND gateway_refund_id=$2', [payment.id,dto.refundId ?? dto.eventId]);
            if (Number(existing.rows[0].amount_minor) !== dto.amountMinor) throw new ConflictException('refund id reused with different amount');
          }
        }
        if (dto.type === 'payment.authorized') {
          const updated = await client.query(`UPDATE payment_intents SET status='authorized',version=version+1,updated_at=now()
            WHERE id=$1 AND status='created'`, [payment.id]);
          applied = !!updated.rowCount;
        }
        if (dto.type === 'payment.failed') {
          const updated = await client.query(`UPDATE payment_intents SET status='failed',version=version+1,updated_at=now()
            WHERE id=$1 AND status IN ('created','authorized')`, [payment.id]);
          applied = !!updated.rowCount;
        }
        await client.query(`UPDATE payment_webhook_inbox SET processed_at=now(),applied=$2,processing_error=NULL
          WHERE gateway=$3 AND gateway_event_id=$1`, [eventId,applied,gateway]);
        return { accepted: true, duplicate: !applied };
      });
    } catch (error: any) {
      await this.database.query(`UPDATE payment_webhook_inbox SET processing_attempts=processing_attempts+1,
        processing_error=$2,next_attempt_at=now()+interval '2 seconds'
        WHERE gateway=$3 AND gateway_event_id=$1 AND processed_at IS NULL`, [eventId,String(error?.message ?? error).slice(0,1000),gateway]);
      throw error;
    }
  }

  private async stripePayment(ctx: RequestContextValue, paymentId: string, finance: boolean) {
    if (finance && !ctx.roles.includes('finance')) throw new UnauthorizedException('finance role required');
    const result = await this.database.query(`SELECT pi.* FROM payment_intents pi JOIN bookings b ON b.id=pi.booking_id
      WHERE pi.id=$1 AND pi.tenant_id=$2 AND ($4::boolean OR b.customer_id=$3)`, [paymentId,ctx.tenantId,ctx.actorId,finance]);
    const payment = result.rows[0];
    if (!payment) throw new NotFoundException('payment not found');
    if (payment.gateway !== 'stripe_test' || !payment.gateway_payment_id) throw new ConflictException('payment has no provisioned Stripe test intent');
    return payment;
  }

  async confirmStripeTestPayment(ctx: RequestContextValue, paymentId: string) {
    const payment = await this.stripePayment(ctx,paymentId,false);
    const remote = await this.stripe.confirmPayment(payment.gateway_payment_id,payment.id);
    // Only signed webhooks or authenticated gateway reconciliation post the ledger.
    return { paymentId, gatewayPaymentId: remote.id, gatewayStatus: remote.status, localStatus: payment.status };
  }

  async requestStripeRefund(ctx: RequestContextValue, paymentId: string, key: string, amountMinor: number) {
    const payment = await this.stripePayment(ctx,paymentId,true);
    if (!key || key.length > 200) throw new ConflictException('a valid Idempotency-Key is required');
    const fingerprint = createHash('sha256').update(JSON.stringify({ paymentId,amountMinor })).digest('hex');
    const reservation = await this.database.transaction(async (client) => {
      await client.query(`INSERT INTO idempotency_keys (tenant_id,scope,key,request_hash,expires_at,response_body)
        VALUES ($1,'stripe-refund',$2,$3,now()+interval '24 hours',$4::jsonb) ON CONFLICT DO NOTHING`,
        [ctx.tenantId,key,fingerprint,JSON.stringify({ operationId: randomUUID() })]);
      const result = await client.query(`SELECT * FROM idempotency_keys
        WHERE tenant_id=$1 AND scope='stripe-refund' AND key=$2 FOR UPDATE`, [ctx.tenantId,key]);
      const previous = result.rows[0];
      if (previous.request_hash !== fingerprint) throw new ConflictException('refund key reused for different details');
      if (!previous.response_status && Date.now()-new Date(previous.locked_at).getTime() > 23*60*60*1000) {
        throw new ConflictException('refund request exceeded safe gateway idempotency window; reconcile before manual recovery');
      }
      return previous;
    });
    if (reservation.response_status) return reservation.response_body;
    const remote = await this.stripe.refund(payment.gateway_payment_id,amountMinor,reservation.response_body.operationId);
    const body = { paymentId,refundId: remote.id,status: remote.status,amountMinor: remote.amount };
    await this.database.query(`UPDATE idempotency_keys SET response_status=201,response_body=$3::jsonb
      WHERE tenant_id=$1 AND scope='stripe-refund' AND key=$2`, [ctx.tenantId,key,JSON.stringify(body)]);
    return body;
  }

  async reconcileStripePayment(ctx: RequestContextValue, paymentId: string) {
    const payment = await this.stripePayment(ctx,paymentId,true);
    const remote = await this.stripe.retrievePayment(payment.gateway_payment_id);
    const refunds = await this.stripe.listRefunds(payment.gateway_payment_id);
    if (remote.status === 'succeeded') {
      await this.ingestWebhook({ eventId: `reconcile:capture:${remote.id}`,type:'payment.captured',
        gatewayPaymentId:remote.id,amountMinor:remote.amount_received,currency:remote.currency.toUpperCase() }, 'authenticated-stripe-api', 'stripe_test');
    }
    let refunded = 0;
    for (const refund of refunds) {
      if (refund.status !== 'succeeded') continue;
      refunded += refund.amount;
      await this.ingestWebhook({ eventId: `reconcile:refund:${refund.id}`,type:'payment.refunded',
        gatewayPaymentId:remote.id,amountMinor:refund.amount,currency:refund.currency.toUpperCase(),refundId:refund.id }, 'authenticated-stripe-api', 'stripe_test');
    }
    const local = await this.database.query('SELECT * FROM payment_intents WHERE id=$1', [paymentId]);
    const current = local.rows[0];
    const capturedLocally = ['captured','partially_refunded','refunded'].includes(current.status);
    const matches = (remote.status === 'succeeded') === capturedLocally
      && (!capturedLocally || BigInt(remote.amount_received) === BigInt(current.amount_minor))
      && BigInt(refunded) === BigInt(current.refunded_minor);
    return { paymentId,source:'stripe-test-api',gatewayStatus:remote.status,localStatus:current.status,
      capturedMinor:remote.amount_received,refundedMinor:refunded,matches };
  }

  async replayWebhook(ctx: RequestContextValue, eventId: string) {
    if (!ctx.roles.includes('finance')) throw new UnauthorizedException('finance role required');
    const result = await this.database.query(`UPDATE payment_webhook_inbox w
      SET processing_attempts=0,next_attempt_at=now()
      FROM payment_intents pi WHERE w.gateway=pi.gateway AND w.gateway_event_id=$1
      AND pi.gateway_payment_id=w.payload->>'gatewayPaymentId' AND pi.tenant_id=$2
      RETURNING w.gateway_event_id,w.gateway`, [eventId,ctx.tenantId]);
    if (!result.rowCount) throw new NotFoundException('webhook not found for this tenant');
    return this.processWebhook(eventId,result.rows[0].gateway);
  }

  async createSettlement(ctx: RequestContextValue, key: string, dto: CreateSettlementDto) {
    if (!ctx.roles.includes('finance')) throw new UnauthorizedException('finance role required');
    const stripeMode = process.env.PAYMENT_GATEWAY === 'stripe_test';
    let destination: string | null = null;
    if (!key || key.length > 200) throw new ConflictException('a valid Idempotency-Key is required');
    if (new Date(dto.periodEnd) <= new Date(dto.periodStart)) throw new ConflictException('invalid settlement period');

    const reserved = await this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`settlement:${ctx.tenantId}:${key}`]);
      const previous = await client.query<{
        id: string; professional_id: string; currency: string; period_start: Date; period_end: Date;
        amount_minor: string; status: string; gateway_payout_id: string;
      }>(`SELECT * FROM settlements WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`, [ctx.tenantId, key]);
      if (previous.rowCount) {
        const row = previous.rows[0];
        if (row.professional_id !== dto.professionalId || row.currency !== dto.currency.toUpperCase()
            || row.period_start.toISOString() !== new Date(dto.periodStart).toISOString()
            || row.period_end.toISOString() !== new Date(dto.periodEnd).toISOString()) {
          throw new ConflictException('idempotency key was already used for a different settlement');
        }
        return { id: row.id, amountMinor: row.amount_minor, currency: row.currency,
          status: row.status, gatewayPayoutId: row.gateway_payout_id };
      }

      // Existing reservations retain their destination across config changes.
      if (stripeMode) destination = this.stripe.connectDestination(dto.professionalId);
      const account = await client.query<{ id: string }>(
        `SELECT la.id FROM ledger_accounts la
         JOIN professionals p ON p.id = la.owner_id
         WHERE la.tenant_id = $1 AND la.owner_type = 'professional' AND la.owner_id = $2
           AND la.code = $4 AND la.currency = upper($3) AND p.tenant_id = $1
         FOR UPDATE OF la`,
        [ctx.tenantId, dto.professionalId, dto.currency, stripeMode ? 'professional_payable:stripe_test' : 'professional_payable'],
      );
      if (!account.rowCount) throw new ConflictException('professional has no payable balance');
      const balance = await client.query<{ amount_minor: string }>(
        `SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0) AS amount_minor
         FROM ledger_entries WHERE account_id = $1 AND (direction = 'debit' OR created_at < $2)`,
        [account.rows[0].id, dto.periodEnd],
      );
      const amount = BigInt(balance.rows[0].amount_minor);
      if (amount <= 0n) throw new ConflictException('professional has no unsettled earnings for this period');
      const amountText = amount.toString();

      const gateway = await client.query<{ id: string }>(
        `INSERT INTO ledger_accounts (tenant_id, owner_type, owner_id, code, currency)
         VALUES ($1, $3, $1, $4, upper($2))
         ON CONFLICT (tenant_id, owner_type, owner_id, code, currency)
         DO UPDATE SET code = EXCLUDED.code RETURNING id`,
        [ctx.tenantId, dto.currency, stripeMode ? 'platform' : 'gateway', stripeMode ? 'settlement_pending:stripe_test' : 'gateway_clearing'],
      );
      const settlementId = randomUUID();
      const payoutId = stripeMode ? null : `sbx_po_${settlementId.replaceAll('-', '')}`;
      const status = stripeMode ? 'submitted' : 'paid';
      await client.query(
        `INSERT INTO settlements
          (id, tenant_id, professional_id, period_start, period_end, amount_minor, currency,
           status, idempotency_key, gateway_payout_id)
         VALUES ($1, $2, $3, $4, $5, $6, upper($7), $10, $8, $9)`,
        [settlementId, ctx.tenantId, dto.professionalId, dto.periodStart, dto.periodEnd, amountText,
          dto.currency, key, payoutId, status],
      );
      const transaction = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (tenant_id, reference_type, reference_id, kind, idempotency_key)
         VALUES ($1, 'settlement', $2, $4, $3) RETURNING id`,
        [ctx.tenantId, settlementId, `settlement:${key}`, stripeMode ? 'settlement_reserved' : 'settlement'],
      );
      await this.insertEntries(client, transaction.rows[0].id, dto.currency.toUpperCase(), [
        [account.rows[0].id, 'debit', amountText],
        [gateway.rows[0].id, 'credit', amountText],
      ]);
      await client.query('SELECT assert_ledger_transaction_balanced($1)', [transaction.rows[0].id]);
      if (stripeMode) {
        await client.query(`INSERT INTO idempotency_keys (tenant_id,scope,key,request_hash,expires_at,response_body)
          VALUES ($1,'stripe-settlement',$2,$3,now()+interval '24 hours',$4::jsonb)`,
          [ctx.tenantId,settlementId,createHash('sha256').update(`${destination}:${amountText}:${dto.currency.toUpperCase()}`).digest('hex'),JSON.stringify({destination,attempts:0})]);
      } else await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('settlement', $1, 'settlement.paid', $2::jsonb)`,
        [settlementId, JSON.stringify({ settlementId, professionalId: dto.professionalId,
          tenantId: ctx.tenantId, amountMinor: amountText, currency: dto.currency.toUpperCase(), traceId: ctx.traceId })],
      );
      return { id: settlementId, amountMinor: amountText, currency: dto.currency.toUpperCase(),
        status, gatewayPayoutId: payoutId };
    }, 'SERIALIZABLE');
    return reserved.status === 'submitted' ? this.completeStripeSettlement(reserved.id) : reserved;
  }

  async getSettlement(ctx: RequestContextValue, settlementId: string) {
    if (!ctx.roles.includes('finance')) throw new UnauthorizedException('finance role required');
    const result = await this.database.query(`SELECT s.id,s.professional_id AS "professionalId",s.amount_minor AS "amountMinor",
      s.currency,s.status,s.gateway_payout_id AS "gatewayPayoutId",k.response_body->>'error' AS "recoveryError"
      FROM settlements s LEFT JOIN idempotency_keys k ON k.tenant_id=s.tenant_id AND k.scope='stripe-settlement' AND k.key=s.id::text
      WHERE s.id=$1 AND s.tenant_id=$2`,[settlementId,ctx.tenantId]);
    if (!result.rowCount) throw new NotFoundException('settlement not found');
    return result.rows[0];
  }

  private async completeStripeSettlement(settlementId: string) {
    const result = await this.database.query(`SELECT s.*,k.response_body FROM settlements s
      JOIN idempotency_keys k ON k.tenant_id=s.tenant_id AND k.scope='stripe-settlement' AND k.key=s.id::text
      WHERE s.id=$1`,[settlementId]);
    const settlement = result.rows[0];
    if (!settlement) throw new NotFoundException('Stripe settlement reservation not found');
    const body = (row: any) => ({id:row.id,amountMinor:row.amount_minor,currency:row.currency,status:row.status,gatewayPayoutId:row.gateway_payout_id});
    if (settlement.status === 'paid') return body(settlement);
    try {
      let remote = await this.stripe.findTransfer(settlementId);
      if (!remote) {
        if (Date.now()-new Date(settlement.created_at).getTime() > 23*60*60*1000) throw new ConflictException('unknown transfer older than safe gateway retry window requires manual recovery');
        remote = await this.stripe.transfer(settlement.id,settlement.amount_minor,settlement.currency,settlement.response_body.destination);
      }
      const destination = typeof remote.destination === 'string' ? remote.destination : remote.destination?.id;
      if (remote.livemode !== false || BigInt(remote.amount) !== BigInt(settlement.amount_minor)
        || remote.currency.toUpperCase() !== settlement.currency || destination !== settlement.response_body.destination
        || remote.reversed || remote.amount_reversed > 0) throw new ConflictException('gateway transfer differs from immutable settlement reservation');
      return await this.database.transaction(async (client) => {
        const current = await client.query('SELECT * FROM settlements WHERE id=$1 FOR UPDATE',[settlementId]);
        if (current.rows[0].status === 'paid') return body(current.rows[0]);
        const pending = await client.query<{id:string}>(`SELECT id FROM ledger_accounts WHERE tenant_id=$1
          AND owner_type='platform' AND owner_id=$1 AND code='settlement_pending:stripe_test' AND currency=$2 FOR UPDATE`,[settlement.tenant_id,settlement.currency]);
        if (!pending.rowCount) throw new ConflictException('pending settlement account is missing');
        const gateway = await client.query<{id:string}>(`INSERT INTO ledger_accounts (tenant_id,owner_type,owner_id,code,currency)
          VALUES ($1,'gateway',$1,'gateway_clearing:stripe_test',$2) ON CONFLICT (tenant_id,owner_type,owner_id,code,currency)
          DO UPDATE SET code=EXCLUDED.code RETURNING id`,[settlement.tenant_id,settlement.currency]);
        const transaction = await client.query<{id:string}>(`INSERT INTO ledger_transactions (tenant_id,reference_type,reference_id,kind,idempotency_key)
          VALUES ($1,'settlement',$2,'settlement',$3) RETURNING id`,[settlement.tenant_id,settlementId,`stripe-transfer:${settlementId}`]);
        await this.insertEntries(client,transaction.rows[0].id,settlement.currency,[
          [pending.rows[0].id,'debit',settlement.amount_minor],[gateway.rows[0].id,'credit',settlement.amount_minor]]);
        await client.query('SELECT assert_ledger_transaction_balanced($1)',[transaction.rows[0].id]);
        const paid = await client.query(`UPDATE settlements SET status='paid',gateway_payout_id=$2 WHERE id=$1 RETURNING *`,[settlementId,remote.id]);
        await client.query(`UPDATE idempotency_keys SET response_status=200,response_body=response_body-'error'
          WHERE tenant_id=$1 AND scope='stripe-settlement' AND key=$2`,[settlement.tenant_id,settlementId]);
        await client.query(`INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
          VALUES ('settlement',$1,'settlement.paid',$2::jsonb)`,[settlementId,JSON.stringify({settlementId,
          professionalId:settlement.professional_id,tenantId:settlement.tenant_id,amountMinor:settlement.amount_minor,
          currency:settlement.currency,gatewayTransferId:remote.id})]);
        return body(paid.rows[0]);
      });
    } catch (error: any) {
      await this.database.query(`UPDATE idempotency_keys SET response_body=response_body||jsonb_build_object(
        'attempts',COALESCE((response_body->>'attempts')::integer,0)+1,'nextAttemptAt',now()+interval '5 seconds','error',$2::text)
        WHERE scope='stripe-settlement' AND key=$1 AND response_status IS NULL`,[settlementId,String(error?.message ?? error).slice(0,500)]);
      throw error;
    }
  }

  private async capture(client: PoolClient, payment: PaymentRow, eventId: string) {
    if (['captured', 'partially_refunded', 'refunded'].includes(payment.status)) return false;
    if (!['created', 'authorized', 'failed'].includes(payment.status)) throw new ConflictException(`cannot capture a ${payment.status} payment`);
    if (!payment.professional_id) throw new ConflictException('booking must have an assigned professional before capture');
    const amount = Number(payment.amount_minor);
    const { commissionMinor: commission, professionalMinor: earning } = splitAmount(amount);
    const accounts = await this.ensureAccounts(client, payment);
    const transactionId = await this.createLedgerTransaction(client, payment, eventId, 'capture');
    await this.insertEntries(client, transactionId, payment.currency, [
      [accounts.gateway, 'debit', amount],
      [accounts.platform, 'credit', commission],
      [accounts.professional, 'credit', earning],
    ]);
    await client.query('SELECT assert_ledger_transaction_balanced($1)', [transactionId]);
    await client.query(
      `UPDATE payment_intents SET status = 'captured', version = version + 1, updated_at = now() WHERE id = $1`,
      [payment.id],
    );
    await this.writeOutbox(client, payment, 'payment.captured', { paymentId: payment.id, amountMinor: amount, currency: payment.currency });
    return true;
  }

  private async refund(client: PoolClient, payment: PaymentRow, refundAmount: number, eventId: string) {
    if (!['captured', 'partially_refunded'].includes(payment.status)) {
      throw new ConflictException(`cannot refund a ${payment.status} payment`);
    }
    const alreadyRefunded = Number(payment.refunded_minor);
    if (refundAmount + alreadyRefunded > Number(payment.amount_minor)) throw new ConflictException('refund exceeds captured amount');
    if (!payment.professional_id) throw new ConflictException('payment has no professional');
    const { commissionMinor: commission, professionalMinor: earning } = splitRefund(alreadyRefunded, refundAmount);
    const accounts = await this.ensureAccounts(client, payment);
    const transactionId = await this.createLedgerTransaction(client, payment, eventId, 'refund');
    await this.insertEntries(client, transactionId, payment.currency, [
      [accounts.platform, 'debit', commission],
      [accounts.professional, 'debit', earning],
      [accounts.gateway, 'credit', refundAmount],
    ]);
    await client.query('SELECT assert_ledger_transaction_balanced($1)', [transactionId]);
    const totalRefunded = alreadyRefunded + refundAmount;
    const status = totalRefunded === Number(payment.amount_minor) ? 'refunded' : 'partially_refunded';
    await client.query(
      `UPDATE payment_intents SET status = $2, refunded_minor = $3, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [payment.id, status, totalRefunded],
    );
    await this.writeOutbox(client, payment, 'payment.refunded', {
      paymentId: payment.id, amountMinor: refundAmount, totalRefundedMinor: totalRefunded, currency: payment.currency,
    });
  }

  private async ensureAccounts(client: PoolClient, payment: PaymentRow) {
    const definitions: Array<[string, string, string]> = [
      ['gateway', payment.tenant_id, 'gateway_clearing'],
      ['platform', payment.tenant_id, 'commission_revenue'],
      ['professional', payment.professional_id!, 'professional_payable'],
    ];
    const ids: Record<string, string> = {};
    for (const [ownerType, ownerId, code] of definitions) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO ledger_accounts (tenant_id, owner_type, owner_id, code, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, owner_type, owner_id, code, currency)
         DO UPDATE SET code = EXCLUDED.code RETURNING id`,
        [payment.tenant_id, ownerType, ownerId, payment.gateway === 'stripe_test' ? `${code}:stripe_test` : code, payment.currency],
      );
      ids[ownerType] = result.rows[0].id;
    }
    return ids as { gateway: string; platform: string; professional: string };
  }

  private async createLedgerTransaction(client: PoolClient, payment: PaymentRow, eventId: string, kind: string) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (tenant_id, reference_type, reference_id, kind, idempotency_key)
       VALUES ($1, 'payment', $2, $3, $4) RETURNING id`,
      [payment.tenant_id, payment.id, kind, `webhook:${payment.gateway}:${eventId}`],
    );
    return result.rows[0].id;
  }

  private async insertEntries(
    client: PoolClient,
    transactionId: string,
    currency: string,
    entries: Array<[string, 'debit' | 'credit', number | string]>,
  ) {
    for (const [accountId, direction, amount] of entries) {
      if (amount === 0 || amount === '0') continue;
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [transactionId, accountId, direction, amount, currency],
      );
    }
  }

  private async writeOutbox(client: PoolClient, payment: PaymentRow, eventType: string, payload: object) {
    await client.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('payment', $1, $2, $3::jsonb)`,
      [payment.id, eventType, JSON.stringify({ ...payload, tenantId: payment.tenant_id, bookingId: payment.booking_id })],
    );
  }
}
