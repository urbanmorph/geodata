// The version of each API answer's shape. Answer cache keys (edge-cache.ts answerKey) carry
// it instead of the build id, so a deploy keeps every cached answer whose code did not
// change. Bump an endpoint's number when a change alters its answers: golden-answers.test.ts
// fails until you do (its snapshots are named by these versions).
export const ANSWER_V = {
  layers: 1,   // /api/v1/layers and /api/v1/categories
  detail: 1,   // /api/v1/layers/{id}
  schema: 1,
  query: 1,
  counts: 1,
  export: 1,   // the estimate (export rows themselves are never cached)
  nearby: 2,   // v2: tile shapes decoded with Mercator latitudes (24 Nov 2026)
  ground: 2,   // v2: locate's tiles decoded with Mercator latitudes
  surface: 2,  // v2: the same, and the default basin layer id
} as const;

export type AnswerEndpoint = keyof typeof ANSWER_V;
