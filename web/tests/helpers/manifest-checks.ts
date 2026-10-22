// Checks for a web app manifest that meets Chrome's install criteria
// (name/short_name, start_url, display standalone, PNG icons at 192 + 512, no
// prefer_related_applications) plus our house rules: a stable id, scope, lang,
// description, theme/background colours, and a SEPARATE maskable 512 icon.
// Shared by web/tests/manifest.test.ts and collect/tests/manifest.test.ts, so it
// imports nothing but node built-ins (collect's CI installs only collect's deps)
// and returns a list of problems for the caller to assert empty.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_PATH = '/manifest.webmanifest';
export const MANIFEST_LINK = `<link rel="manifest" href="${MANIFEST_PATH}" />`;

type Icon = { src: string; sizes: string; type: string; purpose?: string };
export type Manifest = Record<string, unknown> & { icons?: Icon[] };

// Width/height straight from the PNG IHDR chunk, no image library.
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function readManifest(publicDir: string): Manifest {
  return JSON.parse(readFileSync(join(publicDir, MANIFEST_PATH), 'utf8')) as Manifest;
}

export function manifestProblems(publicDir: string, themeColor: string): string[] {
  const m = readManifest(publicDir);
  const problems: string[] = [];
  for (const k of ['id', 'name', 'short_name', 'description', 'start_url', 'scope', 'lang']) {
    if (typeof m[k] !== 'string' || !(m[k] as string).length) problems.push(`missing ${k}`);
  }
  if (m.display !== 'standalone') problems.push('display is not standalone');
  if ('prefer_related_applications' in m) problems.push('has prefer_related_applications');
  if (m.theme_color !== themeColor) problems.push(`theme_color is not ${themeColor}`);
  if (m.background_color !== themeColor) problems.push(`background_color is not ${themeColor}`);

  const icons = m.icons ?? [];
  // Combined "any maskable" crops the regular icon badly; keep them separate.
  if (icons.some((i) => /\s/.test(i.purpose ?? ''))) problems.push('icon with combined purpose');
  for (const [size, purpose] of [[192, 'any'], [512, 'any'], [512, 'maskable']] as const) {
    const icon = icons.find((i) => i.sizes === `${size}x${size}` && (i.purpose ?? 'any') === purpose);
    const label = `${size}px ${purpose} icon`;
    if (!icon) { problems.push(`no ${label}`); continue; }
    if (icon.type !== 'image/png') problems.push(`${label} is not image/png`);
    const file = join(publicDir, icon.src);
    if (!existsSync(file)) { problems.push(`${label} file ${icon.src} missing`); continue; }
    const dim = pngSize(readFileSync(file));
    if (dim?.width !== size || dim.height !== size) problems.push(`${label} file is ${JSON.stringify(dim)}`);
  }
  return problems;
}

// The Content-Type the _headers file sets for the manifest (null if none).
// Cloudflare Pages would otherwise guess the type from the extension.
export function manifestContentType(headersFile: string): string | null {
  const block = headersFile.split(/\n(?=\S)/).find((b) => b.startsWith(`${MANIFEST_PATH}\n`));
  return block?.match(/^\s+Content-Type:\s*(\S+)\s*$/m)?.[1] ?? null;
}
