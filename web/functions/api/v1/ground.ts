// GET /api/v1/ground?lat=..&lng=..[&open_only=true]: what is below a point
// (seismic zone and faults, rock and landform, resources, aquifer and
// groundwater, soil, subsidence, tunnels and buried utilities) in one call.
// lib/ground.ts holds the layer table; lib/profile-endpoint.ts the flag,
// snapping and caching. Unpublished (a 404) unless POINT_PROFILES is on.
import { groundAt } from '../../lib/ground';
import { SOILGRIDS } from '../../lib/soilgrids';
import { profileHandler } from '../../lib/profile-endpoint';

const soil = (SOILGRIDS.file as { md5?: string } | null)?.md5?.slice(0, 8) ?? 'none';

export const onRequestGet = profileHandler('Ground', (lat, lng, catalog, r2, opts) => groundAt(lat, lng, catalog, r2, undefined, opts), `soilgrids-${soil}`);
