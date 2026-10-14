import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database';
import { constantTimeEqual, UUID, verifyIdentityToken } from './identity';

@Injectable()
export class ContextGuard implements CanActivate {
  constructor(private readonly database: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authorization = String(req.header('authorization') ?? '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const serviceToken = process.env.INTERNAL_SERVICE_TOKEN;
    const trustedService = !!serviceToken && !!token && constantTimeEqual(token, serviceToken);
    const demo = process.env.AUTH_MODE === 'demo';
    const signedIdentity = verifyIdentityToken(token, process.env.AUTH_SIGNING_SECRET);
    if (!signedIdentity && !trustedService && !(demo && !authorization)) {
      throw new UnauthorizedException('valid bearer authentication is required');
    }
    const tenantId = signedIdentity?.tenantId ?? req.header('x-tenant-id');
    const actorId = signedIdentity?.actorId ?? req.header('x-actor-id');
    if (!tenantId || !actorId) throw new UnauthorizedException('identity is required');
    if (!UUID.test(tenantId) || !UUID.test(actorId)) throw new BadRequestException('identity must contain valid UUIDs');
    const result = await this.database.query<{ roles: string[] }>(
      'SELECT roles FROM app_users WHERE id = $1 AND tenant_id = $2', [actorId, tenantId],
    );
    if (!result.rowCount) throw new UnauthorizedException('identity is not a member of this tenant');
    req.context = {
      tenantId, actorId, roles: result.rows[0].roles,
      traceId: String(req.header('x-request-id') ?? randomUUID()).slice(0, 200),
    };
    return true;
  }
}
