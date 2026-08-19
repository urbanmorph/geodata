// Shared option lists for the create + edit forms (id, label).

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

export const OPEN_LICENCES: [string, string][] = [
  ['CC-BY-4.0', 'CC BY 4.0 (credit required)'],
  ['CC0-1.0', 'CC0 (public domain)'],
  ['CC-BY-SA-4.0', 'CC BY-SA 4.0'],
  ['ODbL-1.0', 'ODbL 1.0'],
  ['ODC-PDDL-1.0', 'PDDL 1.0'],
  ['GODL-India', 'GODL India'],
  ['CDLA-Permissive-2.0', 'CDLA Permissive 2.0'],
];
