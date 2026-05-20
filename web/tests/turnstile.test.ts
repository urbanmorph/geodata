import { describe, it, expect } from 'vitest';
import { verifyTurnstile } from '../functions/lib/turnstile';

function okFetch(body: object) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('verifyTurnstile', () => {
  it('returns true when Cloudflare reports success', async () => {
    expect(await verifyTurnstile('valid', 'secret', okFetch({ success: true }))).toBe(true);
  });

  it('returns false when Cloudflare reports failure', async () => {
    expect(
      await verifyTurnstile('bad', 'secret', okFetch({ success: false, 'error-codes': ['invalid-input-response'] })),
    ).toBe(false);
  });

  it('returns false when the token is missing / empty', async () => {
    expect(await verifyTurnstile('', 'secret', okFetch({ success: true }))).toBe(false);
    expect(await verifyTurnstile(null as unknown as string, 'secret', okFetch({ success: true }))).toBe(false);
  });

  it('returns false on non-2xx response', async () => {
    const errFetch = async () => new Response('boom', { status: 500 });
    expect(await verifyTurnstile('valid', 'secret', errFetch)).toBe(false);
  });

  it('returns false on network throw', async () => {
    const throwFetch = async () => {
      throw new Error('network');
    };
    expect(await verifyTurnstile('valid', 'secret', throwFetch)).toBe(false);
  });

  it('posts secret + token to siteverify as form-encoded body', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const fetchFn = async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    await verifyTurnstile('the-token', 'the-secret', fetchFn);
    expect(capturedUrl).toContain('siteverify');
    expect(capturedBody).toContain('secret=the-secret');
    expect(capturedBody).toContain('response=the-token');
  });
});
