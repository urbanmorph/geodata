// The OpenAPI 3.1 description of the public read API, served at
// /api/v1/openapi.json for code generators, API tools and AI assistants.
//
// It describes what the handlers in functions/api/v1 actually do (parameters,
// defaults, clamps, envelopes, errors). tests/openapi.test.ts keeps the two in
// step: every route file must have a path here, every path here a route file,
// and every query parameter a handler reads must be declared.

/** functions/api/v1 file path → OpenAPI path: `layers/[id]/query.ts` → `/layers/{id}/query`. */
export function specPathForRouteFile(file: string): string {
  const path = file
    .replace(/\.ts$/, '')
    .replace(/(^|\/)index$/, '')
    .replace(/\[(\w+)\]/g, '{$1}');
  return '/' + path;
}

const ref = (kind: string, name: string) => ({ $ref: `#/components/${kind}/${name}` });
const q = (name: string, description: string, schema: Record<string, unknown>, required = false) =>
  ({ name, in: 'query', required, description, schema });
const ok = (description: string, schema: Record<string, unknown> = { type: 'object' }) => ({
  description,
  headers: { 'x-api-version': ref('headers', 'ApiVersion') },
  content: { 'application/json': { schema } },
});
const errors = (...codes: Array<'400' | '404' | '429' | '500'>) =>
  Object.fromEntries(codes.map((c) => [c, ref('responses', ({ '400': 'BadRequest', '404': 'NotFound', '429': 'TooManyRequests', '500': 'ServerError' })[c])]));

