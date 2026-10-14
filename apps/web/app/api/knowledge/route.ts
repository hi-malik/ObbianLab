import { NextRequest, NextResponse } from 'next/server';
import { aiHeaders, BodyReadError, getIdentity, readBoundedBody, sameOrigin } from '../../../lib/session';
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: 'Invalid origin' }, { status: 403 });
  const identity = getIdentity(request);
  if (!identity) return NextResponse.json({ detail: 'Sign in to search knowledge' }, { status: 401 });
  try {
    const body = (await readBoundedBody(request, 12000)).toString('utf8');
    const response = await fetch(`${process.env.AI_SERVICE_URL ?? 'http://localhost:8000'}/rag/query`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...aiHeaders(identity) }, body,
      cache: 'no-store', signal: AbortSignal.timeout(45000),
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof BodyReadError) return NextResponse.json({ detail: error.message }, { status: error.status }); return NextResponse.json({ detail: 'Knowledge search is temporarily unavailable' }, { status: 503 }); }
}
