// Parse a pasted admin URL (e.g. https://bharatlas.com/c/Xa9Kp7n?key=adm_xxx)
// into { id, key } for the paste-back recovery flow on /preview.
//
// Accepts: absolute http(s) URLs, scheme-less hosts (bharatlas.com/c/…),
// and bare paths (/c/<id>?key=…). Validates the id shape and that the key
// looks like an admin token. Domain is intentionally not whitelisted —
// users may run their own forks or paste from preview deployments.

export type ParseResult =
  | { ok: true; id: string; key: string }
  | { ok: false; reason: string };

const ID_RX = /^[A-Za-z0-9_-]{8,16}$/;
const KEY_RX = /^adm_[A-Za-z0-9_-]{8,}$/;

export function parseAdminUrl(input: string): ParseResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "couldn't read that URL" };

  let path: string;
  let query: URLSearchParams;
  try {
    const u = raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/')
      ? new URL(raw, 'https://bharatlas.com')
      : new URL('https://' + raw);
    path = u.pathname;
    query = u.searchParams;
  } catch {
    return { ok: false, reason: "couldn't read that URL" };
  }

  const m = path.match(/^\/c\/([^/]+)\/?$/);
  if (!m) return { ok: false, reason: 'not a submission URL' };

  const id = m[1];
  if (!ID_RX.test(id)) return { ok: false, reason: 'not a submission URL' };

  const key = query.get('key') ?? '';
  if (!key) return { ok: false, reason: 'missing key — paste the full admin URL' };
  if (!KEY_RX.test(key)) return { ok: false, reason: 'key does not look like an admin token' };

  return { ok: true, id, key };
}
