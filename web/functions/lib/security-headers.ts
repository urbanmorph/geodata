// Shared security headers for Pages Function responses that don't inherit
// the static-asset `_headers` policy (CF Pages applies `_headers` only to
// static assets — Function responses override).
//
// Mirrors the CSP/HSTS/Permissions-Policy block in web/public/_headers so
// the curated and edge-rendered pages have the same defense-in-depth posture.
// `frame-ancestors 'self'` is the only addition vs `_headers` — it locks out
// clickjacking on Pages Function pages without breaking the same-origin embed
// mode (/c/<id>?embed=1).
//
// Apply by spreading into the Response init headers:
//   return new Response(html, {
//     headers: { ...SECURITY_HEADERS_HTML, 'content-type': 'text/html; ...' },
//   });

// Single source of truth for the CSP string — match _headers verbatim where
// possible so /about, /c/<id>, /view/<id> all look identical to a browser.
const CSP =
  "default-src 'self'; " +
  // static.cloudflareinsights.com is the Cloudflare Web Analytics beacon
  // (auto-injected by CF when the feature is enabled on the account).
  "script-src 'self' blob: https://cdn.jsdelivr.net https://challenges.cloudflare.com https://static.cloudflareinsights.com 'wasm-unsafe-eval'; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self' blob: https://cdn.jsdelivr.net https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev https://challenges.cloudflare.com; " +
  "img-src 'self' blob: data: https://*.basemaps.cartocdn.com https://tile.openstreetmap.org https://services.arcgisonline.com https://*.tile.opentopomap.org https://avatars.githubusercontent.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; " +
  "frame-src https://challenges.cloudflare.com; " +
  "frame-ancestors 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'";

const SHARED = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()',
} as const;

/** Full block for HTML-rendering Pages Functions (/c/<id>, /view/<id>). */
export const SECURITY_HEADERS_HTML = {
  ...SHARED,
  'content-security-policy': CSP,
} as const;

/** Non-HTML responses (sitemap.xml, future XML/JSON) — CSP is irrelevant
 *  but the cheap headers still tighten defense-in-depth. */
export const SECURITY_HEADERS_NON_HTML = SHARED;
