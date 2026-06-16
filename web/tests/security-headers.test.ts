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

  it('sets Content-Security-Policy', () => {
    expect(headersFile).toMatch(/^\s*Content-Security-Policy:/m);
  });

  it('CSP allows WASM execution via wasm-unsafe-eval', () => {
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain("'wasm-unsafe-eval'");
  });

  it('CSP allows blob: workers for DuckDB', () => {
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain('worker-src');
    expect(csp![1]).toContain('blob:');
  });

  it('CSP allows jsdelivr for DuckDB WASM bundles', () => {
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain('https://cdn.jsdelivr.net');
  });

  it('CSP allows Cloudflare Turnstile', () => {
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain('https://challenges.cloudflare.com');
  });

  it('CSP allows Cloudflare Web Analytics beacon', () => {
    // CF auto-injects <script src="https://static.cloudflareinsights.com/beacon.min.js/...">
    // when Web Analytics is enabled at the account level. Without explicit allow
    // it gets blocked and the console fills with CSP violations.
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain('https://static.cloudflareinsights.com');
  });

  it('CSP connect-src allows the DuckDB extensions CDN', () => {
    // DuckDB-WASM lazily fetches the `parquet` extension from
    // extensions.duckdb.org the first time the Filter & export panel
    // queries a parquet. Without an explicit connect-src allow the
    // browser blocks the fetch and DuckDB errors with the cryptic
    // "table index is out of bounds" — the codec never loaded.
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    expect(csp![1]).toContain('https://extensions.duckdb.org');
  });

  it('CSP does not use unsafe-eval (only wasm-unsafe-eval)', () => {
    const csp = headersFile.match(/Content-Security-Policy:\s*([^\n]+)/);
    expect(csp).not.toBeNull();
    const stripped = csp![1].replace(/'wasm-unsafe-eval'/g, '');
    expect(stripped).not.toContain("'unsafe-eval'");
  });

  it('keeps X-Content-Type-Options nosniff (already on by CF default; pin it)', () => {
    expect(headersFile).toMatch(/X-Content-Type-Options:\s*nosniff/i);
  });

  it('sets Referrer-Policy to strict-origin-when-cross-origin', () => {
    expect(headersFile).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/i);
  });
});

import {
  SECURITY_HEADERS_HTML,
  SECURITY_HEADERS_NON_HTML,
  CSP_STATIC,
  CSP_HTML,
} from '../functions/lib/security-headers';

describe('Security headers — sync between _headers and security-headers.ts', () => {
  // CSP is declared once as a structured allowlist in security-headers.ts.
  // Both surfaces (static _headers, Pages Function SECURITY_HEADERS_HTML)
  // derive from that source. These tests catch drift: if someone adds an
  // origin in one place and forgets the other, CI fails loudly instead of
  // shipping a half-applied policy.
  const headersFile = readFileSync(resolve(__dirname, '..', 'public', '_headers'), 'utf8');

  it('_headers CSP matches CSP_STATIC byte-for-byte', () => {
    expect(headersFile).toContain(`Content-Security-Policy: ${CSP_STATIC}`);
  });

  it('SECURITY_HEADERS_HTML CSP equals CSP_HTML', () => {
    expect(SECURITY_HEADERS_HTML['content-security-policy']).toBe(CSP_HTML);
  });

  it("CSP_HTML differs from CSP_STATIC only by frame-ancestors 'self'", () => {
    // The Pages Function variant adds clickjacking protection. If they
    // diverge any further, the audit narrative breaks.
    expect(CSP_HTML).toContain(CSP_STATIC.replace('object-src', "frame-ancestors 'self'; object-src"));
  });
});

describe('Security headers — CSP connect-src reaches the basemap tile CDNs', () => {
  // MapLibre GL fetches raster basemap tiles with the Fetch API, so the tile
  // hosts must be in connect-src. Listing them only in img-src (as we did
  // originally) is not enough — the real fetch() is blocked, so Carto Light /
  // OpenTopoMap / Esri Imagery render blank while the same-origin Minimal
  // basemap is fine. Regression guard for the "base maps won't load" report.
  const TILE_HOSTS = [
    'https://*.basemaps.cartocdn.com', // Carto Light
    'https://*.tile.opentopomap.org', // OpenTopoMap
    'https://services.arcgisonline.com', // Esri World Imagery
  ];

  const connectSources = (csp: string): string[] => {
    const seg = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('connect-src '));
    return seg ? seg.split(/\s+/).slice(1) : [];
  };

  it('CSP_STATIC connect-src lists every external basemap tile host', () => {
    const sources = connectSources(CSP_STATIC);
    for (const host of TILE_HOSTS) {
      expect(sources, `connect-src missing ${host}`).toContain(host);
    }
  });

  it('CSP_HTML connect-src lists every external basemap tile host', () => {
    const sources = connectSources(CSP_HTML);
    for (const host of TILE_HOSTS) {
      expect(sources, `connect-src missing ${host}`).toContain(host);
    }
  });
});

