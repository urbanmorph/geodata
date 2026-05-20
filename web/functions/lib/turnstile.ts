// Cloudflare Turnstile siteverify call. Fails closed on any error path.

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string | null | undefined,
  secret: string,
  fetchFn: FetchFn = fetch,
): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const body = `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`;
  try {
    const r = await fetchFn(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { success?: boolean };
    return j.success === true;
  } catch {
    return false;
  }
}
