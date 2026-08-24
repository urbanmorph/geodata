import { describe, it, expect } from 'vitest';
import { qrSvg } from '../src/qr';

describe('qrSvg', () => {
  it('returns a scalable dark-on-white svg for a url', async () => {
    const svg = await qrSvg('https://collect.bharatlas.com/c/abc/admin#adm_token123');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0');
    expect(svg).toContain('<path');
    expect(svg).toContain('#fff'); // white ground for scannability
  });

  it('grows the module grid for longer input', async () => {
    const short = await qrSvg('hi');
    const long = await qrSvg('x'.repeat(300));
    const box = (s: string): number => Number(/viewBox="0 0 (\d+)/.exec(s)![1]);
    expect(box(long)).toBeGreaterThan(box(short));
  });
});
