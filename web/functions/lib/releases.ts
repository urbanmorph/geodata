// Routing for /releases/…: bharatlas's immutable, dated releases (scripts/release.py).
//
//   /releases/index.json                       every release (static, committed)
//   /releases/<code>/manifest.json|CHANGES.md|SHA256SUMS   static, committed
//   /releases/<code>/<data file>               302 to the same key on R2, bytes unchanged, if the release's
//                                              SHA256SUMS lists it; otherwise 404 here
//   /releases/<code>                           302 to its manifest (where the w3id.org address points)
//   /releases, /releases/<dataset>             the human pages (dist/releases.html, dist/releases/<dataset>.html,
//                                              built by scripts/releases-page.mjs); a dataset with no release 404s
//   /releases/<dataset>/latest[/<file>]        302 to the dataset's newest release (or that file of it)
import { R2_PUBLIC_BASE } from './r2-keys';

export type ReleaseRoute =
  | { kind: 'page'; dataset: string | null }
  | { kind: 'latest'; dataset: string; file: string | null }
  | { kind: 'static'; headers: Record<string, string> }
  | { kind: 'redirect'; location: string; status: 302 }
  | { kind: 'data'; sums: string; file: string; location: string }
  | { kind: 'notfound' };

/** bharatlas-<dataset>-<year>.<two-digit month> */
export const RELEASE_CODE = /^bharatlas-[a-z0-9_]+-\d{4}\.\d{2}$/;
/** A dataset code: a layer id, or a short code such as cw. */
export const DATASET = /^[a-z0-9_]+$/;
const STATIC_TYPES: Record<string, string> = {
  'manifest.json': 'application/json',
  'CHANGES.md': 'text/markdown; charset=utf-8',
  SHA256SUMS: 'text/plain; charset=utf-8',
  'index.json': 'application/json',
};
// A code's files never change once cut; the index changes when one is cut. Open to any origin so scripts can
// fetch manifests and check checksums.
const staticFile = (name: string): ReleaseRoute => ({
  kind: 'static',
  headers: {
    'content-type': STATIC_TYPES[name],
    'access-control-allow-origin': '*',
    'cache-control': name === 'index.json'
      ? 'public, max-age=300, stale-while-revalidate=86400'
      : 'public, max-age=3600, stale-while-revalidate=86400',
  },
});
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const redirect = (location: string): ReleaseRoute => ({ kind: 'redirect', location, status: 302 });

const plainFile = (file: string) => FILE_NAME.test(file) && !file.includes('..');

export function releaseRoute(segs: string[]): ReleaseRoute {
  if (segs.length === 0) return { kind: 'page', dataset: null };
  if (segs.length === 1 && segs[0] === 'index.json') return staticFile('index.json');
  const [code, file] = segs;
  if (DATASET.test(code)) {
    if (segs.length === 1) return { kind: 'page', dataset: code };
    if (file === 'latest' && segs.length === 2) return { kind: 'latest', dataset: code, file: null };
    if (file === 'latest' && segs.length === 3 && plainFile(segs[2])) return { kind: 'latest', dataset: code, file: segs[2] };
    return { kind: 'notfound' };
  }
  if (!RELEASE_CODE.test(code) || segs.length > 2) return { kind: 'notfound' };
  if (segs.length === 1) return redirect(`/releases/${code}/manifest.json`);
  if (file !== 'index.json' && STATIC_TYPES[file]) return staticFile(file);
  if (!plainFile(file)) return { kind: 'notfound' };
  return { kind: 'data', sums: `/releases/${code}/SHA256SUMS`, file,
    location: `${R2_PUBLIC_BASE}/releases/${code}/${file}` };
}

/** Whether a SHA256SUMS file ("<hex>  <name>" per line) lists this file. */
export const sumsList = (sums: string, file: string): boolean =>
  sums.split('\n').some((line) => line.trim().split(/\s+/)[1]?.replace(/^\*/, '') === file);

/** The newest release code of a dataset, from the release index (null if it has none). */
export const latestCode = (index: { latest?: Record<string, string> }, dataset: string): string | null =>
  (index.latest && Object.hasOwn(index.latest, dataset) ? index.latest[dataset] : null);
