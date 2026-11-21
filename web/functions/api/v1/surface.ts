// GET /api/v1/surface?lat=..&lng=..[&open_only=true]: what is on the ground at a
// point (place, land, climate zones, water, hazards, protected areas, access,
// services, infrastructure) in one call, with a pointer to mugilu for the air above.
// lib/surface.ts holds the layer table; lib/profile-endpoint.ts the flag, snapping
// and caching. Unpublished (a 404) unless POINT_PROFILES is on.
import { surfaceAt } from '../../lib/surface';
import { SURFACE_RASTER_VERSION } from '../../lib/surface-rasters';
import { profileHandler } from '../../lib/profile-endpoint';

export const onRequestGet = profileHandler('surface', (lat, lng, catalog, r2, opts) => surfaceAt(lat, lng, catalog, r2, undefined, opts), SURFACE_RASTER_VERSION);
