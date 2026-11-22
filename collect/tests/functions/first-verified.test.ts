// firstVerified: of the rows sharing a token's prefix, the first whose stored
// hash the token verifies against (constant-time compare per row).
import { describe, it, expect } from 'vitest';
import { firstVerified, hashToken, generateToken } from '../../functions/lib/tokens';

describe('firstVerified', () => {
  it('returns the row whose hash matches the token', async () => {
    const tok = generateToken('edit');
    const other = generateToken('edit');
    const rows = [{ id: 'a', h: await hashToken(other) }, { id: 'b', h: await hashToken(tok) }];
    expect(await firstVerified(tok, rows, (r) => r.h)).toEqual({ id: 'b', h: rows[1].h });
  });

  it('returns null when no row matches, or there are none', async () => {
    const tok = generateToken('view');
    expect(await firstVerified(tok, [{ h: await hashToken(generateToken('view')) }], (r) => r.h)).toBeNull();
    expect(await firstVerified(tok, [], (r: { h: string }) => r.h)).toBeNull();
  });
});
