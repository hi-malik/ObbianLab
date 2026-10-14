import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { BodyReadError, readBoundedBody, verifyToken } from '../lib/session';
import { POST as signIn } from '../app/api/session/route';
import { POST as uploadVoice } from '../app/api/voice/route';

function streamed(parts: string[], headers: Record<string, string> = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { request: new NextRequest('https://app.example/api/session', { method: 'POST', headers, body, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]), cancelled: () => cancelled };
}

async function environment(values: Record<string, string>, fn: () => Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, values);
  try { await fn(); } finally { process.env = saved; }
}

test('body cap checks actual chunked bytes without requiring Content-Length', async () => {
  assert.equal((await readBoundedBody(streamed(['ab', 'cd']).request, 4)).toString(), 'abcd');
  await assert.rejects(() => readBoundedBody(streamed(['abc', 'def']).request, 5), error => error instanceof BodyReadError && error.status === 413);
});

test('small claimed length cannot bypass actual byte cap', async () => {
  await assert.rejects(() => readBoundedBody(streamed(['abcdef'], { 'content-length': '1' }).request, 5), error => error instanceof BodyReadError && error.status === 413);
});

test('malformed and negative lengths fail before buffering', async () => {
  for (const value of ['-1', 'invalid', '1.2']) {
    await assert.rejects(() => readBoundedBody(streamed(['x'], { 'content-length': value }).request, 5), error => error instanceof BodyReadError && error.status === 400);
  }
});

test('UTF-8 limit counts bytes rather than string characters', async () => {
  await assert.rejects(() => readBoundedBody(streamed(['हिंदी']).request, 5), error => error instanceof BodyReadError && error.status === 413);
});

test('malformed JSON shapes are rejected without crashing session route', async () => {
  await environment({ PUBLIC_ORIGIN: 'https://app.example', AUTH_MODE: 'strict' }, async () => {
    for (const value of ['null', '[]', '"string"', '{']) {
      const response = await signIn(streamed([value], { origin: 'https://app.example' }).request);
      assert.ok(response.status === 400 || response.status === 401);
    }
    const oversized = await signIn(streamed([' '.repeat(11000)], { origin: 'https://app.example' }).request);
    assert.equal(oversized.status, 413);
  });
});

test('valid signed identity rejects expiry, wrong audience and signature tampering', async () => {
  const secret = 'synthetic-test-signing-secret-over-32';
  const makeToken = (update: Record<string, unknown> = {}) => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const value = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({
      sub: '22222222-2222-4222-8222-222222222222', tenantId: '11111111-1111-4111-8111-111111111111', aud: 'obbian', exp: Date.now() / 1000 + 60, ...update,
    });
    return value + '.' + createHmac('sha256', secret).update(value).digest('base64url');
  };
  await environment({ AUTH_SIGNING_SECRET: secret }, async () => {
    assert.equal(verifyToken(makeToken())?.actorId, '22222222-2222-4222-8222-222222222222');
    assert.equal(verifyToken(makeToken({ exp: 1 })), null);
    assert.equal(verifyToken(makeToken({ aud: 'attacker' })), null);
    assert.equal(verifyToken(makeToken({ nbf: Date.now() / 1000 + 3600 })), null);
    assert.equal(verifyToken(makeToken() + 'tampered'), null);
  });
});

test('valid chunked multipart audio is accepted and forwarded', async () => {
  await environment({ AUTH_MODE: 'demo', PUBLIC_ORIGIN: 'https://app.example', DEMO_CUSTOMER_ID: '22222222-2222-4222-8222-222222222222', DEMO_TENANT_ID: '11111111-1111-4111-8111-111111111111', AI_DEMO_TOKEN: 'local-test-token' }, async () => {
    const form = new FormData();
    form.set('file', new File(['RIFF-demo-audio'], 'speech.wav', { type: 'audio/wav' }));
    const serialized = new Response(form);
    const body = await serialized.arrayBuffer();
    const request = new NextRequest('https://app.example/api/voice', {
      method: 'POST', headers: { origin: 'https://app.example', 'content-type': serialized.headers.get('content-type')! },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(body)); controller.close(); } }), duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      assert.ok(init?.body instanceof FormData);
      assert.equal((init.body.get('file') as File).name, 'speech.wav');
      return Response.json({ stage: 'collecting' });
    };
    try {
      const response = await uploadVoice(request);
      assert.equal(response.status, 200);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('webhook proxy preserves exact raw bytes and signature', async () => {
  const { POST: webhook } = await import('../app/api/payments/webhook/route');
  const raw = Buffer.from(' \n{"amount":"₹100"}\n');
  const request = new NextRequest('https://app.example/api/payments/webhook', {
    method: 'POST', headers: { 'stripe-signature': 't=123,v1=signature' }, body: raw,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(Buffer.from(init?.body as Uint8Array), raw);
    assert.equal(new Headers(init?.headers).get('stripe-signature'), 't=123,v1=signature');
    return Response.json({ received: true });
  };
  try { assert.equal((await webhook(request)).status, 200); }
  finally { globalThis.fetch = originalFetch; }
});
