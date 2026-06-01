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
// Active-category filtering is the caller's concern — this fn returns
// matches regardless of pill, so the caller can also derive per-chip
// counts (which the pill UI needs to show "filtered/total").

export type CardLike = {
  category: string;
  primary: string;
  body: string;
  /** 'curated' | 'community'. The community pill filters on this instead
   *  of category because community submissions inherit a content category
   *  (environment, infrastructure, etc.) for the section they render in. */
  provenance?: string;
};

export type FilterResult = {
  matches: boolean[];
  countsByCategory: Map<string, number>;
  totalMatches: number;
};

/**
 * Decide per-card visibility on the home grid.
 *
 * Rules:
 *   - When the user is searching (query non-empty), the active pill is
 *     ignored — search intent overrides scoping so cross-category matches
 *     don't get silently hidden (e.g. typing "over" with Environment
 *     selected must still surface Overture in Infrastructure).
 *   - When activeCat === 'community', filter by provenance instead of
 *     content category; community submissions inherit a content category
 *     for sectioning, so the pill would otherwise match nothing.
 *   - Otherwise, scope by content category as before.
 *
 * Second arg accepts either a string[] (legacy: category per card) or a
 * CardLike[] (richer: category + provenance). The provenance lookup needs
 * the richer shape; string[] is kept for callers that don't need it.
 */
export function cardVisibility(
  matches: boolean[],
  cards: string[] | CardLike[],
  activeCat: string,
  query: string,
): boolean[] {
  const searching = query.trim().length > 0;
  const asLike = (i: number): { category: string; provenance: string } => {
    const c = cards[i];
    return typeof c === 'string' ? { category: c, provenance: '' } : { category: c.category, provenance: c.provenance || '' };
  };
  return matches.map((m, i) => {
    if (!m) return false;
    if (searching) return true;
    if (activeCat === 'all') return true;
    const { category, provenance } = asLike(i);
    if (activeCat === 'community') return provenance === 'community';
    return category === activeCat;
  });
}

export function filterCards(cards: CardLike[], query: string): FilterResult {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (!tokens.length) {
    const counts = new Map<string, number>();
    for (const c of cards) counts.set(c.category, (counts.get(c.category) || 0) + 1);
    return {
      matches: cards.map(() => true),
      countsByCategory: counts,
      totalMatches: cards.length,
    };
  }

  const matchAll = (hay: string) => tokens.every((t) => hay.includes(t));

  const primaryMatches = cards.map((c) => matchAll(c.primary));
  const anyPrimary = primaryMatches.some(Boolean);

  const matches = anyPrimary ? primaryMatches : cards.map((c) => matchAll(c.body));

  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < cards.length; i++) {
    if (matches[i]) {
      counts.set(cards[i].category, (counts.get(cards[i].category) || 0) + 1);
      total++;
    }
  }
  return { matches, countsByCategory: counts, totalMatches: total };
}