describe('Security headers — SECURITY_HEADERS_HTML (Pages Function responses)', () => {
  // CF Pages applies `_headers` only to static assets, not to Pages Function
  // responses. The HTML-rendering Pages Functions (/c/<id>, /view/<id>)
  // explicitly spread SECURITY_HEADERS_HTML so they get the same
  // defense-in-depth posture as prerendered HTML.

  it('sets Strict-Transport-Security', () => {
    expect(SECURITY_HEADERS_HTML['strict-transport-security']).toMatch(/^max-age=\d+/);
    expect(SECURITY_HEADERS_HTML['strict-transport-security']).toMatch(/includeSubDomains/);
  });

  it('sets X-Content-Type-Options: nosniff', () => {
    expect(SECURITY_HEADERS_HTML['x-content-type-options']).toBe('nosniff');
  });

  it('sets Referrer-Policy', () => {
    expect(SECURITY_HEADERS_HTML['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets Permissions-Policy denying sensitive capabilities', () => {
    const pp = SECURITY_HEADERS_HTML['permissions-policy'];
    expect(pp).toMatch(/camera=\(\)/);
    expect(pp).toMatch(/microphone=\(\)/);
    expect(pp).toMatch(/geolocation=\(\)/);
  });

  it('CSP includes frame-ancestors to block clickjacking', () => {
    // Mirrors `_headers` CSP but adds `frame-ancestors 'self'` so iframe
    // embeds outside bharatlas are blocked.
    expect(SECURITY_HEADERS_HTML['content-security-policy']).toMatch(/frame-ancestors\s+'self'/);
  });

  it("CSP keeps default-src to 'self' and locks object-src", () => {
    const csp = SECURITY_HEADERS_HTML['content-security-policy'];
    expect(csp).toMatch(/default-src\s+'self'/);
    expect(csp).toMatch(/object-src\s+'none'/);
    expect(csp).toMatch(/base-uri\s+'self'/);
  });

  it('CSP whitelists the same runtime origins as static _headers', () => {
    const csp = SECURITY_HEADERS_HTML['content-security-policy'];
    // Cloudflare Turnstile widget
    expect(csp).toMatch(/https:\/\/challenges\.cloudflare\.com/);
    // MapLibre + DuckDB-WASM lazy load
    expect(csp).toMatch(/https:\/\/cdn\.jsdelivr\.net/);
    // R2 public reads for layer downloads
    expect(csp).toMatch(/https:\/\/pub-0429b8e3b5a946e69ea007df844a6f1c\.r2\.dev/);
  });

  it('CSP allows the Cloudflare Web Analytics beacon', () => {
    // CF auto-injects <script src="https://static.cloudflareinsights.com/...">
    // on every response from a domain with Web Analytics enabled. Without
    // an explicit allow the browser blocks it on every Pages Function page.
    expect(SECURITY_HEADERS_HTML['content-security-policy'])
      .toContain('https://static.cloudflareinsights.com');
  });

  it('CSP connect-src allows the DuckDB extensions CDN', () => {
    // DuckDB-WASM lazily fetches extensions from extensions.duckdb.org
    // when the Filter & export panel queries a parquet for the first
    // time. Blocked = silent "table index out of bounds" runtime error.
    expect(SECURITY_HEADERS_HTML['content-security-policy'])
      .toContain('https://extensions.duckdb.org');
  });
});

describe('Security headers — SECURITY_HEADERS_NON_HTML (sitemap.xml etc.)', () => {
  // Non-HTML responses don't need CSP but do benefit from HSTS + nosniff.

  it('sets the cheap headers (HSTS, nosniff, RP, PP)', () => {
    expect(SECURITY_HEADERS_NON_HTML['strict-transport-security']).toBeDefined();
    expect(SECURITY_HEADERS_NON_HTML['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS_NON_HTML['referrer-policy']).toBeDefined();
    expect(SECURITY_HEADERS_NON_HTML['permissions-policy']).toBeDefined();
  });

  it('does NOT set Content-Security-Policy (irrelevant for non-HTML)', () => {
    expect((SECURITY_HEADERS_NON_HTML as Record<string, string>)['content-security-policy']).toBeUndefined();
  });
});
