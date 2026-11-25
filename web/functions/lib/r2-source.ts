import { EtagMismatch, type Source, type RangeResponse } from 'pmtiles';
import { READ_TIMEOUT_MS, withTimeout } from './isolate-cache';

export class R2Source implements Source {
  constructor(private readonly bucket: R2Bucket, private readonly key: string) {}

  getKey(): string {
    return this.key;
  }

  /** `etag`: the archive header's, from pmtiles. Bytes of another upload throw its EtagMismatch,
   *  on which pmtiles drops what it cached and reads again. (Not an onlyIf pin: that would skip
   *  the colo's cache for every tile.) */
  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const got = await withTimeout(this.read(offset, length), READ_TIMEOUT_MS, `R2 read ${this.key} [${offset}:${offset + length}]`);
    if (etag && got.etag && got.etag !== etag) throw new EtagMismatch();
    return got;
  }

  private async read(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, { range: { offset, length } });
    if (!obj) throw new Error(`R2 key not found: ${this.key}`);
    return {
      data: await obj.arrayBuffer(),
      etag: obj.etag,
      cacheControl: obj.httpMetadata?.cacheControl,
    };
  }
}
