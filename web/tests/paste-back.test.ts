import { describe, it, expect } from 'vitest';
import { parseAdminUrl } from '../src/paste-back';

describe('parseAdminUrl — happy paths', () => {
  it('parses an absolute bharatlas.com admin URL', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/Xa9Kp7nQ?key=adm_abcd1234efgh');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });

  it('parses geodata-3ij.pages.dev fallback', () => {
    const r = parseAdminUrl('https://geodata-3ij.pages.dev/c/Xa9Kp7nQ?key=adm_abcd1234efgh');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });

  it('parses a relative path', () => {
    const r = parseAdminUrl('/c/Xa9Kp7nQ?key=adm_abcd1234efgh');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });

  it('parses a scheme-less host (bharatlas.com/c/…)', () => {
    const r = parseAdminUrl('bharatlas.com/c/Xa9Kp7nQ?key=adm_abcd1234efgh');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });

  it('tolerates surrounding whitespace', () => {
    const r = parseAdminUrl('   https://bharatlas.com/c/Xa9Kp7nQ?key=adm_abcd1234efgh  ');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });

  it('accepts http (local dev) URLs', () => {
    const r = parseAdminUrl('http://localhost:5173/c/Xa9Kp7nQ?key=adm_abcd1234efgh');
    expect(r).toEqual({ ok: true, id: 'Xa9Kp7nQ', key: 'adm_abcd1234efgh' });
  });
});

describe('parseAdminUrl — rejections', () => {
  it('rejects empty / whitespace input', () => {
    expect(parseAdminUrl('').ok).toBe(false);
    expect(parseAdminUrl('   ').ok).toBe(false);
  });

  it('rejects garbage strings', () => {
    const r = parseAdminUrl('not a url at all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/couldn.?t read/i);
  });

  it('rejects URLs without a /c/<id> segment', () => {
    const r = parseAdminUrl('https://bharatlas.com/about?key=adm_xxxxxxxxxxxx');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/submission/i);
  });

  it('rejects when the id segment is too short', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/abc?key=adm_xxxxxxxxxxxx');
    expect(r.ok).toBe(false);
  });

  it('rejects when key= is missing', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/Xa9Kp7nQ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing key/i);
  });

  it('rejects when key= is empty', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/Xa9Kp7nQ?key=');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing key/i);
  });

  it('rejects when key= does not start with adm_', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/Xa9Kp7nQ?key=hello');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/key/i);
  });

  it('rejects when key= is too short for an admin token', () => {
    const r = parseAdminUrl('https://bharatlas.com/c/Xa9Kp7nQ?key=adm_x');
    expect(r.ok).toBe(false);
  });
});
