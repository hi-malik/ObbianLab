import { NextRequest, NextResponse } from 'next/server';
import { aiHeaders, BodyReadError, getIdentity, readBoundedBody, sameOrigin } from '../../../lib/session';
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: 'Invalid origin' }, { status: 403 });
  const identity = getIdentity(request);
  if (!identity) return NextResponse.json({ detail: 'Sign in to request a booking' }, { status: 401 });
  try {
    const raw = await readBoundedBody(request, 10500000);
    let body: FormData;
    try {
      body = await new Response(new Uint8Array(raw), { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    } catch {
      return NextResponse.json({ detail: 'Invalid multipart audio upload' }, { status: 400 });
    }
    const file = body.get('file');
    if (!(file instanceof File) || file.size === 0 || file.size > 10000000) return NextResponse.json({ detail: 'An audio file up to 10 MB is required' }, { status: 422 });
    const response = await fetch(`${process.env.AI_SERVICE_URL ?? 'http://localhost:8000'}/agent/voice`, {
      method: 'POST', headers: aiHeaders(identity), body, cache: 'no-store', signal: AbortSignal.timeout(60000),
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof BodyReadError) return NextResponse.json({ detail: error.message }, { status: error.status });
    return NextResponse.json({ detail: 'Voice service unavailable. You can enter your request as text.' }, { status: 503 });
  }
}
