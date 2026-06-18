// Human-facing title for the /view map chrome.
//
// Mirrors the edge resolution in functions/lib/view-dataset.ts
// (buildViewDataset's `title`): seo_title > label > name > prettified id.
// The two are deliberately separate copies — the edge builds <title>/<h1> for
// crawlers, this builds the in-app map-bar label — so keep them in sync when
// the precedence changes.
//
// Why this exists: map.ts used to set the bar to the raw layer id, so ward
// pages read "wards_..." (truncated) on mobile. These layers carry an
// seo_title in catalog.level_meta; resolve through it for a friendly label.

export type DisplayLayer = { id: string; name?: string | null };
export type DisplayLevelMeta =
  | { seo_title?: string | null; label?: string | null }
  | null
  | undefined;

/** "wards_bengaluru_bbmp_2022" -> "wards bengaluru bbmp 2022". Last-resort
 *  fallback when a layer has neither level meta nor a display name. */
export function prettifyId(id: string): string {
  return id.replace(/_/g, ' ').trim();
}

const clean = (s: string | null | undefined): string => (s ?? '').trim();

export function displayTitle(layer: DisplayLayer, levelMeta?: DisplayLevelMeta): string {
  return (
    clean(levelMeta?.seo_title) ||
    clean(levelMeta?.label) ||
    clean(layer.name) ||
    prettifyId(layer.id)
  );
}
