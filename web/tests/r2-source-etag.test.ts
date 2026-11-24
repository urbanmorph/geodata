// PMTiles reads (locate, the point lookups) are not pinned with onlyIf: that would
// skip the colo's cache for every tile. The pmtiles library passes the etag of the
// archive's header with each read; R2Source compares it with the bytes it got and
// throws the library's EtagMismatch, on which pmtiles drops what it cached and reads again.
import { describe, it, expect } from 'vitest';
import { EtagMismatch } from 'pmtiles';
import { R2Source } from '../functions/lib/r2-source';
import { fakeR2 } from './helpers/fake-r2';

describe('R2Source', () => {
  it('bytes from another upload than the header\'s: EtagMismatch', async () => {
    const objects: Record<string, Buffer> = { 't/x.pmtiles': Buffer.from('aaaaaaaa') };
    const src = new R2Source(fakeR2(objects), 't/x.pmtiles');
    const first = await src.getBytes(0, 4);
    objects['t/x.pmtiles'] = Buffer.from('bbbbbbbb');
    await expect(src.getBytes(4, 4, undefined, first.etag)).rejects.toBeInstanceOf(EtagMismatch);
  });
  it('the same upload, or no etag asked: the bytes', async () => {
    const src = new R2Source(fakeR2({ 't/x.pmtiles': Buffer.from('aaaaaaaa') }), 't/x.pmtiles');
    const first = await src.getBytes(0, 4);
    expect((await src.getBytes(4, 4, undefined, first.etag)).data.byteLength).toBe(4);
    expect((await src.getBytes(4, 4)).data.byteLength).toBe(4);
  });
});
