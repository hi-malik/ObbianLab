import { NextRequest, NextResponse } from 'next/server';
import { BodyReadError, readBoundedBody } from '../../../../lib/session';
// Stripe authenticates the exact raw body at the API; browser session/CSRF is
// intentionally irrelevant to this server-to-server endpoint.
export async function POST(request: NextRequest) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ detail: 'Signature required' }, { status: 401 });
  try {
    const body = await readBoundedBody(request, 1_000_000);
    if (!body.byteLength) return new NextResponse(null, { status: 400 });
    const response = await fetch(`${process.env.BOOKING_API_URL ?? 'http://localhost:3001'}/webhooks/stripe`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: new Uint8Array(body), signal: AbortSignal.timeout(15000), cache: 'no-store',
    });
    return new NextResponse(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    if (error instanceof BodyReadError) return NextResponse.json({ detail: error.message }, { status: error.status });
    return NextResponse.json({ detail: 'Webhook processing unavailable; retry delivery' }, { status: 503 });
  }
}
