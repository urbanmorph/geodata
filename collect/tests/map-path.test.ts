// Map and record addresses: built by mapUrl/recordUrl, read back by parseMapPath.
import { describe, it, expect } from 'vitest';
import { parseMapPath, mapUrl, recordUrl } from '../src/map-path';

const O = 'https://collect.test';

describe('mapUrl', () => {
  it('puts the edit link on the map itself and the admin and view links on their pages', () => {
    expect(mapUrl(O, 'abc123XYZ', 'edit', 'edt_x')).toBe(`${O}/c/abc123XYZ#edt_x`);
    expect(mapUrl(O, 'abc123XYZ', 'admin', 'adm_x')).toBe(`${O}/c/abc123XYZ/admin#adm_x`);
    expect(mapUrl(O, 'abc123XYZ', 'view', 'viw_x')).toBe(`${O}/c/abc123XYZ/view#viw_x`);
  });

  it('is the bare map address without a permission or token', () => {
    expect(mapUrl(O, 'abc123XYZ')).toBe(`${O}/c/abc123XYZ`);
  });

  it('round-trips through parseMapPath', () => {
    expect(parseMapPath(new URL(mapUrl(O, 'abc123XYZ', 'admin', 'adm_x')).pathname)).toEqual({ id: 'abc123XYZ', page: 'admin' });
  });
});

describe('recordUrl', () => {
  it('opens one record with its token, and parses back', () => {
    const u = recordUrl(O, 'abc123XYZ', 'rec987654', 'rec_tok');
    expect(u).toBe(`${O}/c/abc123XYZ/r/rec987654#rec_tok`);
    expect(parseMapPath(new URL(u).pathname)).toEqual({ id: 'abc123XYZ', recordId: 'rec987654' });
  });

  it('is a path when the origin is empty', () => {
    expect(recordUrl('', 'abc123XYZ', 'rec987654', 'edt_x')).toBe('/c/abc123XYZ/r/rec987654#edt_x');
  });
});
