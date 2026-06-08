// Build-time search-haystack helpers, shared by web/scripts/prerender.mjs and
// unit-tested in web/tests/search-aliases.test.ts. Kept as plain ESM (.mjs) so
// the node build script and vitest can both import it.
//
// expandAliases injects synonyms into a card's search haystack so a query for
// one term ("groundwater") surfaces a card labelled with a sibling term
// ("aquifer"). buildBodyHaystack assembles the lower-signal "body" haystack,
// folding in each layer's explicit `tags`.

export const SEARCH_ALIASES = {
  'PMGSY':       ['Pradhan Mantri Gram Sadak Yojana', 'rural roads'],
  'LGD':         ['Local Government Directory'],
  'SOI':         ['Survey of India'],
  'NRSC':        ['ISRO Bhuvan', 'national remote sensing centre'],
  'MoRTH':       ['Ministry of Road Transport Highways', 'NHAI', 'highways'],
  'MoEFCC':      ['Ministry of Environment Forest Climate Change'],
  'ESZ':         ['eco sensitive zone'],
  'CRZ':         ['coastal regulation zone'],
  // pincode + wildlife aliases moved below (merged with court/ward block)
  'parliament':  ['lok sabha', 'PC', 'constituency', 'election', 'vote', 'MP'],
  'assembly':    ['vidhan sabha', 'AC', 'MLA', 'election', 'vote'],
  'ward':        ['municipality', 'corporation', 'municipal', 'city', 'urban'],
  'pincode':     ['pin code', 'postal code', 'zip', 'post office'],
  'wildlife':    ['national park', 'sanctuary', 'reserve forest', 'protected area'],
  'eco':         ['protected area', 'environment', 'pollution'],
  'country':     ['India outline', 'national boundary', 'India map'],
  'GatiShakti':  ['PM GatiShakti'],
  'Bharatmaps':  ['NIC', 'national informatics centre'],
  'CC0':         ['public domain'],
  'CC-BY':       ['attribution'],
  'ODbL':        ['open database license'],
  'district':    ['district court', 'district courts', 'sessions court', 'magistrate court', 'consumer forum', 'consumer commission', 'courts'],
  'subdistrict': ['tehsil court', 'tehsil courts', 'revenue court', 'taluk court', 'courts'],
  'state':       ['state consumer commission', 'courts'],
  'high_court':  ['high court', 'high courts', 'HC', 'appellate court'],
  'NGT':         ['national green tribunal', 'environment tribunal', 'green court', 'courts'],
  'NCLT':        ['national company law tribunal', 'company court', 'courts', 'insolvency', 'IBC'],
  'parquet':     ['arrow', 'columnar'],
  'pmtiles':     ['vector tiles', 'maplibre'],
  'geojson':     ['gis', 'qgis'],
  'kml':         ['google earth'],
  // v3 — CoRE Stack water / groundwater / agro-zone domain bridges.
  'aquifer':       ['groundwater', 'water table', 'hydrogeology', 'borewell', 'principal aquifer', 'CGWB'],
  'groundwater':   ['aquifer', 'water table', 'recharge', 'over-exploited', 'bore well', 'CGWB'],
  'canal':         ['irrigation', 'command area', 'distributary', 'water infrastructure'],
  'agro-ecological': ['AEZ', 'agroecology', 'agriculture', 'soil', 'bioclimate', 'cropping'],
  'agro-climatic':   ['ACZ', 'agriculture', 'rainfall', 'cropping', 'farming zone'],
  'biogeographic':   ['biogeography', 'ecoregion', 'ecology', 'biotic province', 'conservation'],
};

export function expandAliases(text) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const [key, expansions] of Object.entries(SEARCH_ALIASES)) {
    if (lower.includes(key.toLowerCase())) hits.push(...expansions);
  }
  return hits.length ? text + ' ' + hits.join(' ') : text;
}

/**
 * Assemble the lower-signal "body" search haystack for a catalog card and run
 * it through alias expansion. Folds each layer's explicit `tags` in so a query
 * like "groundwater" or "over-exploited" surfaces the card. Returns a
 * lowercased string ready for substring matching in catalog-filter.ts.
 *
 * Fields (all optional): description, attributionName, notes, source, licence,
 * category, formats, altSources, tags[].
 */
export function buildBodyHaystack(o) {
  const parts = [
    o.description,
    o.attributionName,
    o.notes,
    o.source,
    o.licence,
    o.category,
    o.formats,
    o.altSources,
    Array.isArray(o.tags) ? o.tags.join(' ') : '',
  ];
  return expandAliases(parts.filter(Boolean).join(' ')).toLowerCase();
}
