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
