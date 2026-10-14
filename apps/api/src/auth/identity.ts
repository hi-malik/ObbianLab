import { createHmac, timingSafeEqual } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface Identity { actorId: string; tenantId: string }
export function constantTimeEqual(value: string, expected: string): boolean {
  const a = Buffer.from(value); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyIdentityToken(token: string, secret: string | undefined, now = Date.now()): Identity | null {
  if (!secret || secret.length < 32 || token.length > 4096) return null;
  const [header, payload, signature, extra] = token.split('.');
  if (!header || !payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, 'base64url').toString());
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (h.alg !== 'HS256' || h.typ !== 'JWT' || p.aud !== 'obbian'
      || !UUID.test(p.sub ?? '') || !UUID.test(p.tenantId ?? '')
      || !Number.isSafeInteger(p.exp) || p.exp * 1000 <= now
      || (p.nbf !== undefined && (!Number.isSafeInteger(p.nbf) || p.nbf * 1000 > now))) return null;
    return { actorId: p.sub, tenantId: p.tenantId };
  } catch { return null; }
}
