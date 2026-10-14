import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ContextGuard } from '../auth/context.guard';
import { RequestContext, RequestContextValue } from '../auth/request-context';
import { CreatePaymentDto, CreateSettlementDto, SandboxWebhookDto, CreateRefundDto } from './payment.dto';
import { PaymentService } from './payment.service';

@Controller('payments')
@UseGuards(ContextGuard)
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post()
  create(
    @RequestContext() ctx: RequestContextValue,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.payments.create(ctx, key, dto);
  }

  @Get('reconciliation/report')
  reconciliation(@RequestContext() ctx: RequestContextValue) {
    return this.payments.reconciliationReport(ctx);
  }

  @Post(':id/sandbox-confirm')
  confirmStripe(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.confirmStripeTestPayment(ctx,id);
  }

  @Post(':id/refunds')
  refundStripe(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key: string, @Body() dto: CreateRefundDto) {
    return this.payments.requestStripeRefund(ctx,id,key,dto.amountMinor);
  }

  @Post(':id/reconcile')
  reconcileStripe(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.reconcileStripePayment(ctx,id);
  }

  @Post('webhooks/:eventId/replay')
  replayWebhook(@RequestContext() ctx: RequestContextValue, @Param('eventId') eventId: string) {
    return this.payments.replayWebhook(ctx, eventId);
  }

  @Get(':id')
  get(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.get(ctx, id);
  }
}

@Controller('webhooks')
export class GatewayWebhookController {
  constructor(private readonly payments: PaymentService) {}

  @Post('stripe')
  stripe(@Headers('stripe-signature') signature: string | undefined, @Req() req: RawBodyRequest<Request>) {
    return this.payments.handleStripeWebhook(req.rawBody?.toString('utf8') ?? '',signature);
  }

  @Post('sandbox')
  sandbox(
    @Body() dto: SandboxWebhookDto,
    @Headers('x-sandbox-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.payments.handleSandboxWebhook(dto, signature, req.rawBody?.toString('utf8') ?? '');
  }
}

@Controller('settlements')
@UseGuards(ContextGuard)
export class SettlementController {
  constructor(private readonly payments: PaymentService) {}

  @Get(':id')
  get(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.getSettlement(ctx,id);
  }

  @Post()
  create(
    @RequestContext() ctx: RequestContextValue,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.payments.createSettlement(ctx, key, dto);
  }
}
