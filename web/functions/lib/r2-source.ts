import type { Source, RangeResponse } from 'pmtiles';
import { READ_TIMEOUT_MS, withTimeout } from './isolate-cache';

export class R2Source implements Source {
  constructor(public bucket: R2Bucket, private key: string) {}

  getKey(): string {
    return this.key;
  }

  getBytes(offset: number, length: number): Promise<RangeResponse> {
    return withTimeout(this.read(offset, length), READ_TIMEOUT_MS, `R2 read ${this.key} [${offset}:${offset + length}]`);
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
