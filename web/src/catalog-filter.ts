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
};

export type FilterResult = {
  matches: boolean[];
  countsByCategory: Map<string, number>;
  totalMatches: number;
};

/**
 * Decide per-card visibility on the home grid.
 *
 * Earlier behaviour was `matches AND inActiveCategory` for every card. That
 * made search results depend on whether the matched layer happened to be
 * categorised into the currently-selected pill — invisible context to the
 * user. Typing `over` with `Environment` selected returned "No matches",
 * even though Overture Places (in `infrastructure`) clearly matched.
 *
 * New rule: when the user is searching (query non-empty), the active pill
 * is ignored — search intent ("find me this thing") overrides scoping
 * intent ("show me only this category"). When the query is empty, the
 * pill scopes the catalog as before. Pill counts continue to show
 * filtered/total in both modes so the distribution stays visible.
 */
export function cardVisibility(
  matches: boolean[],
  categories: string[],
  activeCat: string,
  query: string,
): boolean[] {
  const searching = query.trim().length > 0;
  return matches.map((m, i) => m && (searching || activeCat === 'all' || categories[i] === activeCat));
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
