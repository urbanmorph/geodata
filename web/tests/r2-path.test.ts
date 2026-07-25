import { describe, it, expect } from 'vitest';
import { reconstructKey } from '../functions/api/r2/[[path]]';

describe('reconstructKey (/api/r2 catch-all)', () => {
  it('joins plain segments unchanged', () => {
    expect(reconstructKey(['community', 'nL7zNStsW3', '39A.geojson']))
      .toBe('community/nL7zNStsW3/39A.geojson');
  });

  it('decodes %20 so spaced filenames match the literal R2 key', () => {
    // Regression: the accepted "Temples of Ahmedabad" submission is stored at
    // community/mNBkWTEHMP/TEMPLE IN AHMEDABAD JDSM.kml (literal spaces). Pages
    // hands us the segment percent-encoded; without decoding, env.R2.get()
    // misses and the preview 404s.
    expect(reconstructKey(['community', 'mNBkWTEHMP', 'TEMPLE%20IN%20AHMEDABAD%20JDSM.kml']))
      .toBe('community/mNBkWTEHMP/TEMPLE IN AHMEDABAD JDSM.kml');
  });

  it('decodes other percent-encoded characters (parens, plus, hash)', () => {
    expect(reconstructKey(['community', 'abc', 'a%20(b)%2Bc%23.kml']))
      .toBe('community/abc/a (b)+c#.kml');
  });

  it('returns null on a malformed escape rather than throwing', () => {
    expect(reconstructKey(['community', 'abc', 'bad%zz.kml'])).toBeNull();
    expect(reconstructKey(['community', 'abc', '100%.kml'])).toBeNull();
  });

  it('returns empty string for no segments (handler maps to 400)', () => {
    expect(reconstructKey([])).toBe('');
  });
});
