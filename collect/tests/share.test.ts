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

import { splitLinks, type LinkInfo } from '../src/share';

describe('splitLinks — the Share tab\'s named links', () => {
  const L = (o: Partial<LinkInfo>): LinkInfo => ({ id: 'x', permission: 'edit', label: null, active: true, created_at: '2026-10-01', records: 0, ...o });
  it('lists named collect/view links newest first, active before turned-off', () => {
    const out = splitLinks([
      L({ id: 'a', label: 'Asha', created_at: '2026-10-01' }),
      L({ id: 'b', label: 'Ward 12', created_at: '2026-10-03', active: false }),
      L({ id: 'c', label: 'School', permission: 'view', created_at: '2026-10-02' }),
      L({ id: 'adm', label: null, permission: 'admin' }),
    ]);
    expect(out.named.map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });
  it('counts unnamed collect links (and their points) without listing them', () => {
    const out = splitLinks([L({ id: '1', records: 3 }), L({ id: '2', records: 2 }), L({ id: '3', permission: 'view' }), L({ id: '4', label: 'Asha' })]);
    expect(out.unnamed).toEqual({ links: 2, records: 5 });
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
