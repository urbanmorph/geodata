import { describe, it, expect } from 'vitest';
import { linksText, linksMailtoHref } from '../src/share';

const links = {
  edit: 'https://collect.bharatlas.com/c/abc#edt_1',
  view: 'https://collect.bharatlas.com/c/abc/view#viw_1',
  admin: 'https://collect.bharatlas.com/c/abc/admin#adm_1',
};

describe('linksText', () => {
  it('includes every present link, labelled', () => {
    const t = linksText(links, 'Footpaths');
    expect(t).toContain('edt_1');
    expect(t).toContain('viw_1');
    expect(t).toContain('adm_1');
    expect(t).toContain('Footpaths');
  });

  it('omits links that are absent', () => {
    const t = linksText({ edit: 'https://collect.bharatlas.com/c/x#edt_2' });
    expect(t).toContain('edt_2');
    expect(t).not.toContain('adm_'); // no admin line
    expect(t).not.toContain('viw_'); // no view line
  });

  it('warns the admin link is secret when present', () => {
    expect(linksText(links).toLowerCase()).toContain('secret');
    expect(linksText({ view: 'https://collect.bharatlas.com/c/x/view#viw_3' }).toLowerCase()).not.toContain('secret');
  });

  it('has no em-dashes (public-facing copy)', () => {
    expect(linksText(links, 'Trees')).not.toContain('—');
  });
});

describe('linksMailtoHref', () => {
  it('is a mailto with encoded subject + body carrying the links', () => {
    const href = linksMailtoHref(links, 'Footpaths');
    expect(href.startsWith('mailto:?')).toBe(true);
    expect(href).toContain('subject=');
    expect(href).toContain('body=');
    expect(decodeURIComponent(href)).toContain('adm_1');
    expect(decodeURIComponent(href)).toContain('Footpaths');
  });

  it('leaves the recipient empty (send to yourself)', () => {
    expect(linksMailtoHref(links).startsWith('mailto:?')).toBe(true);
  });
});

import { shareTabLinks, heldToken, type LinkInfo } from '../src/share';

describe('shareTabLinks: every collect/view link in the Share tab, each one switchable off', () => {
  const L = (o: Partial<LinkInfo>): LinkInfo => ({ id: 'x', permission: 'edit', label: null, active: true, created_at: '2026-10-01T05:00:00.000Z', records: 0, ...o });
  it('lists named and unnamed links, active before turned-off, newest first; never admin', () => {
    const out = shareTabLinks([
      L({ id: 'a', label: 'Asha', created_at: '2026-10-01' }),
      L({ id: 'b', label: 'Ward 12', created_at: '2026-10-03', active: false }),
      L({ id: 'c', label: 'School', permission: 'view', created_at: '2026-10-02' }),
      L({ id: 'u1', created_at: '2026-09-01' }),
      L({ id: 'adm', label: null, permission: 'admin' }),
    ]);
    expect(out.map((l) => l.id)).toEqual(['c', 'a', 'u1', 'b']);
  });
  it('names unnamed links plainly, numbered by age per kind, with the day they were made', () => {
    const out = shareTabLinks([
      L({ id: 'u1', created_at: '2026-09-01T10:00:00.000Z' }),
      L({ id: 'v1', permission: 'view', created_at: '2026-09-02T10:00:00.000Z' }),
      L({ id: 'u2', created_at: '2026-09-03T10:00:00.000Z' }),
      L({ id: 'n', label: 'Asha', created_at: '2026-09-04T10:00:00.000Z' }),
    ]);
    const name = Object.fromEntries(out.map((l) => [l.id, l.name]));
    expect(name).toEqual({ u1: 'Collect link 1 (made 2026-09-01)', u2: 'Collect link 2 (made 2026-09-03)', v1: 'View-only link 1 (made 2026-09-02)', n: 'Asha' });
  });
});

describe('heldToken: the token of a link this device already holds, for reuse', () => {
  it('reads the token of a saved link of the wanted kind', () => {
    expect(heldToken('https://collect.bharatlas.com/c/abc#edt_x1', 'edit')).toBe('edt_x1');
    expect(heldToken('https://collect.bharatlas.com/c/abc/view#viw_y2', 'view')).toBe('viw_y2');
  });
  it('gives nothing for no link, a garbled link, or another kind', () => {
    expect(heldToken(undefined, 'edit')).toBeUndefined();
    expect(heldToken('not a url', 'edit')).toBeUndefined();
    expect(heldToken('https://collect.bharatlas.com/c/abc#viw_y2', 'edit')).toBeUndefined();
    expect(heldToken('https://collect.bharatlas.com/c/abc#adm_z', 'view')).toBeUndefined();
  });
});

describe('shareOrCopy payload', () => {
  it('puts the link in the text, so WhatsApp (which builds the message from text) receives it', async () => {
    const { shareOrCopy } = await import('../src/share');
    const calls: ShareData[] = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { share: async (d: ShareData) => { calls.push(d); } } });
    expect(await shareOrCopy('https://collect.bharatlas.com/c/abc#edt_x', 'Footpaths')).toBe('shared');
    expect(calls).toEqual([{ title: 'Footpaths', text: 'Footpaths\nhttps://collect.bharatlas.com/c/abc#edt_x' }]);
  });
});
