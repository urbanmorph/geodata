// #314 follow-up: the map chrome stopped giving alternate sources their level's
// year ("Blocks", not "Blocks (2024)", for geoBoundaries ADM4), but the page's
// <title>, meta description, JSON-LD name and crawler <h1> still borrowed the
// LGD layer's label and description ("... LGD snapshot 2024."). They now use
// the same rule, and name the source so sibling alternates don't share a title.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildViewDataset, buildViewContent, layerLevelMeta, type CatalogLayer } from '../functions/lib/view-dataset';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
const byId = (id: string) => catalog.layers.find((l: { id: string }) => l.id === id) as CatalogLayer;
const ORIGIN = 'https://bharatlas.com';
const page = (layer: CatalogLayer, layers = catalog.layers) => {
  const meta = layerLevelMeta(layer, catalog.level_meta, layers);
  return { ds: buildViewDataset(layer, meta, ORIGIN), html: buildViewContent(layer, meta, ORIGIN) };
};

describe('SEO title and meta for alternate sources', () => {
  it("an alternate source's <title>, JSON-LD name and h1 carry no borrowed year and name the source", () => {
    const gb = byId('gb_adm4');
    const { ds, html } = page(gb);
    expect(ds.title).toBe(`Blocks from ${gb.source}`);
    expect(ds.jsonLd.name).toBe(ds.title);
    expect(html).toContain(`<h1>Blocks from ${gb.source}</h1>`);
    expect(ds.title).not.toMatch(/2024/);
  });

  it("an alternate's meta description is its own, never the LGD layer's snapshot line", () => {
    for (const id of ['soi_districts', 'gb_adm4', 'bhuvan_states']) {
      const { ds } = page(byId(id));
      expect(ds.description, id).not.toMatch(/LGD snapshot 2024/);
      expect(ds.ldDescription, id).not.toMatch(/LGD snapshot 2024/);
    }
  });

  it('siblings at one level get distinct titles', () => {
    const titles = ['lgd_districts', 'soi_districts', 'bhuvan_districts', 'gb_adm2'].map((id) => page(byId(id)).ds.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('an alternate with its own vintage keeps that year', () => {
    const gb = { ...byId('gb_adm4'), vintage: 2020 } as CatalogLayer;
    const blocks = catalog.layers.filter((l: { level: string }) => l.level === 'block' && l.id !== 'gb_adm4');
    expect(page(gb, [...blocks, gb]).ds.title).toBe(`Blocks (2020) from ${gb.source}`);
  });

  it('the primary (LGD) layer is unchanged: label, year and level description', () => {
    const { ds } = page(byId('lgd_blocks'));
    expect(ds.title).toBe('Blocks (2024)');
    expect(ds.description).toMatch(/LGD snapshot 2024/);
  });

  it("a layer whose catalog level_meta is keyed by its level (not its id) uses that entry", () => {
    for (const id of ['subsidence_megacities', 'gem_active_faults']) {
      const layer = byId(id);
      expect(catalog.level_meta[id], id).toBeUndefined();
      expect(layerLevelMeta(layer, catalog.level_meta, catalog.layers), id).toBe(catalog.level_meta[layer.level]);
      expect(page(layer).html, id).toContain(`<h1>${catalog.level_meta[layer.level].label}</h1>`);
    }
  });

  it('a layer with its own level_meta entry keeps its SEO title', () => {
    const id = 'wards_bengaluru_bbmp_2022';
    expect(layerLevelMeta(byId(id), catalog.level_meta, catalog.layers)).toBe(catalog.level_meta[id]);
  });
});
