// The release flag for the point lookups (/api/v1/ground, /api/v1/surface and the
// MCP tools ground_at and surface_at). They stay unpublished until the release gate
// passes: POINT_PROFILES=on (a Pages environment variable) turns them on; "off"
// turns them off; unset, they are on only for a local host (wrangler pages dev),
// so production is off by default and local dev and tests are on.
// web/scripts/point-profiles.mjs is the build-time side (docs, FAQ, credits).

import { notFoundJson } from './api-not-found';

export const POINT_PROFILE_PATHS = ['/ground', '/surface'] as const;
export const POINT_PROFILE_TOOLS = ['ground_at', 'surface_at'] as const;

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function pointProfilesOn(env: { POINT_PROFILES?: string } | undefined, url: URL): boolean {
  const v = env?.POINT_PROFILES;
  if (v === 'on') return true;
  if (v === 'off') return false;
  return LOCAL.has(url.hostname);
}

/** The answer an endpoint gives while the flag is off: the same 404 as any path that is not an endpoint. */
export const notPublished = notFoundJson;
