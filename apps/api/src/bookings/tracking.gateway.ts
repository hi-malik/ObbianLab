import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Pool, PoolClient } from 'pg';
import { Server, Socket } from 'socket.io';
import { Database, PG_POOL } from '../database';
import { verifyIdentityToken } from '../auth/identity';

@Injectable()
@WebSocketGateway({ namespace: '/tracking', cors: { origin: false } })
export class TrackingGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(TrackingGateway.name);
  private listener?: PoolClient;
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  constructor(private readonly database: Database, @Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit() { void this.listen(); }
  onModuleDestroy() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.listener?.release(true);
    this.listener = undefined;
  }
  private async listen() {
    try {
      const client = await this.pool.connect();
      if (this.closing) { client.release(); return; }
      this.listener = client;
      client.on('notification', (message) => {
        if (message.payload) void this.broadcast(message.channel, message.payload).catch((error) => this.logger.error(error.message));
      });
      client.once('error', () => {
        this.listener = undefined;
        client.release(true);
        if (!this.closing) this.timer = setTimeout(() => { void this.listen(); }, 1000);
      });
      await client.query('LISTEN booking_changes');
      await client.query('LISTEN booking_tracking');
    } catch (error: any) {
      this.logger.error(`tracking subscription: ${error.message}`);
      if (this.listener) { this.listener.release(true); this.listener = undefined; }
      if (!this.closing) this.timer = setTimeout(() => { void this.listen(); }, 1000);
    }
  }
  private async broadcast(channel: string, id: string) {
    if (channel === 'booking_changes') {
      const result = await this.database.query(`SELECT e.payload, b.customer_id, p.user_id AS professional_user_id
        FROM outbox_events e JOIN bookings b ON b.id=e.aggregate_id
        LEFT JOIN professionals p ON p.id=COALESCE(NULLIF(e.payload->>'professionalId','')::uuid,b.assigned_professional_id)
        WHERE e.id=$1`, [id]);
      const row = result.rows[0];
      if (row) this.bookingChanged(row.customer_id, row.professional_user_id, row.payload);
    } else if (channel === 'booking_tracking') {
      const result = await this.database.query(`SELECT b.customer_id,l.booking_id AS "bookingId",
        ST_Y(l.position::geometry) AS latitude,ST_X(l.position::geometry) AS longitude,l.recorded_at AS "recordedAt"
        FROM booking_locations l JOIN bookings b ON b.id=l.booking_id WHERE l.id=$1`, [id]);
      const row = result.rows[0];
      if (row) { const { customer_id, ...event } = row; this.locationChanged(customer_id,event); }
    }
  }
  async handleConnection(client: Socket) {
    const identity = verifyIdentityToken(String(client.handshake.auth?.token ?? ''), process.env.AUTH_SIGNING_SECRET);
    if (!identity) { client.disconnect(true); return; }
    try {
      const user = await this.database.query('SELECT id FROM app_users WHERE id=$1 AND tenant_id=$2', [identity.actorId,identity.tenantId]);
      if (!user.rowCount) { client.disconnect(true); return; }
      await client.join(`actor:${identity.actorId}`);
    } catch { client.disconnect(true); }
  }
  bookingChanged(customerId: string, professionalUserId: string | null, event: unknown) {
    this.server.to(`actor:${customerId}`).emit('booking.changed', event);
    if (professionalUserId) this.server.to(`actor:${professionalUserId}`).emit('booking.changed', event);
  }
  locationChanged(customerId: string, event: unknown) {
    this.server.to(`actor:${customerId}`).emit('booking.location', event);
  }
}
