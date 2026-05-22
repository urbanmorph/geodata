// Shared response helpers for /og/view and /og/c endpoints — identical
// cache policy and error shape, so a single source of truth.

export const PNG_HEADERS = {
  'content-type': 'image/png',
  'cache-control': 'public, max-age=2592000, s-maxage=2592000, stale-while-revalidate=86400',
};

export function ogError(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}
