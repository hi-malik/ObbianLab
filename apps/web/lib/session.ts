import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';

export type Identity = { actorId: string; tenantId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function verifyToken(token: string): Identity | null {
  const secret = process.env.AUTH_SIGNING_SECRET;
  if (!secret || secret.length < 32) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const meta = JSON.parse(Buffer.from(header, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const now = Date.now() / 1000;
    if (meta.alg !== 'HS256' || claims.aud !== 'obbian' || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now)) || !uuid.test(claims.sub) || !uuid.test(claims.tenantId)) return null;
    return { actorId: claims.sub, tenantId: claims.tenantId };
  } catch { return null; }
}

export function getIdentity(request: NextRequest): Identity | null {
  if (process.env.AUTH_MODE === 'demo') {
    return { actorId: process.env.DEMO_CUSTOMER_ID ?? '', tenantId: process.env.DEMO_TENANT_ID ?? '' };
  }
  return verifyToken(request.cookies.get('obbian_session')?.value ?? '');
}

export function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  // Browser mutations always have Origin. Non-browser clients without cookies
  // still need bearer authentication at the API instead of this browser proxy.
  const expected = process.env.PUBLIC_ORIGIN;
  if (expected) return origin === expected;
  return process.env.AUTH_MODE === 'demo' && (origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000');
}

export function aiHeaders(identity: Identity): Record<string, string> {
  const token = process.env.AI_SERVICE_TOKEN ?? (process.env.AUTH_MODE === 'demo' ? process.env.AI_DEMO_TOKEN : undefined);
  if (!token) throw new Error('Assistant credentials are not configured');
  return { authorization: `Bearer ${token}`, 'x-tenant-id': identity.tenantId, 'x-actor-id': identity.actorId };
}

export class BodyReadError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

/** Count actual stream bytes before buffering/parsing. Content-Length is only an early check. */
export async function readBoundedBody(request: NextRequest, maximumBytes: number): Promise<Buffer> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new BodyReadError('Invalid content length', 400);
  }
  if (declared !== null && Number(declared) > maximumBytes) throw new BodyReadError('Request too large', 413);
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel();
        throw new BodyReadError('Request too large', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, received);
}
