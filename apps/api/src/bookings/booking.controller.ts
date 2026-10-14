import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ContextGuard } from '../auth/context.guard';
import { RequestContext, RequestContextValue } from '../auth/request-context';
import { BookingService } from './booking.service';
import { AvailabilityDto, CreateBookingDto, ProfessionalPresenceDto, TrackLocationDto } from './booking.dto';

@Controller()
@UseGuards(ContextGuard)
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Get('categories/:slug')
  category(@RequestContext() ctx: RequestContextValue, @Param('slug') slug: string) {
    return this.bookings.category(ctx, slug);
  }

  @Post('availability/check')
  availability(@RequestContext() ctx: RequestContextValue, @Body() dto: AvailabilityDto) {
    return this.bookings.availability(ctx, dto);
  }

  @Post('bookings')
  create(
    @RequestContext() ctx: RequestContextValue,
    @Headers('idempotency-key') key: string,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookings.create(ctx, key, dto);
  }

  @Get('bookings/:id')
  get(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.get(ctx, id);
  }

  @Get('professionals/me/offers')
  offers(@RequestContext() ctx: RequestContextValue) {
    return this.bookings.pendingOffers(ctx);
  }

  @Post('professionals/me/presence')
  presence(@RequestContext() ctx: RequestContextValue, @Body() dto: ProfessionalPresenceDto) {
    return this.bookings.updatePresence(ctx, dto);
  }

  @Post('offers/:id/accept')
  accept(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.acceptOffer(ctx, id);
  }

  @Post('offers/:id/reject')
  reject(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.rejectOffer(ctx, id);
  }

  @Post('bookings/:id/locations')
  track(
    @RequestContext() ctx: RequestContextValue,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TrackLocationDto,
  ) {
    return this.bookings.track(ctx, id, dto);
  }

  @Get('bookings/:id/locations/latest')
  latestLocation(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.latestLocation(ctx, id);
  }

  @Post('bookings/:id/start')
  start(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.transition(ctx, id, 'in_progress');
  }

  @Post('bookings/:id/complete')
  complete(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.transition(ctx, id, 'completed');
  }

  @Post('bookings/:id/cancel')
  cancel(@RequestContext() ctx: RequestContextValue, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.bookings.cancel(ctx, id);
  }
}
