// Open-licence allow-list for community submissions.
// Anything not on this list is rejected at submit time — we don't host
// proprietary or non-commercial content.
import { LICENCE_URLS } from '../../../shared/licences.mjs';

export type Licence = {
  id: string;
  name: string;
  url: string;
  requiresAttribution: boolean;
};

/** The open licences a submission may carry; each URL comes from
 *  shared/licences.mjs (one table for every surface). */
const OPEN: ReadonlyArray<Omit<Licence, 'url'>> = [
  { id: 'CC0-1.0', name: 'CC0 1.0: Public Domain Dedication', requiresAttribution: false },
  { id: 'CC-BY-4.0', name: 'CC BY 4.0: Attribution', requiresAttribution: true },
  { id: 'CC-BY-SA-4.0', name: 'CC BY-SA 4.0: Attribution-ShareAlike', requiresAttribution: true },
  { id: 'ODbL-1.0', name: 'ODbL 1.0: Open Database License', requiresAttribution: true },
  { id: 'ODC-PDDL-1.0', name: 'ODC PDDL: Public Domain Dedication', requiresAttribution: false },
  { id: 'GODL-India', name: 'Government Open Data Licence, India', requiresAttribution: true },
  { id: 'CDLA-Permissive-2.0', name: 'CDLA Permissive 2.0: Community Data Licence', requiresAttribution: true },
];

export const OPEN_LICENCES: readonly Licence[] = OPEN.map((l) => {
  const url = (LICENCE_URLS as Record<string, string>)[l.id];
  if (!url) throw new Error(`no URL for licence ${l.id} in shared/licences.mjs`);
  return { ...l, url };
});

const BY_ID = new Map<string, Licence>(OPEN_LICENCES.map((l) => [l.id, l]));

export function isOpenLicence(id: string): boolean {
  return typeof id === 'string' && BY_ID.has(id);
}
