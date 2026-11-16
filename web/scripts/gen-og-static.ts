// Site-wide share images (public/og-default|og-preview|og-about .svg + .png),
// drawn by the same template and fonts as the per-layer cards
// (functions/lib/og-template.ts, og-render.ts), so the two never drift.
//
//   npx vite-node scripts/gen-og-static.ts      (from web/)
//
// Idempotent: a file whose bytes would not change is left alone.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { renderOgHeroSvg, OG_FONT_FILES, type OgHero } from '../functions/lib/og-template';

export const HEROES: Record<string, OgHero> = {
  'og-default': {
    tagline: 'Every boundary in India,\none search away',
    sub: 'Wards, villages, forests, water and more',
    footer: ['Free and open data. No sign-up.', 'bharatlas.com'],
  },
  'og-preview': {
    tagline: 'View, verify, or publish\na geo file',
    sub: 'Nothing uploads until you click Publish',
    footer: ['GeoJSON · KML · GPX · Parquet', 'bharatlas.com/preview'],
  },
  'og-about': {
    tagline: 'About bharatlas',
    sub: 'Every layer keeps its source and licence',
    footer: ['Open source · MIT', 'bharatlas.com/about'],
  },
};

const pub = (f: string) => resolve(__dirname, '../public', f);

function writeIfChanged(path: string, data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (existsSync(path) && readFileSync(path).equals(buf)) {
    console.log(`unchanged ${path.split('/').pop()}`);
    return;
  }
  writeFileSync(path, buf);
  console.log(`wrote ${path.split('/').pop()} (${Math.round(buf.length / 1024)} KB)`);
}

async function main(): Promise<void> {
  await initWasm(readFileSync(resolve(__dirname, '../node_modules/@resvg/resvg-wasm/index_bg.wasm')));
  const fontBuffers = OG_FONT_FILES.map((f) => new Uint8Array(readFileSync(pub(f))));
  for (const [name, hero] of Object.entries(HEROES)) {
    const svg = renderOgHeroSvg(hero);
    writeIfChanged(pub(`${name}.svg`), svg);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'original' },
      font: { fontBuffers, defaultFontFamily: 'DM Sans', sansSerifFamily: 'DM Sans', loadSystemFonts: false },
    });
    const img = resvg.render();
    writeIfChanged(pub(`${name}.png`), img.asPng());
    img.free();
    resvg.free();
  }
}

await main();
