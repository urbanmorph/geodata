// The version of each API answer's shape. Answer cache keys (edge-cache.ts answerKey) carry
// it instead of the build id, so a deploy keeps every cached answer whose code did not
// change. Bump an endpoint's number when a change alters its answers: golden-answers.test.ts
// fails until you do (its snapshots are named by these versions).
export const ANSWER_V = {
  layers: 3,   // v3: requested_by may carry url and logo (28 Nov 2026). v2: requested_by on a requested layer; a search that finds nothing says how to request one (28 Nov 2026)
  detail: 3,   // v3: requested_by may carry url and logo (28 Nov 2026). v2: requested_by on a requested layer (28 Nov 2026)
  schema: 1,
  query: 2,    // v2: the __mlocate fields of a converted file left out of the default columns (25 Nov 2026)
  counts: 1,
  export: 1,   // the estimate (export rows themselves are never cached)
  nearby: 3,   // v3: __mlocate fields dropped (25 Nov 2026); v2: Mercator latitudes (24 Nov 2026)
  ground: 6,   // v6: a zone within 2 km of a coarse coast answers (Great Nicobar); v5: water is no rock (25 Nov 2026)
  surface: 7,  // v7: outside India or at sea, the outline distance said once and no Indian services abroad; v6: airports with a code (25 Nov 2026)
} as const;

export type AnswerEndpoint = keyof typeof ANSWER_V;
