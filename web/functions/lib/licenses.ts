// Open-licence allow-list for community submissions.
// Anything not on this list is rejected at submit time — we don't host
// proprietary or non-commercial content.

export type Licence = {
  id: string;
  name: string;
  url: string;
  requiresAttribution: boolean;
};

export const OPEN_LICENCES: readonly Licence[] = [
  {
    id: 'CC0-1.0',
    name: 'CC0 1.0 — Public Domain Dedication',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    requiresAttribution: false,
  },
  {
    id: 'CC-BY-4.0',
    name: 'CC BY 4.0 — Attribution',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    requiresAttribution: true,
  },
  {
    id: 'CC-BY-SA-4.0',
    name: 'CC BY-SA 4.0 — Attribution-ShareAlike',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    requiresAttribution: true,
  },
  {
    id: 'ODbL-1.0',
    name: 'ODbL 1.0 — Open Database License',
    url: 'https://opendatacommons.org/licenses/odbl/1-0/',
    requiresAttribution: true,
  },
  {
    id: 'ODC-PDDL-1.0',
    name: 'ODC PDDL — Public Domain Dedication',
    url: 'https://opendatacommons.org/licenses/pddl/1-0/',
    requiresAttribution: false,
  },
  {
    id: 'GODL-India',
    name: 'Government Open Data Licence — India',
    url: 'https://data.gov.in/government-open-data-license-india',
    requiresAttribution: true,
  },
  {
    id: 'CDLA-Permissive-2.0',
    name: 'CDLA Permissive 2.0 — Community Data Licence',
    url: 'https://cdla.dev/permissive-2-0/',
    requiresAttribution: true,
  },
] as const;

const BY_ID = new Map<string, Licence>(OPEN_LICENCES.map((l) => [l.id, l]));

export function isOpenLicence(id: string): boolean {
  return typeof id === 'string' && BY_ID.has(id);
}

export function requiresAttribution(id: string): boolean {
  return BY_ID.get(id)?.requiresAttribution ?? false;
}