const LAT = ref('parameters', 'Lat');
const LNG = ref('parameters', 'Lng');
const LAYER_ID = ref('parameters', 'LayerId');
const data = (schema: Record<string, unknown>) => ({ type: 'object', properties: { data: schema } });

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'bharatlas API',
    version: 'v1',
    summary: "India's open geo layers as JSON: locate a point, query, filter and download layers.",
    description:
      'Public, read-only and free. No key, no sign-up; CORS is open. `/v1` only grows: fields are added, never renamed or removed, and every response carries `x-api-version: v1`. ' +
      'Each layer keeps the open licence its source published it under: read `licence` and `attribution` from `/layers/{id}` and credit the source when you use the data. ' +
      "Please send a `User-Agent` that names your app (for example `my-app/1.0`). We read it only to tell apps, AI tools and crawlers apart, so our counts of how each mode is used stay honest. We don't store it, and we don't track who you are. " +
      'Rate limits: 120 requests a minute per IP, 60 a minute for the locate endpoints; over the limit you get 429 with `retry-after`. ' +
      'Authoring maps is a separate API on collect.bharatlas.com (`/api/collect/v1`, behind a map’s share link, not described here). Its bulk import, `POST /collections/{id}/import` (admin link), takes up to 5000 `records` of `{geometry, properties, client_id?}`: `client_id` is your own stable id for the row (text, 1–128 characters, unique within the map). Re-importing a row with the same `client_id` updates that record in place if its data changed and otherwise leaves it alone, so running the same import twice adds nothing; the response counts `added`, `updated` and `unchanged` overall and per batch of 100 (`batches`). Rows without `client_id` are added again on every run.',
    contact: { name: 'bharatlas', url: 'https://bharatlas.com/docs' },
    license: { name: 'API code: MIT. Data: each layer keeps its source licence (see `licence` on every layer).', identifier: 'MIT' },
  },
  servers: [{ url: 'https://bharatlas.com/api/v1' }],
  externalDocs: { description: 'Developer guide', url: 'https://bharatlas.com/docs' },
  tags: [
    { name: 'Spatial', description: 'What is at, or near, a point' },
    { name: 'Layers', description: 'The catalogue and each layer’s rows' },
    { name: 'Catalogue', description: 'Categories, levels and download counts' },
    { name: 'Community', description: 'Layers people contributed' },
    { name: 'Releases', description: 'Dated, immutable releases pinned by SHA-256: the Census 2011 ↔ LGD crosswalks and the catalogue record' },
  ],
  paths: {
    '/locate': {
      get: {
        operationId: 'locate',
        tags: ['Spatial'],
        summary: 'Every boundary and zone that contains a point',
        description:
          'Point-in-polygon across admin and zone layers in one call: state, district, sub-district, block, constituencies, pincode, seismic zone and more, each with its LGD or source codes. With no `layers`, the default set is used and the city ward layer covering the point is added automatically. Never cached.',
        parameters: [
          LAT, LNG,
          q('layers', 'Comma-separated layer ids to test, used exactly as given. Omit for the default set plus any covering ward layer.', { type: 'string', examples: ['lgd_states,lgd_districts'] }),
          q('zoom', 'Tile zoom used for the test: 4–16, default 14 (finer is more exact at boundaries).', { type: 'integer', minimum: 4, maximum: 16, default: 14 }),
        ],
        responses: {
          '200': ok('Matches grouped by category', ref('schemas', 'LocateResult')),
          ...errors('400', '429'),
        },
      },
    },
    '/nearby': {
      get: {
        operationId: 'nearby',
        tags: ['Spatial'],
        summary: 'Features from one layer within a radius of a point, nearest first',
        description: 'Works for points, lines and polygons; distance is measured to each feature’s bounding-box centre.',
        parameters: [
          LAT, LNG,
          q('layer', 'Layer id to search.', { type: 'string' }, true),
          q('radius_km', 'Search radius in km: 1–200, default 25.', { type: 'number', minimum: 1, maximum: 200, default: 25 }),
          q('limit', 'Most features to return: 1–100, default 20.', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
        ],
        responses: {
          '200': ok('Features sorted by distance', ref('schemas', 'NearbyResult')),
          ...errors('400', '429'),
        },
      },
    },
    '/layers': {
      get: {
        operationId: 'listLayers',
        tags: ['Layers'],
        summary: 'The catalogue of curated layers',
        parameters: [
          q('category', 'Only this category (see /categories), e.g. `boundaries`, `city-wards`.', { type: 'string' }),
          q('level', 'Only this level (see /levels), e.g. `district`.', { type: 'string' }),
          q('source', 'Only this source, e.g. `LGD`.', { type: 'string' }),
          q('q', 'Text search over id, source and notes.', { type: 'string' }),
          ref('parameters', 'Limit500'),
          ref('parameters', 'Offset'),
        ],
        responses: {
          '200': ok('A page of layers', { allOf: [ref('schemas', 'Page'), { type: 'object', properties: { data: { type: 'array', items: ref('schemas', 'Layer') } } }] }),
          ...errors('429'),
        },
      },
    },
    '/layers/{id}': {
      get: {
        operationId: 'getLayer',
        tags: ['Layers'],
        summary: 'One layer: source, licence, attribution and download links',
        parameters: [LAYER_ID],
        responses: { '200': ok('The layer', data(ref('schemas', 'Layer'))), ...errors('400', '404', '429') },
      },
    },
    '/layers/{id}/schema': {
      get: {
        operationId: 'getLayerSchema',
        tags: ['Layers'],
        summary: 'Column names, types and sample values (read this before querying)',
        description: 'Columns of type `nested` (structs, lists, maps) can be selected but not filtered or grouped.',
        parameters: [LAYER_ID],
        responses: {
          '200': ok('The schema', data({
            type: 'object',
            properties: {
              row_count: { type: 'integer' },
              columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, distinct_values: { type: 'array', items: { type: 'string' } } } } },
            },
          })),
          ...errors('400', '404', '429', '500'),
        },
      },
    },
    '/layers/{id}/query': {
      get: {
        operationId: 'queryLayer',
        tags: ['Layers'],
        summary: 'Filter, select, group and total a layer’s rows',
        description:
          'Reads the layer’s Parquet file. Filters are exact, case-insensitive matches on flat columns, given as `where=col=val,col2=val2` or as plain `col=val` parameters (any parameter that is not an option below is a filter; use that form when a value contains a comma). Geometry columns are never returned. With `group_by` the result is counts per value (and `sums` with `sum`); without it, rows. A filter that matches nothing returns `hints` with the column’s values.',
        parameters: [
          LAYER_ID,
          q('select', 'Comma-separated columns to return. Default: all flat, non-geometry columns.', { type: 'string' }),
          q('where', 'Filters as `col=val,col2=val2` (exact, case-insensitive).', { type: 'string' }),
          q('group_by', 'Count rows per value of this column.', { type: 'string' }),
          q('sum', 'With `group_by`: comma-separated numeric columns to total per group. Percentages are not additive: sum the amounts and recompute shares.', { type: 'string' }),
          q('limit', 'Most rows to return: 1–1000, default 100.', { type: 'integer', minimum: 1, maximum: 1000, default: 100 }),
          q('include_centroid', 'Add `_lat` and `_lng` (bounding-box centre) to each row where the layer has bounding-box columns. Default true; `false` turns it off.', { type: 'boolean', default: true }),
          q('order_by', 'Reserved, not applied yet: rows come in file order. Accepted so it is never read as a column filter.', { type: 'string' }),
          q('filter', 'Filters as a JSON list, for more than exact matches: `[{"col":"sname","kind":"in","values":["KA","TN"]}]`; kinds `in` (case-insensitive, any of the values), `range` (numeric `min` and/or `max`), `search` (case-insensitive substring `q`), `bool` (`v`). Combined with `where` (all must match).', { type: 'string' }),
          q('format', 'Not used by /query (see /layers/{id}/export). Accepted so it is never read as a column filter.', { type: 'string' }),
        ],
        responses: {
          '200': ok('Rows, or counts per group', {
            type: 'object',
            properties: {
              data: { oneOf: [ref('schemas', 'QueryRows'), ref('schemas', 'QueryGroups')] },
              layer_id: { type: 'string' },
              timing_ms: { type: 'integer' },
            },
          }),
          ...errors('400', '404', '429', '500'),
        },
      },
    },
    '/layers/{id}/export': {
      get: {
        operationId: 'exportLayerRows',
        tags: ['Layers'],
        summary: 'The rows matching a filter, with their shapes, as GeoJSON, KML or CSV',
        description: 'Streams every row matching `where` and/or `filter` (same forms as /query), with all columns. A filter is required: the whole layer is a download (see the layer’s files). At most 50,000 rows; above that the answer is 400 with the match count, so narrow the filter or use the layer’s downloads. CSV carries the bounding-box centre as `_lat`, `_lng` instead of the shape.',
        parameters: [
          LAYER_ID,
          q('format', 'geojson (default), kml or csv.', { type: 'string', enum: ['geojson', 'kml', 'csv'], default: 'geojson' }),
          q('where', 'Filters as `col=val,col2=val2` (exact, case-insensitive).', { type: 'string' }),
          q('filter', 'Filters as a JSON list, for more than exact matches: `[{"col":"sname","kind":"in","values":["KA","TN"]}]`; kinds `in` (case-insensitive, any of the values), `range` (numeric `min` and/or `max`), `search` (case-insensitive substring `q`), `bool` (`v`). Combined with `where` (all must match).', { type: 'string' }),
        ],
        responses: { '200': { description: 'The file, streamed' }, ...errors('400', '404', '429', '500') },
      },
    },
    '/layers/{id}/counts': {
      get: {
        operationId: 'countLayer',
        tags: ['Layers'],
        summary: 'Feature total, or precomputed counts per value of one column',
        description: 'Without `group_by`: the total and the columns that can be grouped. Counts come from precomputed statistics, so they cover single columns only; for cross-filters use /query or the Parquet download.',
        parameters: [
          LAYER_ID,
          q('group_by', 'Column to count values of (one listed in `groupable_columns`).', { type: 'string' }),
          q('filter_col', 'Not applied: precomputed counts are single-column. With `filter_val` the response carries `filter_note` saying so.', { type: 'string' }),
          q('filter_val', 'See `filter_col`.', { type: 'string' }),
        ],
        responses: { '200': ok('Counts', data({ type: 'object' })), ...errors('400', '404', '429') },
      },
    },
    '/layers/{id}/locate': {
      get: {
        operationId: 'locateInLayer',
        tags: ['Spatial'],
        summary: 'The feature of one layer that contains a point, or the nearest one',
        description: '`contains` tests point-in-polygon; `nearest` returns the closest feature with distance and compass bearing; `auto` (default) tries contains, then nearest. Never cached.',
        parameters: [
          LAYER_ID, LAT, LNG,
          q('mode', 'auto (default), contains or nearest.', { type: 'string', enum: ['auto', 'contains', 'nearest'], default: 'auto' }),
          q('zoom', 'Tile zoom for contains: 4–16, default 14.', { type: 'integer', minimum: 4, maximum: 16, default: 14 }),
          q('radius_km', 'Search radius for nearest: 1–200, default 25.', { type: 'number', minimum: 1, maximum: 200, default: 25 }),
        ],
        responses: {
          '200': ok('The feature, or `feature: null` (with `out_of_coverage` when nothing is within the radius)', {
            type: 'object',
            properties: {
              layer_id: { type: 'string' },
              point: ref('schemas', 'Point'),
              mode: { type: 'string', enum: ['contains', 'nearest'] },
              feature: { type: ['object', 'null'] },
              distance_km: { type: 'number' },
              bearing: { type: 'string' },
              out_of_coverage: { type: 'boolean' },
            },
          }),
          ...errors('400', '404', '429', '500'),
        },
      },
    },
    '/usage': {
      get: {
        operationId: 'getUsage',
        tags: ['Catalogue'],
        summary: 'How much each layer is used: downloads, and API calls that name it (split api / mcp)',
        description: 'Crawlers and the MCP smoke test are not counted. With ?layer=, one layer: { layer_id, downloads, api, mcp }; without it, { layers: { <id>: { downloads, api, mcp } }, total }.',
        parameters: [q('layer', 'Layer id: one layer only.', { type: 'string' })],
        responses: {
          '200': ok('Usage counts', { type: 'object' }),
          ...errors('400', '500'),
        },
      },
    },
    '/categories': {
      get: {
        operationId: 'listCategories',
        tags: ['Catalogue'],
        summary: 'Categories with their layer counts',
        responses: { '200': ok('Categories', data({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, layer_count: { type: 'integer' } } } })), ...errors('429') },
      },
    },
    '/levels': {
      get: {
        operationId: 'listLevels',
        tags: ['Catalogue'],
        summary: 'Admin levels in order, country to village and beyond',
        responses: { '200': ok('Levels', data({ type: 'array', items: { type: 'object' } })), ...errors('429') },
      },
    },
    '/downloads/counts': {
      get: {
        operationId: 'downloadCounts',
        tags: ['Catalogue'],
        summary: 'Downloads per layer and format, and the total',
        responses: {
          '200': ok('Counts', { type: 'object', properties: { data: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'integer' } } }, total: { type: 'integer' } } }),
          ...errors('429'),
        },
      },
    },
    '/submissions': {
      get: {
        operationId: 'listSubmissions',
        tags: ['Community'],
        summary: 'Accepted community layers',
        description: 'Each is queryable through /layers/{id}/query and /layers/{id}/schema like a curated layer, and carries its own licence.',
        parameters: [
          q('sort', 'recent (default) or useful.', { type: 'string', enum: ['recent', 'useful'], default: 'recent' }),
          q('category', 'Only this category.', { type: 'string' }),
          q('q', 'Search name and description.', { type: 'string' }),
          q('limit', 'Results per page: 1–100, default 20.', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
          ref('parameters', 'Offset'),
        ],
        responses: { '200': ok('A page of submissions', ref('schemas', 'Page')), ...errors('429') },
      },
    },
    '/submissions/{id}': {
      get: {
        operationId: 'getSubmission',
        tags: ['Community'],
        summary: 'One accepted community layer',
        parameters: [{ name: 'id', in: 'path', required: true, description: 'Submission id.', schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' } }],
        responses: { '200': ok('The submission', data({ type: 'object' })), ...errors('400', '404', '429') },
      },
    },
    '/releases': {
      get: {
        operationId: 'listReleases',
        tags: ['Releases'],
        summary: 'Dated releases, newest first, with each code’s SHA-256 pin and files',
        description:
          'A release code is `bharatlas-<dataset>-<year>.<month>` (e.g. `bharatlas-cw-2026.11`); it is never reused and its files never change. ' +
          'Cite it with its pin, `<code>+sha256:<hex>`, where the hex is the SHA-256 of the release’s `SHA256SUMS`. ' +
          'Files are served unchanged at `https://bharatlas.com/releases/<code>/<file>` beside `manifest.json`, `CHANGES.md` and `SHA256SUMS`; ' +
          'the same index is at `https://bharatlas.com/releases/index.json`. Sourced data keeps its source’s licence: each file names it, and the source is credited first.',
        responses: { '200': ok('The release index', data(ref('schemas', 'ReleaseIndex'))), ...errors('429', '500') },
      },
    },
  },
  components: {
    parameters: {
      Lat: { name: 'lat', in: 'query', required: true, description: 'Latitude, within India: 6–38.', schema: { type: 'number', minimum: 6, maximum: 38 } },
      Lng: { name: 'lng', in: 'query', required: true, description: 'Longitude, within India: 68–98.', schema: { type: 'number', minimum: 68, maximum: 98 } },
      LayerId: { name: 'id', in: 'path', required: true, description: 'Layer id, from /layers or /submissions.', schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$', examples: ['lgd_districts'] } },
      Limit500: { name: 'limit', in: 'query', description: 'Results per page: 1–500, default 100.', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
      Offset: { name: 'offset', in: 'query', description: 'Results to skip, default 0.', schema: { type: 'integer', minimum: 0, default: 0 } },
    },
    headers: {
      ApiVersion: { description: 'Always `v1` on this version.', schema: { type: 'string', const: 'v1' } },
    },
    responses: {
      BadRequest: { description: 'A parameter is missing or out of range', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
      NotFound: { description: 'No such layer, submission or code', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
      TooManyRequests: {
        description: 'Over the rate limit; wait `retry-after` seconds',
        headers: { 'retry-after': { description: 'Seconds to wait', schema: { type: 'integer' } } },
        content: { 'application/json': { schema: ref('schemas', 'Error') } },
      },
      ServerError: { description: 'Reading the layer failed', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
    },
    schemas: {
      Error: { type: 'object', required: ['error', 'status'], properties: { error: { type: 'string' }, status: { type: 'integer' } } },
      Page: { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } } },
      Point: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } },
      Layer: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          level: { type: 'string' },
          source: { type: 'string' },
          category: { type: 'string' },
          rows: { type: ['integer', 'null'] },
          provenance: { type: 'string' },
          licence: { type: 'string', description: 'SPDX-style licence id(s) of the source, e.g. `CC0-1.0`, `ODbL-1.0`, `GODL-India`.' },
          attribution: { type: 'object', description: 'Who to credit: `primary` is the source, `publisher` who prepared it.', properties: { primary: ref('schemas', 'Credit'), publisher: ref('schemas', 'Credit') } },
          notes: { type: 'string' },
          downloads: { type: 'object', description: 'Format → file: parquet, pmtiles, geojson, kml, shapefile (each where available).', additionalProperties: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, bytes: { type: ['integer', 'null'] } } } },
        },
      },
      Credit: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' } } },
      ReleaseIndex: {
        type: 'object',
        properties: {
          latest: { type: 'object', description: 'Dataset → its newest release code.', additionalProperties: { type: 'string' } },
          releases: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', examples: ['bharatlas-cw-2026.11'] },
                dataset: { type: 'string' },
                title: { type: 'string' },
                released: { type: 'string', format: 'date' },
                sha256: { type: 'string', description: 'SHA-256 of the release’s SHA256SUMS file.' },
                pin: { type: 'string', description: '`<code>+sha256:<hex>`' },
                url: { type: 'string', format: 'uri' },
                manifest: { type: 'string', format: 'uri' },
                w3id_proposed: { type: 'string', format: 'uri', description: 'The persistent address the code will resolve through once registered.' },
                previous: { type: ['string', 'null'] },
                files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, sha256: { type: 'string' }, bytes: { type: 'integer' }, rows: { type: ['integer', 'null'] }, licence: { type: 'string' } } } },
              },
            },
          },
        },
      },
      LocateResult: {
        type: 'object',
        properties: {
          point: ref('schemas', 'Point'),
          results: {
            type: 'object',
            description: 'Category → matches, e.g. `boundaries`, `people`, `environment`, `city-wards`.',
            additionalProperties: { type: 'array', items: { type: 'object', properties: { layer_id: { type: 'string' }, level: { type: 'string' }, feature: { type: 'object', properties: { properties: { type: 'object' } } } } } },
          },
          queried_layers: { type: 'array', items: { type: 'string' } },
          timing_ms: { type: 'integer' },
        },
      },
      NearbyResult: {
        type: 'object',
        properties: {
          center: ref('schemas', 'Point'),
          radius_km: { type: 'number' },
          total: { type: 'integer' },
          features: { type: 'array', items: { type: 'object', properties: { properties: { type: 'object' }, _lat: { type: 'number' }, _lng: { type: 'number' }, _distance_km: { type: 'number' } } } },
        },
      },
      QueryRows: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          hints: { type: 'object', description: 'On no match: values (or available columns) for the filtered columns.' },
        },
      },
      QueryGroups: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          counts: { type: 'object', additionalProperties: { type: 'integer' } },
          sums: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'number' } } },
          total: { type: 'integer' },
        },
      },
    },
  },
} as const;
