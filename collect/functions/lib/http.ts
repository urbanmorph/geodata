// JSON response helpers. Same-origin in practice (collect calls its own /api),
// but tag permissive CORS so tools can read too.

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });

export const ok = (body: unknown): Response => json(200, body);
export const bad = (status: number, error: string): Response => json(status, { error });
