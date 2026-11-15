// JSON responses for the API routes. BigInt-safe: hyparquet returns INT64
// columns as bigint, which JSON.stringify would throw on.

export function safeStringify(obj: unknown, space?: number): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), space);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
