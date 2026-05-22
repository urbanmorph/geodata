// GET /og/view/<id>.png — curated-layer OG card.
// Reads catalog.json from same-origin, builds metadata, renders PNG.

import { curatedMetadata } from '../../lib/og-metadata';
import { renderOgPng } from '../../lib/og-render';
import { ogError, PNG_HEADERS } from '../../lib/og-response';
import { renderOgSvg } from '../../lib/og-template';

type Params = { id: string };

type Catalog = {
  layers?: Array<{ id: string; level: string; source: string; rows: number | null; licence?: string }>;
  level_meta?: Record<string, { label: string; unit?: string }>;
};

export const onRequestGet: PagesFunction<unknown, keyof Params> = async (ctx) => {
  const id = (ctx.params.id as string) || '';
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return ogError(404, 'invalid layer id');

  const origin = new URL(ctx.request.url).origin;
  const r = await fetch(`${origin}/catalog.json`);
  if (!r.ok) return ogError(503, `catalog ${r.status}`);
  const catalog = (await r.json()) as Catalog;

  const layer = catalog.layers?.find((l) => l.id === id);
  if (!layer) return ogError(404, 'layer not found');

  const meta = curatedMetadata({ layer, levelMeta: catalog.level_meta?.[layer.level] });
  const png = await renderOgPng(renderOgSvg(meta), origin);
  return new Response(png, { headers: PNG_HEADERS });
};
