// A requested layer's credit ("Requested by" on the list, "Curated by bharatlas at the request of"
// on the About panel) and the rule that a requested (paid) layer never uses non-commercial sources.
import { describe, expect, it } from 'vitest';
import {
  requestedBy, requestedByTagHtml, requestedByAboutHtml, requestedLayersThatAreNonCommercial, requestedStripHtml, requestedFirst,
} from '../../shared/requested-by.mjs';
import catalog from '../../catalog.json';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pesa = { id: 'scheduled_areas_fifth', licence: 'CC0-1.0', requested_by: { name: 'Sandilya MV' } };

describe('requested-by credit', () => {
  it('reads the requester, and nothing for a layer no one requested', () => {
    expect(requestedBy(pesa)).toEqual({ name: 'Sandilya MV', line: '', url: '', logo: '' });
    expect(requestedBy({ id: 'x' })).toBeNull();
    expect(requestedBy({ id: 'x', requested_by: { name: '  ' } })).toBeNull();
  });

  it('tags the list row "Requested by" and escapes the name', () => {
    expect(requestedByTagHtml(pesa)).toContain('Requested by Sandilya MV');
    expect(requestedByTagHtml({ id: 'x', requested_by: { name: '<b>A</b>' } })).toContain('&lt;b&gt;A&lt;/b&gt;');
    expect(requestedByTagHtml({ id: 'x' })).toBe('');
  });

  it('says "Curated by bharatlas at the request of" on the About panel, with the line only when given', () => {
    const html = requestedByAboutHtml(pesa);
    expect(html).toContain('Curated by bharatlas at the request of Sandilya MV');
    expect(html).toContain('href="/docs#request"');
    expect(html).not.toContain('about-panel__req-line');
    expect(requestedByAboutHtml({ ...pesa, requested_by: { name: 'A', line: 'For gram sabhas' } }))
      .toContain('For gram sabhas');
    expect(requestedByAboutHtml({ id: 'x' })).toBe('');
  });
});

describe('an organisation credit: link and logo, both optional', () => {
  const altmo = { id: 't', licence: 'CC0-1.0', requested_by: { name: 'Altmo', url: 'https://www.altmo.app', logo: '/requesters/altmo.svg' } };

  it('keeps an https link and a logo we host as SVG, and drops anything else', () => {
    expect(requestedBy(altmo)).toMatchObject({ url: 'https://www.altmo.app', logo: '/requesters/altmo.svg' });
    const bad = requestedBy({ id: 't', requested_by: { name: 'A', url: 'javascript:alert(1)', logo: 'https://them.example/logo.png' } });
    expect(bad).toMatchObject({ url: '', logo: '' });
    expect(requestedBy({ id: 't', requested_by: { name: 'A', url: 'http://plain.example', logo: '/requesters/../x.svg' } }))
      .toMatchObject({ url: '', logo: '' });
  });

  it('links the name as a paid link and shows the logo on the About panel', () => {
    const html = requestedByAboutHtml(altmo);
    expect(html).toContain('at the request of <a href="https://www.altmo.app" target="_blank" rel="sponsored noopener">Altmo</a>');
    // the name is already in the text, so the logo is decorative and not a second link to the same place
    expect(html).toMatch(/<img class="about-panel__req-logo" src="\/requesters\/altmo.svg" alt="" [^>]*>/);
    expect(html.match(/href="https:\/\/www.altmo.app"/g)).toHaveLength(1);
  });

  it('shows the name alone when there is no link or logo, and a logo without a link', () => {
    expect(requestedByAboutHtml(pesa)).not.toContain('<img');
    expect(requestedByAboutHtml(pesa)).toContain('at the request of Sandilya MV</p>');
    const logoOnly = requestedByAboutHtml({ id: 't', requested_by: { name: 'Altmo', logo: '/requesters/altmo.svg' } });
    expect(logoOnly).toContain('<img class="about-panel__req-logo"');
    expect(logoOnly).toContain('at the request of Altmo</p>');
  });

  it('keeps the list tag to text: no link or logo on every row', () => {
    expect(requestedByTagHtml(altmo)).toBe('<span class="badge req-badge">Requested by Altmo</span>');
  });

  it('every logo a catalog layer names is an SVG in web/public/requesters', () => {
    for (const l of (catalog as { layers: { requested_by?: { logo?: string } }[] }).layers) {
      const logo = l.requested_by?.logo;
      if (logo) expect(existsSync(fileURLToPath(new URL(`../public${logo}`, import.meta.url))), logo).toBe(true);
    }
  });

  it('requester logos are SVGs that change fill for dark mode and carry no script or outside reference', () => {
    const dir = fileURLToPath(new URL('../public/requesters/', import.meta.url));
    for (const f of readdirSync(dir)) {
      expect(f).toMatch(/^[a-z0-9-]+\.svg$/);
      const svg = readFileSync(dir + f, 'utf8');
      expect(svg, f).toContain('prefers-color-scheme:dark');
      expect(svg, f).not.toMatch(/<script|\bon[a-z]+=|href=|url\(/i);
    }
  });
});

describe('requested layers come first on /layers', () => {
  const layers = [
    { id: 'a', name: 'Alpha', licence: 'CC0-1.0' },
    { id: 'b', name: 'Beta <x>', licence: 'CC0-1.0', requested_by: { name: 'Altmo', url: 'https://www.altmo.app' } },
    { id: 'c', name: 'Gamma', licence: 'CC0-1.0', requested_by: { name: 'Sandilya MV' } },
  ];

  it('lists the requested layers at the top, each opening its map with who asked', () => {
    const html = requestedStripHtml(layers);
    expect(html).toContain('id="requested"');
    expect(html).toContain('<a class="req-strip__item" href="/view/b"><span class="req-strip__name">Beta &lt;x&gt;</span><span class="req-strip__by">Requested by Altmo</span></a>');
    expect(html).toContain('href="/view/c"');
    expect(html).not.toContain('/view/a');
    // the requester's own link stays on the About panel: one link per item here
    expect(html).not.toContain('altmo.app');
  });

  it('titles each item as the page does (the level label)', () => {
    expect(requestedStripHtml(layers, (l) => `Label ${l.id}`)).toContain('<span class="req-strip__name">Label c</span>');
  });

  it('renders nothing when no layer was requested', () => {
    expect(requestedStripHtml([layers[0]])).toBe('');
  });

  it('puts a level holding a requested layer ahead of the others, keeping their order otherwise', () => {
    const byLevel = { l1: [layers[0]], l2: [layers[1]], l3: [layers[0]], l4: [layers[0], layers[2]] };
    expect(requestedFirst(['l1', 'l2', 'l3', 'l4'], byLevel)).toEqual(['l2', 'l4', 'l1', 'l3']);
  });
});

describe('a requested layer is never non-commercial', () => {
  it('flags a requested layer whose licence or source is non-commercial', () => {
    expect(requestedLayersThatAreNonCommercial([
      pesa,
      { id: 'nc', licence: 'CC-BY-NC-4.0', requested_by: { name: 'A' } },
      { id: 'nc2', licence: 'CC-BY-4.0', non_commercial: true, requested_by: { name: 'B' } },
      { id: 'free', licence: 'CC-BY-NC-4.0' },
    ])).toEqual(['nc', 'nc2']);
  });

  it('holds for every layer in the catalog', () => {
    expect(requestedLayersThatAreNonCommercial((catalog as { layers: object[] }).layers)).toEqual([]);
  });
});
