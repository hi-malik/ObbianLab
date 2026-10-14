import { z } from 'zod';

export const uuid = z.string().uuid();
// JSON numbers must be exact; larger PostgreSQL bigint values travel as strings.
export const minorUnits = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^[1-9][0-9]{0,18}$/).refine((value) => BigInt(value) <= 9223372036854775807n),
]);
export const money = z.object({ amountMinor: minorUnits, currency: z.string().regex(/^[A-Z]{3}$/) });
export const bookingTypes = [
  'booking.requested', 'booking.offer.created', 'booking.offer.expired', 'booking.offer.rejected',
  'booking.confirmed', 'booking.cancelled', 'booking.completed', 'booking.unfulfilled', 'booking.started',
] as const;
export const paymentTypes = [
  'payment.authorized', 'payment.captured', 'payment.failed', 'payment.refunded', 'settlement.paid',
] as const;

export const domainEvent = z.object({
  id: uuid,
  type: z.enum([...bookingTypes, ...paymentTypes]),
  schemaVersion: z.literal(1),
  aggregateId: uuid,
  tenantId: uuid,
  occurredAt: z.string().datetime({ offset: true }),
  traceId: z.string().min(1).max(256),
  payload: z.record(z.unknown()),
});
export type DomainEvent = z.infer<typeof domainEvent>;

export const bookingRequestedPayload = z.object({
  bookingId: uuid.optional(),
  id: uuid.optional(), // v1 booking creation emits `id`; aggregateId remains authoritative.
  customerId: uuid,
  categoryId: uuid,
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  scheduledFor: z.string().datetime({ offset: true }),
}).passthrough();
export const bookingEvent = domainEvent.extend({ type: z.enum(bookingTypes) });
export const paymentEvent = domainEvent.extend({ type: z.enum(paymentTypes) });
export type BookingEvent = z.infer<typeof bookingEvent>;
export type PaymentEvent = z.infer<typeof paymentEvent>;

export function parseEvent(input: unknown): DomainEvent {
  const event = domainEvent.parse(input);
  const payload = event.payload;
  if (payload.tenantId !== undefined && payload.tenantId !== event.tenantId) {
    throw new Error('payload tenant does not match event tenant');
  }
  if (event.type === 'booking.requested') bookingRequestedPayload.parse(payload);
  else if (event.type.startsWith('booking.')) z.object({ bookingId: uuid }).passthrough().parse(payload);
  else if (event.type === 'settlement.paid') {
    money.extend({ settlementId: uuid, professionalId: uuid }).passthrough().parse(payload);
  } else {
    money.extend({ bookingId: uuid, paymentId: uuid }).passthrough().parse(payload);
  }
  const entityId = event.type.startsWith('booking.') ? (payload.bookingId ?? payload.id ?? event.aggregateId)
    : event.type === 'settlement.paid' ? payload.settlementId : payload.paymentId;
  if (entityId !== event.aggregateId) throw new Error('payload identity does not match event aggregate');
  return event;
}
