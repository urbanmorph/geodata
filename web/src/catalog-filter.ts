// Two-tier search filter for the catalog home page.
//
// Why two tiers: the single-haystack version surfaced any card whose
// description mentioned a keyword. Typing "villages" returned Districts,
// Sub-districts and Blocks because their descriptions explain how they
// join to villages. Users searching for a term want layers ABOUT that
// term, not layers that reference it.
//
// Each card carries:
//   - primary: title + level + level-aliases. The high-signal "this card
//     is about X" haystack. Title-word matches surface here.
//   - body:    description + license + tags + provider names + formats.
//     Lower-signal but still searchable for queries like "tehsil" (an
//     alias-less synonym that lives in the description prose).
//
// Algorithm: every token must match the same tier. Prefer primary. If
// no card has a primary match for the full token set, fall back to body
// for every card. Mode is decided globally, not per-card, so that
// "villages" doesn't quietly fall through to body matches on Districts
// while Villages itself surfaces via primary.
//
// One matcher for both searches: the home popover (over /layer-index.json) and
// the /layers filter (over its rows). Both count matching rows, so "See all N"
// on the home page lands on N matches on /layers.

export type CardLike = {
  primary: string;
  body: string;
  /** Layers this row holds (a level's primary source plus alternates); 1 if absent. */
  layers?: number;
};

export type FilterResult = {
  matches: boolean[];
  /** Matching rows. */
  totalMatches: number;
  /** Layers in the matching rows: the number the site shows (it counts layers, not rows). */
  totalLayers: number;
};

/** The one wording both searches use: "9 layers match "district"". */
export const matchLine = (n: number, query: string): string =>
  `${n} layer${n === 1 ? ' matches' : 's match'} "${query}"`;

function matchTokens(cards: CardLike[], tokens: string[]): boolean[] {
  if (!tokens.length) return cards.map(() => true);
  const matchAll = (hay: string) => tokens.every((t) => hay.includes(t));
  const primary = cards.map((c) => matchAll(c.primary));
  return primary.some(Boolean) ? primary : cards.map((c) => matchAll(c.body));
}

export function filterCards(cards: CardLike[], query: string): FilterResult {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  let matches = matchTokens(cards, tokens);
  // "ward 9 ahmedabad": no card holds "9". Retry without bare numbers so the
  // Ahmedabad ward map still shows (the home search's answer card names ward 9).
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  if (!matches.some(Boolean) && words.length && words.length < tokens.length) matches = matchTokens(cards, words);

  return {
    matches,
    totalMatches: matches.filter(Boolean).length,
    totalLayers: cards.reduce((n, c, i) => n + (matches[i] ? (c.layers ?? 1) : 0), 0),
  };
}
