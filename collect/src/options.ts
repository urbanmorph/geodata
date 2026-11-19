// Option lists for the create + edit forms (id, label), and the server's check
// of them (validate-collection.ts).
import { OPEN_LICENCES as ALLOWED } from '../../web/functions/lib/licenses';

// Catalogue facets a published map slots into ('other' first = the default).
export const CATEGORIES: [string, string][] = [
  ['other', 'Other'],
  ['boundaries', 'Boundaries'],
  ['city-wards', 'City wards'],
  ['people', 'People & places'],
  ['environment', 'Environment'],
  ['water', 'Water'],
  ['agriculture', 'Agriculture & land use'],
  ['transport', 'Transport & mobility'],
  ['infrastructure', 'Infrastructure & utilities'],
  ['culture', 'Culture & heritage'],
  ['health-edu', 'Health & education'],
];

export const CATEGORY_IDS: readonly string[] = CATEGORIES.map(([id]) => id);
const CATEGORY_LABEL = new Map(CATEGORIES);
/** A category's name (layer picker groups); its id when collect doesn't know it. */
export const categoryLabel = (id: string): string => CATEGORY_LABEL.get(id) ?? id;

// Licences: the allow-list community submissions use (web/functions/lib/licenses.ts),
// with collect's shorter names, CC BY 4.0 first (the default for a new map).
const SHORT: Record<string, string> = {
  'CC-BY-4.0': 'CC BY 4.0 (credit required)',
  'CC0-1.0': 'CC0 (public domain)',
  'CC-BY-SA-4.0': 'CC BY-SA 4.0',
  'ODbL-1.0': 'ODbL 1.0',
  'ODC-PDDL-1.0': 'PDDL 1.0',
  'GODL-India': 'GODL India',
  'CDLA-Permissive-2.0': 'CDLA Permissive 2.0',
};
const DEFAULT_LICENCE = 'CC-BY-4.0';
export const OPEN_LICENCES: [string, string][] = ALLOWED
  .map((l): [string, string] => [l.id, SHORT[l.id] ?? l.name])
  .sort((a, b) => Number(b[0] === DEFAULT_LICENCE) - Number(a[0] === DEFAULT_LICENCE));
