import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Database } from '../database';
import { RequestContextValue } from '../auth/request-context';
import { AvailabilityDto, CreateBookingDto, ProfessionalPresenceDto, TrackLocationDto } from './booking.dto';
import { isOfferAcceptable } from './booking.domain';
import { TrackingGateway } from './tracking.gateway';

interface BookingRow {
  id: string;
  customer_id: string;
  status: string;
  assigned_professional_id: string | null;
  professional_user_id: string | null;
  scheduled_for: Date;
}

interface OfferRow extends BookingRow {
  offer_id: string;
  offer_status: string;
  expires_at: Date;
  professional_id: string;
}

@Injectable()
export class BookingService {
  constructor(private readonly database: Database, private readonly gateway: TrackingGateway) {}

  async create(ctx: RequestContextValue, key: string, dto: CreateBookingDto) {
    if (!key || key.length > 200) throw new ConflictException('a valid Idempotency-Key is required');
    const requestHash = createHash('sha256').update(JSON.stringify({ actorId: ctx.actorId, ...dto })).digest('hex');

    const result = await this.database.transaction(async (client) => {
      const category = await client.query('SELECT id FROM service_categories WHERE id=$1 AND tenant_id=$2 AND active', [dto.categoryId, ctx.tenantId]);
      if (!category.rowCount) throw new NotFoundException('active category not found');
      const inserted = await client.query(
        `INSERT INTO idempotency_keys
          (tenant_id, scope, key, request_hash, expires_at)
         VALUES ($1, 'create-booking', $2, $3, now() + interval '24 hours')
         ON CONFLICT DO NOTHING RETURNING key`,
        [ctx.tenantId, key, requestHash],
      );
      if (inserted.rowCount === 0) {
        const previous = await client.query<{
          request_hash: string; response_status: number | null; response_body: unknown;
        }>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_keys WHERE tenant_id = $1 AND scope = 'create-booking' AND key = $2
           FOR UPDATE`,
          [ctx.tenantId, key],
        );
        const stored = previous.rows[0];
        if (!stored || stored.request_hash !== requestHash) {
          throw new ConflictException('idempotency key was already used for a different request');
        }
        if (!stored.response_status) throw new ConflictException('request with this key is still in progress');
        return stored.response_body;
      }

      const booking = await client.query<{ id: string; status: string; requested_at: Date }>(
        `INSERT INTO bookings
          (tenant_id, customer_id, category_id, pickup, address, scheduled_for, expected_duration, max_eta_seconds)
         VALUES ($1, $2, $3,
          ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
          $6, $7, make_interval(mins => $8), $9)
         RETURNING id, status, requested_at`,
        [ctx.tenantId, ctx.actorId, dto.categoryId, dto.longitude, dto.latitude,
          dto.address, dto.scheduledFor, dto.durationMinutes, dto.maxEtaSeconds ?? 1800],
      );
      const body = { id: booking.rows[0].id, status: booking.rows[0].status, requestedAt: booking.rows[0].requested_at };
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('booking', $1, 'booking.requested', $2::jsonb)`,
        [body.id, JSON.stringify({
          ...body,
          tenantId: ctx.tenantId,
          customerId: ctx.actorId,
          categoryId: dto.categoryId,
          scheduledFor: dto.scheduledFor,
          traceId: ctx.traceId,
        })],
      );
      await client.query(
        `UPDATE idempotency_keys SET response_status = 201, response_body = $4::jsonb
         WHERE tenant_id = $1 AND scope = $2 AND key = $3`,
        [ctx.tenantId, 'create-booking', key, JSON.stringify(body)],
      );
      return body;
    });

    return result;
  }

