// Vendors OpenFreeMap's "Liberty" style, unchanged, into liberty-style.ts.
// The India trimming happens at load time in liberty.ts (tested), not here.
//
//   node shared/update-liberty.mjs
//
// Run it when OpenFreeMap updates the style (e.g. a new sprite version), then
// run the web and collect tests, which check the trimmed result.
import { writeFileSync } from 'node:fs';

const URL_ = 'https://tiles.openfreemap.org/styles/liberty';
const res = await fetch(URL_);
if (!res.ok) throw new Error(`${URL_}: HTTP ${res.status}`);
const style = await res.json();
const out = new URL('./liberty-style.ts', import.meta.url);
writeFileSync(
  out,
  `// OpenFreeMap "Liberty" style, vendored unchanged from ${URL_}
// on ${new Date().toISOString().slice(0, 10)} by shared/update-liberty.mjs. Do not edit by hand.
//
// Licences: OpenFreeMap styles are MIT. Liberty is a fork of OSM Liberty (OSM
// Bright): code BSD-3-Clause, design CC BY 4.0, so the map credits "OSM Liberty".
// Tiles: OpenMapTiles schema, data © OpenStreetMap contributors (ODbL).
import type { StyleLike } from './liberty';\n\nexport const LIBERTY_STYLE: StyleLike = ${JSON.stringify(style, null, 1)};
`,
);
console.log(`wrote ${out.pathname}: ${style.layers.length} layers`);
