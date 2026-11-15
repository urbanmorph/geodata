// Routing for /releases/…: bharatlas's immutable, dated releases (scripts/release.py).
//
//   /releases/index.json                       every release (static, committed)
//   /releases/<code>/manifest.json|CHANGES.md|SHA256SUMS   static, committed
//   /releases/<code>/<data file>               302 to the same key on R2, bytes unchanged
//   /releases/<code>                           302 to its manifest (where the w3id.org address will point)
//   /releases                                  302 to the index
import { R2_PUBLIC_BASE } from './r2-keys';

export type ReleaseRoute =
  | { kind: 'static'; headers: Record<string, string> }
  | { kind: 'redirect'; location: string; status: 302 }
  | { kind: 'notfound' };

/** bharatlas-<dataset>-<year>.<two-digit month> */
export const RELEASE_CODE = /^bharatlas-[a-z0-9_]+-\d{4}\.\d{2}$/;
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

export function releaseRoute(segs: string[]): ReleaseRoute {
  if (segs.length === 0) return redirect('/releases/index.json');
  if (segs.length === 1 && segs[0] === 'index.json') return staticFile('index.json');
  const [code, file] = segs;
  if (!RELEASE_CODE.test(code) || segs.length > 2) return { kind: 'notfound' };
  if (segs.length === 1) return redirect(`/releases/${code}/manifest.json`);
  if (file !== 'index.json' && STATIC_TYPES[file]) return staticFile(file);
  if (!FILE_NAME.test(file) || file.includes('..')) return { kind: 'notfound' };
  return redirect(`${R2_PUBLIC_BASE}/releases/${code}/${file}`);
}