  async category(ctx: RequestContextValue, slug: string) {
    const result = await this.database.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM service_categories
       WHERE tenant_id = $1 AND slug = $2 AND active`,
      [ctx.tenantId, slug],
    );
    if (!result.rowCount) throw new NotFoundException('category not found');
    return result.rows[0];
  }

  async availability(ctx: RequestContextValue, dto: AvailabilityDto) {
    const result = await this.database.query<{ available: boolean; eligible_count: number }>(
      `SELECT count(*) > 0 AS available, count(*)::int AS eligible_count
       FROM professionals p
       JOIN professional_services ps ON ps.professional_id = p.id
       WHERE p.tenant_id = $1 AND ps.category_id = $2 AND ps.active
         AND (ST_Distance(p.location, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) / 8.33 + 120) <= $7
         AND p.status = 'available' AND p.location_recorded_at > now() - interval '2 minutes'
         AND ST_DWithin(
           p.location,
           ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
           p.service_radius_m
         )
         AND NOT EXISTS (
           SELECT 1 FROM professional_assignments pa
           WHERE pa.professional_id = p.id AND pa.active
             AND pa.service_window && tstzrange(
               $5::timestamptz,
               $5::timestamptz + make_interval(mins => $6),
               '[)'
             )
         )`,
      [ctx.tenantId, dto.categoryId, dto.longitude, dto.latitude, dto.scheduledFor, dto.durationMinutes, dto.maxEtaSeconds ?? 1800],
    );
    return result.rows[0];
  }

  async get(ctx: RequestContextValue, bookingId: string) {
    const result = await this.database.query(
      `SELECT b.id, b.status, b.address, b.scheduled_for AS "scheduledFor",
              b.assigned_professional_id AS "professionalId",
              ST_Y(b.pickup::geometry) AS latitude, ST_X(b.pickup::geometry) AS longitude
       FROM bookings b
       LEFT JOIN professionals p ON p.id = b.assigned_professional_id
       WHERE b.id = $1 AND b.tenant_id = $2 AND (b.customer_id = $3 OR p.user_id = $3)`,
      [bookingId, ctx.tenantId, ctx.actorId],
    );
    if (!result.rowCount) throw new NotFoundException('booking not found');
    return result.rows[0];
  }

  async pendingOffers(ctx: RequestContextValue) {
    const result = await this.database.query(
      `SELECT o.id, o.booking_id AS "bookingId", o.distance_m AS "distanceMetres",
              o.eta_seconds AS "etaSeconds", o.expires_at AS "expiresAt",
              c.name AS service, b.address
       FROM booking_offers o
       JOIN professionals p ON p.id = o.professional_id
       JOIN bookings b ON b.id = o.booking_id
       JOIN service_categories c ON c.id = b.category_id
       WHERE p.user_id = $1 AND p.tenant_id = $2
         AND o.status = 'pending' AND o.expires_at > now()
       ORDER BY o.offered_at DESC`,
      [ctx.actorId, ctx.tenantId],
    );
    return result.rows;
  }

  async updatePresence(ctx: RequestContextValue, dto: ProfessionalPresenceDto) {
    const result = await this.database.query<{
      id: string; status: string; latitude: number; longitude: number; recorded_at: Date;
    }>(
      `UPDATE professionals
       SET status = $3,
           location = ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
           location_recorded_at = now(), version = version + 1
       WHERE tenant_id = $1 AND user_id = $2 AND status <> 'suspended'
       RETURNING id, status, ST_Y(location::geometry) AS latitude,
                 ST_X(location::geometry) AS longitude, location_recorded_at AS recorded_at`,
      [ctx.tenantId, ctx.actorId, dto.status, dto.longitude, dto.latitude],
    );
    if (!result.rowCount) throw new NotFoundException('active professional profile not found');
    const row = result.rows[0];
    return { id: row.id, status: row.status, latitude: row.latitude, longitude: row.longitude, recordedAt: row.recorded_at };
  }

  async acceptOffer(ctx: RequestContextValue, offerId: string) {
    try {
      const event = await this.database.transaction(async (client) => {
        const result = await client.query<OfferRow>(
          `SELECT o.id AS offer_id, o.status AS offer_status, o.expires_at, o.professional_id,
                  b.id, b.customer_id, b.status, b.scheduled_for,
                  b.assigned_professional_id, p.user_id AS professional_user_id
           FROM booking_offers o
           JOIN bookings b ON b.id = o.booking_id
           JOIN professionals p ON p.id = o.professional_id
           WHERE o.id = $1 AND b.tenant_id = $2 FOR UPDATE OF o, b`,
          [offerId, ctx.tenantId],
        );
        const offer = result.rows[0];
        if (!offer) throw new NotFoundException('offer not found');
        if (offer.professional_user_id !== ctx.actorId) throw new UnauthorizedException('offer belongs to another professional');
        if (offer.status !== 'offered' || !isOfferAcceptable(offer.offer_status, offer.expires_at, new Date())) {
          throw new ConflictException('offer is no longer available');
        }

        const active = await client.query(
          `SELECT id FROM professionals WHERE id=$1 AND status='available'
           AND location_recorded_at > now() - interval '2 minutes' FOR UPDATE`, [offer.professional_id]);
        if (!active.rowCount) throw new ConflictException('professional is no longer available');
        await client.query(
          `INSERT INTO professional_assignments (booking_id, professional_id, service_window)
           SELECT b.id, $2, tstzrange(b.scheduled_for, b.scheduled_for + b.expected_duration, '[)')
           FROM bookings b WHERE b.id = $1`,
          [offer.id, offer.professional_id],
        );
        await client.query(`UPDATE booking_offers SET status = 'accepted', responded_at = now() WHERE id = $1`, [offerId]);
        await client.query(
          `UPDATE booking_offers SET status = 'rejected', responded_at = now()
           WHERE booking_id = $1 AND id <> $2 AND status = 'pending'`,
          [offer.id, offerId],
        );
        await client.query(
          `UPDATE bookings SET status = 'confirmed', assigned_professional_id = $2,
             version = version + 1, updated_at = now() WHERE id = $1`,
          [offer.id, offer.professional_id],
        );
        const payload = {
          bookingId: offer.id,
          professionalId: offer.professional_id,
          tenantId: ctx.tenantId,
          status: 'confirmed',
          traceId: ctx.traceId,
        };
        await client.query(
          `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
           VALUES ('booking', $1, 'booking.confirmed', $2::jsonb)`,
          [offer.id, JSON.stringify(payload)],
        );
        return { ...payload, customerId: offer.customer_id, professionalUserId: offer.professional_user_id };
      }, 'SERIALIZABLE');
      return event;
    } catch (error: any) {
      if (error?.code === '23P01' || error?.code === '40001') {
        throw new ConflictException('professional is no longer available; request reassignment');
      }
      throw error;
    }
  }

  async rejectOffer(ctx: RequestContextValue, offerId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ booking_id: string; allocation_attempt: number; tenant_id: string }>(
        `SELECT b.id AS booking_id,b.allocation_attempt,b.tenant_id FROM booking_offers o
         JOIN bookings b ON b.id=o.booking_id JOIN professionals p ON p.id=o.professional_id
         WHERE o.id=$1 AND p.user_id=$2 AND b.tenant_id=$3 AND o.status='pending'
           AND b.status='offered' FOR UPDATE OF b,o`, [offerId,ctx.actorId,ctx.tenantId]);
      if (!result.rowCount) throw new ConflictException('offer is not pending or does not belong to this professional');
      const booking = result.rows[0];
      const status = booking.allocation_attempt + 1 >= Number(process.env.MAX_ALLOCATION_ATTEMPTS ?? 5) ? 'unfulfilled' : 'requested';
      await client.query(`UPDATE booking_offers SET status='rejected',responded_at=now() WHERE id=$1`, [offerId]);
      await client.query(`UPDATE bookings SET status=$2,allocation_attempt=allocation_attempt+1,
        next_allocation_at=now(),updated_at=now() WHERE id=$1`, [booking.booking_id,status]);
      const payload = { bookingId: booking.booking_id, tenantId: ctx.tenantId, status, traceId: ctx.traceId };
      await client.query(`INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
        VALUES ('booking',$1,$2,$3::jsonb)`, [booking.booking_id,
        status === 'unfulfilled' ? 'booking.unfulfilled' : 'booking.offer.rejected',JSON.stringify(payload)]);
      return payload;
    });
  }

  async cancel(ctx: RequestContextValue, bookingId: string) {
    const event = await this.database.transaction(async (client) => {
      const result = await client.query<{ customer_id: string; status: string }>(
        `SELECT customer_id, status FROM bookings
         WHERE id = $1 AND tenant_id = $2 AND customer_id = $3 FOR UPDATE`,
        [bookingId, ctx.tenantId, ctx.actorId],
      );
      const booking = result.rows[0];
      if (!booking) throw new NotFoundException('booking not found');
      if (['completed', 'cancelled', 'unfulfilled'].includes(booking.status)) {
        throw new ConflictException(`cannot cancel a ${booking.status} booking`);
      }
      await client.query(
        `UPDATE bookings SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`,
        [bookingId],
      );
      await client.query(
        `UPDATE booking_offers SET status = 'rejected', responded_at = now()
         WHERE booking_id = $1 AND status = 'pending'`,
        [bookingId],
      );
      await client.query(`UPDATE professional_assignments SET active = false WHERE booking_id = $1`, [bookingId]);
      const payload = { bookingId, tenantId: ctx.tenantId, status: 'cancelled', traceId: ctx.traceId };
      await client.query(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('booking', $1, 'booking.cancelled', $2::jsonb)`,
        [bookingId, JSON.stringify(payload)],
      );
      return payload;
    });
    return event;
  }

  async transition(ctx: RequestContextValue, bookingId: string, target: 'in_progress' | 'completed') {
    const event = await this.database.transaction(async (client) => {
      const result = await client.query<{ status: string; customer_id: string; professional_user_id: string }>(
        `SELECT b.status, b.customer_id, p.user_id AS professional_user_id
         FROM bookings b JOIN professionals p ON p.id = b.assigned_professional_id
         WHERE b.id=$1 AND b.tenant_id=$2 AND p.user_id=$3 FOR UPDATE OF b`,
        [bookingId, ctx.tenantId, ctx.actorId]);
      const booking = result.rows[0];
      if (!booking) throw new NotFoundException('assigned booking not found');
      if (booking.status === target) return { bookingId, status: target, customerId: booking.customer_id };
      const expected = target === 'in_progress' ? 'confirmed' : 'in_progress';
      if (booking.status !== expected) throw new ConflictException(`cannot transition ${booking.status} to ${target}`);
      await client.query('UPDATE bookings SET status=$2, version=version+1, updated_at=now() WHERE id=$1', [bookingId, target]);
      if (target === 'completed') await client.query('UPDATE professional_assignments SET active=false WHERE booking_id=$1', [bookingId]);
      const payload = { bookingId, tenantId: ctx.tenantId, status: target, traceId: ctx.traceId };
      await client.query(`INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
        VALUES ('booking', $1, $2, $3::jsonb)`, [bookingId, target === 'completed' ? 'booking.completed' : 'booking.started', JSON.stringify(payload)]);
      return { ...payload, customerId: booking.customer_id };
    });
    return event;
  }

  async latestLocation(ctx: RequestContextValue, bookingId: string) {
    await this.get(ctx, bookingId);
    const result = await this.database.query(`SELECT ST_Y(position::geometry) AS latitude,
      ST_X(position::geometry) AS longitude, recorded_at AS "recordedAt"
      FROM booking_locations WHERE booking_id=$1 ORDER BY recorded_at DESC LIMIT 1`, [bookingId]);
    return result.rows[0] ?? null;
  }

  async track(ctx: RequestContextValue, bookingId: string, dto: TrackLocationDto) {
    const result = await this.database.query<{ customer_id: string }>(
      `INSERT INTO booking_locations (booking_id, professional_id, position, recorded_at)
       SELECT b.id, p.id, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6
       FROM bookings b JOIN professionals p ON p.id = b.assigned_professional_id
       WHERE b.id = $1 AND b.tenant_id = $2 AND p.user_id = $3
         AND b.status IN ('confirmed', 'in_progress')
       ON CONFLICT DO NOTHING
       RETURNING (SELECT customer_id FROM bookings WHERE id = $1) AS customer_id`,
      [bookingId, ctx.tenantId, ctx.actorId, dto.longitude, dto.latitude, dto.recordedAt],
    );
    if (!result.rowCount) throw new ConflictException('location is duplicate or booking is not trackable');
    const event = { bookingId, ...dto };
    return event;
  }
}
