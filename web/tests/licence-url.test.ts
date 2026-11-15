import { describe, it, expect } from 'vitest';
import { mapLicenceUrl } from '../functions/lib/view-dataset';

// DataMeet's Delhi, Coimbatore and Chandigarh wards are CC BY-SA 2.5 India;
// every CC-BY-SA label used to link to the 4.0 licence.
describe('mapLicenceUrl', () => {
  it('links CC BY-SA 2.5 India to its own licence', () => {
    expect(mapLicenceUrl('CC-BY-SA-2.5-IN')).toBe('https://creativecommons.org/licenses/by-sa/2.5/in/');
  });
  it('keeps the existing mappings', () => {
    expect(mapLicenceUrl('CC-BY-SA-4.0')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(mapLicenceUrl('CC-BY-4.0')).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(mapLicenceUrl('CC0-1.0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(mapLicenceUrl('ODbL-1.0')).toBe('https://opendatacommons.org/licenses/odbl/1-0/');
  });
});
