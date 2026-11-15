// Licence id -> terms URL, for every surface (prerender JSON-LD, /view and /c
// pages, the map's About panel, the submit allow-list). Exact ids only: a
// substring match once sent "CC-BY-NC-4.0" to plain CC BY 4.0.

export const LICENCE_URLS = Object.freeze({
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'CC-BY-SA-2.5-IN': 'https://creativecommons.org/licenses/by-sa/2.5/in/',
  'CC-BY-NC-4.0': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'CC-BY-NC-SA-4.0': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  'ODbL-1.0': 'https://opendatacommons.org/licenses/odbl/1-0/',
  'ODC-PDDL-1.0': 'https://opendatacommons.org/licenses/pddl/1-0/',
  'GODL-India': 'https://data.gov.in/government-open-data-license-india',
  'CDLA-Permissive-2.0': 'https://cdla.dev/permissive-2-0/',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  MIT: 'https://opensource.org/licenses/MIT',
});

/** Terms URL for a licence id; a dual licence ("CC0-1.0 / CC-BY-4.0") uses the first. */
export function licenceUrl(id) {
  if (!id) return undefined;
  return LICENCE_URLS[String(id).split('/')[0].trim()];
}

/** Non-commercial licences must carry a visible "Non-commercial only" label. */
export function isNonCommercial(id) {
  return /(^|-)NC(-|$)/.test(String(id ?? ''));
}
