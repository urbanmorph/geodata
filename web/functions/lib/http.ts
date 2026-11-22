// JSON responses for the API routes. BigInt-safe: hyparquet returns INT64
// columns as bigint, which JSON.stringify would throw on.

export function safeStringify(obj: unknown, space?: number): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), space);
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(safeStringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** The API's error shape: { error, status }. */
export const apiError = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  json(status, { error, status }, headers);

/** A 500 for a failure the caller can't fix: the detail (R2 keys, parser
 *  internals) goes to the Worker log, never into the response. */
export function serverError(what: string, e: unknown): Response {
  console.error(`${what} failed:`, e instanceof Error ? e.stack || e.message : e);
  return apiError(500, `${what} failed. Please try again; if it keeps failing, tell us at https://github.com/urbanmorph/geodata/issues.`);
}
