import { describe, it, expect, vi } from 'vitest';
import { nanoid, sha256Hex, sanitizeFilename, ipHashFor } from '../functions/lib/submit-helpers';

describe('nanoid', () => {
  it('returns a string of the requested length', () => {
    expect(nanoid(10)).toHaveLength(10);
    expect(nanoid(16)).toHaveLength(16);
  });

  it('uses only URL-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(nanoid(20)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces distinct values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(nanoid(10));
    expect(seen.size).toBe(200);
  });
});

describe('sha256Hex', () => {
  it('hashes empty input to the known SHA-256(empty)', async () => {
    const hex = await sha256Hex(new ArrayBuffer(0));
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces the same hex for the same bytes', async () => {
    const a = new TextEncoder().encode('hello world').buffer;
    const b = new TextEncoder().encode('hello world').buffer;
    expect(await sha256Hex(a)).toBe(await sha256Hex(b));
  });

  it('produces different hex for different bytes', async () => {
    const a = new TextEncoder().encode('hello world').buffer;
    const b = new TextEncoder().encode('hello worle').buffer;
    expect(await sha256Hex(a)).not.toBe(await sha256Hex(b));
  });

  it('returns a 64-character lowercase hex string', async () => {
    const h = await sha256Hex(new TextEncoder().encode('x').buffer);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('sanitizeFilename', () => {
  it('preserves a clean filename', () => {
    expect(sanitizeFilename('mumbai_bike_lanes.geojson')).toBe('mumbai_bike_lanes.geojson');
  });

  it('strips directory traversal', () => {
    expect(sanitizeFilename('../../etc/passwd.geojson')).toBe('etc_passwd.geojson');
    expect(sanitizeFilename('/abs/path/foo.json')).toBe('abs_path_foo.json');
  });

  it('strips control chars and zero bytes', () => {
    expect(sanitizeFilename('bad\x00name.geojson')).toBe('bad_name.geojson');
    expect(sanitizeFilename('tab\there.geojson')).toBe('tab_here.geojson');
  });

  it('truncates names over 100 chars while keeping the extension', () => {
    const long = 'a'.repeat(200) + '.geojson';
    const r = sanitizeFilename(long);
    expect(r.length).toBeLessThanOrEqual(100);
    expect(r.endsWith('.geojson')).toBe(true);
  });

  it('returns a fallback when input is empty', () => {
    expect(sanitizeFilename('')).toBe('upload.bin');
    expect(sanitizeFilename('   ')).toBe('upload.bin');
  });
});

describe('ipHashFor', () => {
  function reqWith(headers: Record<string, string>): Request {
    return new Request('https://example.com', { headers });
  }

  it('hashes the request IP + day + salt deterministically', async () => {
    const r = reqWith({ 'cf-connecting-ip': '203.0.113.42' });
    const a = await ipHashFor(r, 'salt', () => new Date('2026-05-20T10:00:00Z'));
    const b = await ipHashFor(r, 'salt', () => new Date('2026-05-20T22:00:00Z'));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rotates daily — different hash on a different UTC date', async () => {
    const r = reqWith({ 'cf-connecting-ip': '203.0.113.42' });
    const a = await ipHashFor(r, 'salt', () => new Date('2026-05-20T10:00:00Z'));
    const b = await ipHashFor(r, 'salt', () => new Date('2026-05-21T10:00:00Z'));
    expect(a).not.toBe(b);
  });

  it('returns distinct hashes for distinct IPs', async () => {
    const a = await ipHashFor(
      reqWith({ 'cf-connecting-ip': '203.0.113.42' }),
      'salt',
      () => new Date('2026-05-20T10:00:00Z'),
    );
    const b = await ipHashFor(
      reqWith({ 'cf-connecting-ip': '198.51.100.7' }),
      'salt',
      () => new Date('2026-05-20T10:00:00Z'),
    );
    expect(a).not.toBe(b);
  });

  it('falls back to a synthetic value when no IP header is present', async () => {
    const r = reqWith({});
    const h = await ipHashFor(r, 'salt', () => new Date('2026-05-20T10:00:00Z'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IP hashes: one IPv6 /64 is one client', () => {
  const req = (ip: string) => new Request('https://bharatlas.com/', { headers: { 'cf-connecting-ip': ip } });
  const day = () => new Date('2026-11-19T10:00:00Z');
  it('two addresses in one /64 hash alike (daily and stable); another /64 does not', async () => {
    const { ipHashFor, ipHashStable } = await import('../functions/lib/submit-helpers');
    const a = '2001:db8:1:2::1', b = '2001:db8:1:2:abcd::99', c = '2001:db8:1:3::1';
    expect(await ipHashFor(req(a), 's', day)).toBe(await ipHashFor(req(b), 's', day));
    expect(await ipHashFor(req(a), 's', day)).not.toBe(await ipHashFor(req(c), 's', day));
    expect(await ipHashStable(req(a), 's')).toBe(await ipHashStable(req(b), 's'));
    expect(await ipHashFor(req('1.2.3.4'), 's', day)).not.toBe(await ipHashFor(req('1.2.3.5'), 's', day));
  });
});

describe('ipSalt', () => {
  it('uses the secret, else the fallback, and logs an unset secret once', async () => {
    const { ipSalt } = await import('../functions/lib/submit-helpers');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ipSalt('secret', 'fb-test')).toBe('secret');
    expect(err).not.toHaveBeenCalled();
    expect(ipSalt(undefined, 'fb-test')).toBe('fb-test');
    expect(ipSalt('', 'fb-test')).toBe('fb-test');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/IP_SALT is not set/);
    err.mockRestore();
  });

  it('submit and rate hash IPs with one salt: the secret, else geodata-v1', async () => {
    const { submitterSalt } = await import('../functions/lib/submit-helpers');
    expect(submitterSalt({ IP_SALT: 'secret' })).toBe('secret');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(submitterSalt({})).toBe('geodata-v1');
    err.mockRestore();
  });
});
