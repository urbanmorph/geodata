// Shared security headers for Pages Function responses that don't inherit
// the static-asset `_headers` policy (CF Pages applies `_headers` only to
// static assets — Function responses override).
//
// CSP is declared as a structured allowlist below and serialised twice:
//   CSP_STATIC  — mirrors web/public/_headers verbatim (no frame-ancestors,
//                 since classic Pages can't set it via _headers reliably).
//   CSP_HTML    — Pages Function variant; adds `frame-ancestors 'self'` to
//                 lock out clickjacking on /c/<id>, /view/<id>, etc.
//
// Why structured: PR-A (#103) introduced a strict CSP, and two latent
// allowlist gaps surfaced later (CF Web Analytics in #111, the DuckDB
// extensions CDN in #114). Both required updating two files in lockstep.
// With a single source of truth here + a sync assertion in
// tests/security-headers.test.ts, adding an origin is one diff and a
// drift between the files fails CI instead of shipping silently.
//
// Apply by spreading into the Response init headers:
//   return new Response(html, {
//     headers: { ...SECURITY_HEADERS_HTML, 'content-type': 'text/html; ...' },
//   });

// Each directive lists its allowed sources in deployment order. The trailing
// per-line comments are the audit log — any reviewer can scan WHY a host is
// reachable from the browser.
const CSP_DIRECTIVES: Array<[directive: string, sources: string[]]> = [
  ['default-src', ["'self'"]],
  ['script-src', [
    "'self'",
    'blob:',                                  // DuckDB-WASM worker bootstrap
    'https://cdn.jsdelivr.net',               // DuckDB-WASM + MapLibre bundle
    'https://challenges.cloudflare.com',      // Turnstile widget
    'https://static.cloudflareinsights.com',  // CF Web Analytics beacon (auto-injected)
    "'wasm-unsafe-eval'",                     // DuckDB-WASM WebAssembly execution
  ]],
  ['worker-src', ["'self'", 'blob:']],        // DuckDB-WASM workers
  ['connect-src', [
    "'self'",
    'blob:',
    'https://cdn.jsdelivr.net',                                     // DuckDB-WASM bundle fetches
    'https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev',          // R2 public bucket — catalog parquets, pmtiles
    'https://challenges.cloudflare.com',                            // Turnstile API
    'https://extensions.duckdb.org',                                // DuckDB-WASM lazy `parquet` extension fetch
    'https://*.basemaps.cartocdn.com',                              // Carto Light raster tiles — MapLibre loads them via fetch()
    'https://*.tile.opentopomap.org',                               // OpenTopoMap raster tiles — MapLibre loads them via fetch()
    'https://services.arcgisonline.com',                            // Esri World Imagery raster tiles — MapLibre loads them via fetch()
  ]],
  ['img-src', [
    "'self'",
    'blob:',
    'data:',                                       // inline data URIs (favicons, svg)
    'https://*.basemaps.cartocdn.com',             // Carto Light/Dark basemap tiles
    'https://tile.openstreetmap.org',              // OSM basemap tiles
    'https://services.arcgisonline.com',           // Esri World Imagery basemap tiles
    'https://*.tile.opentopomap.org',              // OpenTopoMap basemap tiles
    'https://avatars.githubusercontent.com',       // GitHub avatars in /about credits
  ]],
  ['style-src', ["'self'", "'unsafe-inline'"]],   // inline <style> in prerendered HTML
  ['font-src', ["'self'"]],
  ['frame-src', ['https://challenges.cloudflare.com']],  // Turnstile iframe
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
];

function serialise(directives: Array<[string, string[]]>): string {
  return directives.map(([d, s]) => `${d} ${s.join(' ')}`).join('; ');
}

/** CSP string mirrored to web/public/_headers. */
export const CSP_STATIC: string = serialise(CSP_DIRECTIVES);

/** CSP string used by Pages Function HTML responses. Adds frame-ancestors
 *  'self' between frame-src and object-src to block clickjacking while
 *  keeping the same-origin embed mode (/c/<id>?embed=1) working. */
export const CSP_HTML: string = serialise(
  CSP_DIRECTIVES.flatMap(([d, s]) =>
    d === 'object-src'
      ? ([['frame-ancestors', ["'self'"]], [d, s]] as Array<[string, string[]]>)
      : ([[d, s]] as Array<[string, string[]]>),
  ),
);

const SHARED = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(self), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()',
} as const;

/** Full block for HTML-rendering Pages Functions (/c/<id>, /view/<id>). */
export const SECURITY_HEADERS_HTML = {
  ...SHARED,
  'content-security-policy': CSP_HTML,
} as const;

/** Non-HTML responses (sitemap.xml, future XML/JSON) — CSP is irrelevant
 *  but the cheap headers still tighten defense-in-depth. */
export const SECURITY_HEADERS_NON_HTML = SHARED;
