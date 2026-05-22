import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Security headers — Cloudflare Pages _headers file', () => {
  // _headers is parsed by Cloudflare Pages at build time; we keep it in
  // /public so Vite copies it into /dist. The file maps path globs to
  // header sets — we apply the security policy to "/*" (all routes).
  const headersFile = readFileSync(resolve(__dirname, '..', 'public', '_headers'), 'utf8');

  // Block for "/*" must exist
  it('has a "/*" block', () => {
    expect(headersFile).toMatch(/^\/\*$/m);
  });

  it('sets Strict-Transport-Security with at least 1 year max-age', () => {
    // HSTS forces HTTPS for the site for the given duration. 31536000s = 1y.
    // includeSubDomains so the rule extends to any future subdomain.
    const m = headersFile.match(/Strict-Transport-Security:\s*max-age=(\d+)[^\n]*/);
    expect(m, 'HSTS header missing').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(31536000);
    expect(m![0]).toMatch(/includeSubDomains/);
  });

  it('sets Permissions-Policy to deny sensitive capabilities by default', () => {
    // We're a read-only map atlas. No camera, no mic, no geolocation —
    // explicit deny keeps the user privacy floor high + improves
    // Best Practices score.
    const pp = headersFile.match(/Permissions-Policy:\s*([^\n]+)/);
    expect(pp, 'Permissions-Policy missing').not.toBeNull();
    const v = pp![1];
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(v, `Permissions-Policy missing deny for ${feature}`).toMatch(
        new RegExp(`${feature}=\\(\\)`),
      );
    }
  });

  // CSP temporarily removed pending v4.0.2 DuckDB debugging.
  // Tests will reinstate once we know the safe directive set.
  it('CSP is intentionally OFF — re-enable in v4.0.2 after debugging DuckDB worker init', () => {
    expect(headersFile).not.toMatch(/^\s*Content-Security-Policy:/m);
  });

  it('keeps X-Content-Type-Options nosniff (already on by CF default; pin it)', () => {
    expect(headersFile).toMatch(/X-Content-Type-Options:\s*nosniff/i);
  });

  it('sets Referrer-Policy to strict-origin-when-cross-origin', () => {
    expect(headersFile).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/i);
  });
});
