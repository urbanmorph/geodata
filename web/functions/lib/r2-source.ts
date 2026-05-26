import type { Source, RangeResponse } from 'pmtiles';

export class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string) {}

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, { range: { offset, length } });
    if (!obj) throw new Error(`R2 key not found: ${this.key}`);
    return {
      data: await obj.arrayBuffer(),
      etag: obj.etag,
      cacheControl: obj.httpMetadata?.cacheControl,
    };
  }
}
