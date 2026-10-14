import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextGuard } from '../src/auth/context.guard';
import { verifyIdentityToken } from '../src/auth/identity';
const secret = 'test-secret-at-least-thirty-two-characters';
const actorId = '22222222-2222-4222-8222-222222222222';
const tenantId = '11111111-1111-4111-8111-111111111111';
function sign(overrides = {}, headerOverride = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...headerOverride })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: actorId, tenantId, aud: 'obbian', exp: 2000000000, ...overrides })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
function request(headers: Record<string,string>) {
  const req = { header: (key: string) => headers[key], context: undefined as any };
  return { req, context: { switchToHttp: () => ({ getRequest: () => req }) } as any };
}
afterEach(() => vi.unstubAllEnvs());
describe('signed actor authentication and authoritative permissions', () => {
  it('binds valid tokens to actor, tenant, audience and expiration', () => {
    expect(verifyIdentityToken(sign(), secret, 1000)).toEqual({ actorId, tenantId });
    expect(verifyIdentityToken(sign({ exp: 1 }), secret, 1000)).toBeNull();
    expect(verifyIdentityToken(sign({ aud: 'other' }), secret, 1000)).toBeNull();
    expect(verifyIdentityToken(sign({ nbf: 100 }), secret, 1000)).toBeNull();
    expect(verifyIdentityToken(sign({}, { alg: 'none' }), secret, 1000)).toBeNull();
    expect(verifyIdentityToken(sign() + 'tampered', secret, 1000)).toBeNull();
  });
  it('fails closed without bearer credentials by default', async () => {
    vi.stubEnv('AUTH_MODE', 'strict');
    const db = { query: vi.fn() };
    const { context } = request({ 'x-actor-id': actorId, 'x-tenant-id': tenantId, 'x-roles': 'finance' });
    await expect(new ContextGuard(db as any).canActivate(context)).rejects.toThrow('bearer');
    expect(db.query).not.toHaveBeenCalled();
  });
  it('ignores spoofed roles and identity headers when a signed token is used', async () => {
    vi.stubEnv('AUTH_SIGNING_SECRET', secret);
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ roles: ['customer'] }] }) };
    const { req, context } = request({ authorization: `Bearer ${sign()}`, 'x-roles': 'finance', 'x-actor-id': 'spoofed' });
    await new ContextGuard(db as any).canActivate(context);
    expect(req.context.actorId).toBe(actorId);
    expect(req.context.roles).toEqual(['customer']);
    expect(db.query.mock.calls[0][1]).toEqual([actorId, tenantId]);
  });
  it('rejects actor credentials for an absent tenant membership', async () => {
    vi.stubEnv('AUTH_SIGNING_SECRET', secret);
    const { context } = request({ authorization: `Bearer ${sign()}` });
    const db = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
    await expect(new ContextGuard(db as any).canActivate(context)).rejects.toThrow('member');
  });
});
