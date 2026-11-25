// The version of each API answer's shape. Answer cache keys (edge-cache.ts answerKey) carry
// it instead of the build id, so a deploy keeps every cached answer whose code did not
// change. Bump an endpoint's number when a change alters its answers: golden-answers.test.ts
// fails until you do (its snapshots are named by these versions).
export const ANSWER_V = {
  layers: 1,   // /api/v1/layers and /api/v1/categories
  detail: 1,   // /api/v1/layers/{id}
  schema: 1,
  query: 2,    // v2: the __mlocate fields of a converted file left out of the default columns (25 Nov 2026)
  counts: 1,
  export: 1,   // the estimate (export rows themselves are never cached)
  nearby: 3,   // v3: __mlocate fields dropped (25 Nov 2026); v2: Mercator latitudes (24 Nov 2026)
  ground: 5,   // v5: water is no rock (the 1:2,000,000 map speaks); v4: not assessed, year 0, subsidence (25 Nov 2026)
  surface: 5,  // v5: basin said once, FSI forest named, a sanctuary named by kind says its state; v4: airports, ward (25 Nov 2026)
} as const;

export type AnswerEndpoint = keyof typeof ANSWER_V;
