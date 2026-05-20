import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, verifyToken, tokenPrefix } from '../functions/lib/tokens';

describe('generateToken', () => {
  it('returns "<prefix>_<32 chars>" by default', () => {
    const t = generateToken('admin');
    expect(t).toMatch(/^adm_[A-Za-z0-9_-]{32}$/);
  });

  it('uses the prefix matching the requested permission', () => {
    expect(generateToken('admin')).toMatch(/^adm_/);
    expect(generateToken('edit')).toMatch(/^edt_/);
    expect(generateToken('view')).toMatch(/^viw_/);
  });

  it('produces unique tokens across many calls', () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateToken('admin'));
    expect(set.size).toBe(200);
  });
});

describe('tokenPrefix', () => {
  it('returns the first 8 characters', () => {
    expect(tokenPrefix('adm_8h2k9q1r5t7v3y6w0z4n8p2k5j7m1q3')).toBe('adm_8h2k');
  });

  it('returns the full string if shorter than 8', () => {
    expect(tokenPrefix('abc')).toBe('abc');
  });
});

describe('hashToken', () => {
  it('returns a 64-char hex string (SHA-256)', async () => {
    const h = await hashToken('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a known SHA-256 vector', async () => {
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(await hashToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('produces a different hash for different inputs', async () => {
    const a = await hashToken('hello');
    const b = await hashToken('hellx');
    expect(a).not.toBe(b);
  });
});

describe('verifyToken', () => {
  it('accepts the matching plaintext for its hash', async () => {
    const t = generateToken('admin');
    const h = await hashToken(t);
    expect(await verifyToken(t, h)).toBe(true);
  });

  it('rejects a wrong plaintext for a hash', async () => {
    const t = generateToken('admin');
    const h = await hashToken(t);
    const wrong = generateToken('admin'); // different random token
    expect(await verifyToken(wrong, h)).toBe(false);
  });

  it('rejects an empty or malformed token', async () => {
    const h = await hashToken('hello');
    expect(await verifyToken('', h)).toBe(false);
    expect(await verifyToken('not-the-right-thing', h)).toBe(false);
  });
});
