import { NextRequest, NextResponse } from 'next/server';
import { BodyReadError, getIdentity, readBoundedBody, sameOrigin, verifyToken } from '../../../lib/session';

export async function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: Boolean(getIdentity(request)), demo: process.env.AUTH_MODE === 'demo', ...(process.env.AI_PROVIDER_MODE === 'offline' ? { offline: true } : {}) }, { headers: { 'cache-control': 'no-store' } });
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: 'Invalid origin' }, { status: 403 });
  let body;
  try { body = JSON.parse((await readBoundedBody(request, 10000)).toString('utf8')); }
  catch (error) {
    if (error instanceof BodyReadError) return NextResponse.json({ detail: error.message }, { status: error.status });
    return NextResponse.json({ detail: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.token !== 'string' || body.token.length > 8000 || !verifyToken(body.token)) {
    return NextResponse.json({ detail: 'Invalid or expired access token' }, { status: 401 });
  }
  const response = NextResponse.json({ authenticated: true }, { headers: { 'cache-control': 'no-store' } });
  response.cookies.set('obbian_session', body.token, { httpOnly: true, secure: process.env.AUTH_MODE !== 'demo', sameSite: 'strict', path: '/', maxAge: 3600 });
  return response;
}
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: 'Invalid origin' }, { status: 403 });
  const response = NextResponse.json({ authenticated: false }, { headers: { 'cache-control': 'no-store' } });
  response.cookies.delete('obbian_session');
  return response;
}
