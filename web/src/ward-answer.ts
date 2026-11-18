// Answer-first search: "ward 9 ahmedabad" -> "Ward 9, Ahmedabad is Naranpura".
// Pure: the home search (main.ts) supplies the ward layers' city names (baked
// by prerender) and fetches the matched layer's ward-index sidecar.
import type { WardSidecar } from './locate-format';
import { WARD_PLACES } from '../functions/lib/ward-places';
import { escapeHtml } from './util';

export type WardQuery = { layerId: string; place: string; number: string };

// Older and common spellings people still search with.
const CITY_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru', bombay: 'mumbai', gurgaon: 'gurugram', calcutta: 'kolkata',
  madras: 'chennai', baroda: 'vadodara', vizag: 'visakhapatnam', cochin: 'kochi', mysore: 'mysuru',
  bhubaneshwar: 'bhubaneswar',
};

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Ward layer + number from a query that names "ward", a number and a known city. */
export function parseWardQuery(q: string, places: Record<string, string>): WardQuery | null {
  let text = norm(q);
  if (!/ wards? /.test(text)) return null;
  const number = text.match(/ ward(?: no| number)? (\d{1,4}) /)?.[1] ?? text.match(/ (\d{1,4}) /)?.[1];
  if (!number) return null;
  for (const [alias, city] of Object.entries(CITY_ALIASES)) text = text.replace(` ${alias} `, ` ${city} `);
  // Longest city name first ("navi mumbai" before "mumbai"); first layer per city
  // wins, and places come in catalogue order (current map before historical).
  const match = Object.entries(places)
    .filter(([, place]) => text.includes(norm(place)))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return match ? { layerId: match[0], place: match[1], number } : null;
}

/** The ward with that number, or null when unknown or ambiguous. */
export function wardAnswer(index: Pick<WardSidecar, 'rows'>, number: string): { number: string; name: string; total: number } | null {
  const want = String(Number(number));
  const hits = index.rows.filter((r) => String(Number(r.no)) === want);
  return hits.length === 1 ? { number: want, name: hits[0].name, total: index.rows.length } : null;
}

/** Ward layer id -> plain city name, in ward-places order (current map first). */
export function wardCities(): Record<string, string> {
  return Object.fromEntries(Object.entries(WARD_PLACES).map(([id, p]) => [id, p.city]));
}

/** The answer card shown above the search results. */
export function wardAnswerHtml(q: WardQuery, a: { number: string; name: string; total: number }): string {
  return `<p class="ward-answer__title">Ward ${escapeHtml(a.number)}, ${escapeHtml(q.place)} is <strong>${escapeHtml(a.name)}</strong></p>` +
    `<p class="ward-answer__meta">1 of ${a.total} wards in ${escapeHtml(q.place)}</p>` +
    `<a class="ward-answer__go" href="/view/${encodeURIComponent(q.layerId)}">View map</a>`;
}
