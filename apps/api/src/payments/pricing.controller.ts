import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ContextGuard } from '../auth/context.guard';
import { RequestContext, RequestContextValue } from '../auth/request-context';
import { PricingService } from './pricing.service';

@Controller('payments')
@UseGuards(ContextGuard)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('quote/:bookingId')
  quote(@RequestContext() ctx: RequestContextValue, @Param('bookingId', new ParseUUIDPipe()) bookingId: string) {
    return this.pricing.quote(ctx, bookingId);
  }
}
