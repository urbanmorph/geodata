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
const RESPONSES = {
  '301': 'MovedPermanently', '400': 'BadRequest', '404': 'NotFound', '429': 'TooManyRequests', '500': 'ServerError', '503': 'Unavailable',
} as const;
const errors = (...codes: Array<keyof typeof RESPONSES>) =>
  Object.fromEntries(codes.map((c) => [c, ref('responses', RESPONSES[c])]));

const LAT = ref('parameters', 'Lat');
const LNG = ref('parameters', 'Lng');
const LAYER_ID = ref('parameters', 'LayerId');
const data = (schema: Record<string, unknown>) => ({ type: 'object', properties: { data: schema } });

const BASE = {
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
          q('layers', 'Comma-separated layer ids to test (at most 25). A retired id is tested as its successor; an id that is not a layer is listed in `unknown_layers`, and when none is a layer the answer is 400. Omit for the default set plus any covering ward layer.', { type: 'string', examples: ['lgd_states,lgd_districts'] }),
          q('zoom', 'Tile zoom used for the test: 4–16, default 14 (finer is more exact at boundaries).', { type: 'integer', minimum: 4, maximum: 16, default: 14 }),
        ],
        responses: {
          '200': ok('Matches grouped by category', ref('schemas', 'LocateResult')),
          ...errors('400', '429', '500'),
        },
      },
    },
    '/nearby': {
      get: {
        operationId: 'nearby',
        tags: ['Spatial'],
        summary: 'Features from one layer within a radius of a point, nearest first',
        description: 'Works for points, lines and polygons. Points are measured to the point; lines and polygons to the nearest part of their shape (0 inside a polygon), and `_lat`, `_lng` are that nearest point. `_distance_to` says which (point or shape). `_approximate: true` means the search read coarser map tiles or fewer shapes than it wanted (a large radius on a dense layer): distances to within tens of metres, and the count may be short. Lines and polygons used to be measured to their bounding-box centre; answers for those layers changed when distance to the shape shipped.',
        parameters: [
          LAT, LNG,
          q('layer', 'Layer id to search.', { type: 'string' }, true),
          q('radius_km', 'Search radius in km: 1–200, default 25.', { type: 'number', minimum: 1, maximum: 200, default: 25 }),
          q('limit', 'Most features to return: 1–100, default 20.', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
        ],
        responses: {
          '200': ok('Features sorted by distance', ref('schemas', 'NearbyResult')),
          ...errors('301', '400', '429', '500'),
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
          q('q', 'Text search (case-insensitive substring) over id, source, notes, category, level and tags.', { type: 'string' }),
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
        responses: { '200': ok('The layer', data(ref('schemas', 'Layer'))), ...errors('301', '400', '404', '429') },
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
          ...errors('301', '400', '404', '429', '500'),
        },
      },
    },
    '/layers/{id}/query': {
      get: {
        operationId: 'queryLayer',
        tags: ['Layers'],
        summary: 'Filter, select, group and total a layer’s rows',
        description:
          'Reads the layer’s Parquet file. Filters are exact, case-insensitive matches on flat columns, given as `where=col=val,col2=val2` or as plain `col=val` parameters (any parameter that is not an option below is a filter; use that form when a value contains a comma). Geometry columns are never returned. With `group_by` the result is counts per value (and `sums` with `sum`); without it, rows. An unknown column in `select`, `where`, `filter`, `group_by` or `sum` is a 400 that lists the columns, before any row is read. A filter that matches nothing returns `hints` with the column’s values. Answers are kept in the edge cache for up to an hour.',
        parameters: [
          LAYER_ID,
          q('select', 'Comma-separated columns to return. Default: every column except the geometry and the bounding-box columns (`xmin`, `ymin`, `xmax`, `ymax`; `_lat` and `_lng` carry the centre). An unknown column is a 400.', { type: 'string' }),
          q('where', 'Filters as `col=val,col2=val2` (exact, case-insensitive).', { type: 'string' }),
          q('group_by', 'Count rows per value of this column.', { type: 'string' }),
          q('sum', 'With `group_by`: comma-separated numeric columns to total per group. Percentages are not additive: sum the amounts and recompute shares.', { type: 'string' }),
          q('limit', 'Most rows to return: 1–1000, default 100.', { type: 'integer', minimum: 1, maximum: 1000, default: 100 }),
          q('include_centroid', 'Add `_lat` and `_lng` (bounding-box centre) to each row where the layer has bounding-box columns. Default true; `false` turns it off.', { type: 'boolean', default: true }),
          q('order_by', 'Reserved, not applied yet: rows come in file order. Accepted so it is never read as a column filter.', { type: 'string' }),
          q('filter', 'Filters as a JSON list, for more than exact matches: `[{"col":"sname","kind":"in","values":["KA","TN"]}]`; kinds `in` (case-insensitive, any of the values), `range` (numeric `min` and/or `max`), `search` (case-insensitive substring `q`), `bool` (`v`). Combined with `where` (all must match).', { type: 'string' }),
          q('format', 'Not used by /query (see /layers/{id}/export). Accepted so it is never read as a column filter.', { type: 'string' }),
          q('estimate', 'Not used by /query (see /layers/{id}/export). Accepted so it is never read as a column filter.', { type: 'string' }),
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
          ...errors('301', '400', '404', '429', '500'),
        },
      },
    },
    '/layers/{id}/export': {
      get: {
        operationId: 'exportLayerRows',
        tags: ['Layers'],
        summary: 'The rows matching a filter, with their shapes, as GeoJSON, KML or CSV',
        description: 'Streams every row matching `where` and/or `filter` (same forms as /query), with all columns. A filter is required: the whole layer is a download (see the layer’s files). At most 50,000 rows and an estimated 100 MB; above either the answer is 400 with the match count and the estimate, so narrow the filter or use the layer’s downloads. GeoJSON and KML also refuse (400) matches spread over more than 1 GB of the layer’s shapes (`shape_bytes` against `max_shape_bytes` in the estimate); CSV has no such limit. `estimate=1` returns the count and each format’s estimated size as JSON without exporting. An export that fails after it starts ends the connection without completing the response, so a client sees a failed download, never a short file. CSV carries the bounding-box centre as `_lat`, `_lng` instead of the shape.',
        parameters: [
          LAYER_ID,
          q('format', 'geojson (default), kml or csv.', { type: 'string', enum: ['geojson', 'kml', 'csv'], default: 'geojson' }),
          q('estimate', '1: only the match count and the estimated size of each format (JSON), no export.', { type: 'string', enum: ['1'] }),
          q('where', 'Filters as `col=val,col2=val2` (exact, case-insensitive).', { type: 'string' }),
          q('filter', 'Filters as a JSON list, for more than exact matches: `[{"col":"sname","kind":"in","values":["KA","TN"]}]`; kinds `in` (case-insensitive, any of the values), `range` (numeric `min` and/or `max`), `search` (case-insensitive substring `q`), `bool` (`v`). Combined with `where` (all must match).', { type: 'string' }),
        ],
        responses: { '200': { description: 'The file, streamed' }, ...errors('301', '400', '404', '429', '500') },
      },
    },
    '/layers/{id}/counts': {
      get: {
        operationId: 'countLayer',
        tags: ['Layers'],
        deprecated: true,
        summary: 'Feature total, or counts per value of one column (deprecated: use /query with group_by)',
        description: 'Deprecated; retires on 22 December 2026 (every answer carries `Deprecation`, `Sunset` and a `Link` to /query). `/layers/{id}/query?group_by=<col>` gives the same counts, with `where`, `filter` and `sum`. Without `group_by`: the total and the columns with precomputed counts, or with `filter_col` and `filter_val` the total of matching rows. With `group_by`: precomputed counts where they exist, otherwise counted from the Parquet file (the 500 largest groups). An unknown filter column, or one of `filter_col` and `filter_val` without the other, is a 400.',
        parameters: [
          LAYER_ID,
          q('group_by', 'Column to count values of.', { type: 'string' }),
          q('filter_col', 'With `filter_val`, count only rows whose `filter_col` equals `filter_val` (exact, case-insensitive).', { type: 'string' }),
          q('filter_val', 'See `filter_col`.', { type: 'string' }),
        ],
        responses: { '200': ok('Counts', data({ type: 'object' })), ...errors('301', '400', '404', '429', '500') },
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
          '200': ok('The feature, or `feature: null` (with `out_of_coverage` when nothing is within the radius). Counts as a call that names the layer (see /usage).', {
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
          ...errors('301', '400', '404', '429', '500'),
        },
      },
    },
    '/usage': {
      get: {
        operationId: 'getUsage',
        tags: ['Catalogue'],
        summary: 'How much each layer is used: downloads, and API calls that name it (split api / mcp)',
        description: 'API calls count when they name one layer (its detail, schema, query, counts, export or nearby); locate, in one layer or many, does not. Crawlers and the MCP smoke test are not counted. With ?layer=, one layer: { layer_id, downloads, api, mcp } (an id that is not a layer is a 404, a retired one a 301); without it, { layers: { <id>: { downloads, api, mcp } }, total }. Counts may lag a minute.',
        parameters: [q('layer', 'Layer id: one layer only.', { type: 'string' })],
        responses: {
          '200': ok('Usage counts', { type: 'object' }),
          ...errors('301', '400', '404', '429', '500', '503'),
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
          ...errors('429', '503'),
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
        parameters: [{ name: 'id', in: 'path', required: true, description: 'Submission id.', schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,16}$' } }],
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
      MovedPermanently: {
        description: 'The layer id was retired: the same request with its successor id (in the path, or in `layer=`) is in `location`.',
        headers: { location: { description: 'The same URL with the successor id', schema: { type: 'string', format: 'uri' } } },
      },
      BadRequest: { description: 'A parameter is missing or out of range', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
      NotFound: { description: 'No such layer, submission or code', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
      TooManyRequests: {
        description: 'Over the rate limit; wait `retry-after` seconds',
        headers: { 'retry-after': { description: 'Seconds to wait', schema: { type: 'integer' } } },
        content: { 'application/json': { schema: ref('schemas', 'Error') } },
      },
      ServerError: { description: 'Reading the layer failed', content: { 'application/json': { schema: ref('schemas', 'Error') } } },
      Unavailable: {
        description: 'The counts store is unavailable; try again after `retry-after` seconds',
        headers: { 'retry-after': { description: 'Seconds to wait', schema: { type: 'integer' } } },
        content: { 'application/json': { schema: ref('schemas', 'Error') } },
      },
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
          versions: {
            type: 'array',
            description: 'On `/layers/{id}` only: the layer’s dated releases, newest first, each one fixed by its SHA-256. Cite the version you used by its `code` (or its `w3id` address). Empty until the layer’s first release; `downloads` always point at the latest files.',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string', examples: ['bharatlas-lgd_states-2026.12'] },
                released: { type: 'string', format: 'date' },
                sha256: { type: 'string', description: 'SHA-256 of the release’s SHA256SUMS file.' },
                w3id: { type: 'string', format: 'uri', description: 'Persistent address of the release.' },
                url: { type: 'string', format: 'uri' },
              },
            },
          },
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
                w3id_proposed: { type: 'string', format: 'uri', description: 'The persistent address of this release, live at w3id.org: `https://w3id.org/bharatlas/<dataset>/<YYYY.MM>[/<file>]`, and `https://w3id.org/bharatlas/<dataset>/latest` for the newest. The field keeps its first name for compatibility.' },
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
          zoom: { type: 'integer', description: 'The tile zoom used.' },
          results: {
            type: 'object',
            description: 'Category → matches, e.g. `boundaries`, `people`, `environment`, `city-wards`.',
            additionalProperties: { type: 'array', items: { type: 'object', properties: { layer_id: { type: 'string' }, level: { type: 'string' }, feature: { type: 'object', properties: { properties: { type: 'object' } } } } } },
          },
          queried_layers: { type: 'array', items: { type: 'string' } },
          failed_layers: { type: 'array', items: { type: 'string' }, description: 'Layers that could not be read: their absence from `results` says nothing about the point. Absent when every layer answered.' },
          unknown_layers: { type: 'array', items: { type: 'string' }, description: 'Ids in `layers` that are not layers (not tested). Absent when every id was known.' },
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
          _distance_to: { type: 'string', enum: ['point', 'shape', 'centroid'], description: 'point: distance to each point; shape: to the nearest part of each line or polygon; centroid: to the centre of each feature (a layer without bounding-box columns).' },
          _approximate: { type: 'boolean', description: 'Present (true) when coarser tiles or fewer shapes were read: distances to within tens of metres, the count may be short.' },
        },
      },
      QueryRows: {
        type: 'object',
        properties: {
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          hints: { type: 'object', description: 'On no match: sample values of each filtered column.' },
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

// The point lookups, described only while they are published (lib/point-profiles.ts).
const POINT_PROFILE_PATHS_SPEC = {
  '/ground': {
    get: {
      operationId: 'groundAt',
      tags: ['Spatial'],
      summary: 'What is below a point: its subsurface profile in one call',
      description:
        'Seismic zone, nearest active faults, mapped lineaments and recorded earthquakes; rock (GSI lithology) and landform; aquifer, stage of groundwater extraction, a permeability class from GLHYMPS (global and coarse: pervious, semi-pervious or impervious) and nearby groundwater wells; ' +
        'soil properties at 0-5, 5-15 and 15-30 cm and the WRB soil group from ISRIC SoilGrids 2.0 (250 m, CC BY 4.0), plus the nearest Soil Health Card sample; ground subsidence in megacities (median of satellite points within 500 m); ' +
        'tunnels, buried pipelines and cables, mines and caves nearby; and, in rural areas, the CoRE Stack micro-watershed water balance and drought. ' +
        'Each layer is one entry under `sections.<section>.<layer_id>` with its `credit` (source, licence) and, for non-commercial layers, `non_commercial` and `licence_notice`; units are in field names or `units`. ' +
        '`contains` entries list the features holding the point; `nearest` entries give `count` within `radius_km` and the nearest few with `distance_km` (points by distance to the point, lines by true distance to the line: `distance_to`). ' +
        'Every entry has a `status`: `found`, `none_within_radius` (the layer covers the area, nothing is that close; `radius_km: 0` on an all-India map such as the NDEM flood extents means the point is in none of its areas) or `not_covered` (the layer does not reach this point, e.g. subsidence outside its cities). ' +
        'Each entry also says its `about`: scale or resolution, vintage and the date bharatlas fetched it; `disclaimer` says once that this is screening information, not for site or engineering decisions. ' +
        'A layer that cannot be read within 2.5 seconds is listed in `unavailable` (reason `took longer than 2500 ms`, or `could not be read`) and the rest still answer; such an answer is not kept in the edge cache, so asking again usually completes it. `summary` says it in one line. ' +
        'The answer is for the point snapped to 3 decimal places (about 100 m; `point` says which), kept in the edge cache for an hour when every layer answered, never by clients. Uses the locate rate limit (60 a minute).',
      parameters: [
        LAT, LNG,
        q('open_only', 'true leaves out the non-commercial layers (NRSC geomorphology, lineaments, groundwater quality and prospects, NDEM floods); they are named in `omitted_non_commercial`.', { type: 'boolean', default: false }),
      ],
      responses: {
        '200': ok('The profile', ref('schemas', 'GroundResult')),
        ...errors('400', '429', '500'),
      },
    },
  },
  '/surface': {
    get: {
      operationId: 'surfaceAt',
      tags: ['Spatial'],
      summary: 'What is on the ground at a point, in one call',
      description:
        'Sections: `place` (state, district, sub-district, block, constituencies, pincode, city or national ward), `land` (land cover, elevation and slope from Copernicus DEM GLO-90, population per km2 from WorldPop 2020, CoRE Stack block land use, land degradation), ' +
        '`climate` (agro-climatic, agro-ecological, eco and biogeographic zones), `water` (basin and sub-basin; the nearest river, water body, reservoir, dam, wetland and Ramsar site by true distance; Amrit Sarovar ponds; recorded floods and NDEM flood extents), ' +
        '`hazards` (seismic zone, landslide hazard and recorded landslides, cyclone tracks within 100 km, coastal regulation zone), `protected` (recorded forest, the nearest protected area and wildlife corridor, 0 km when inside), ' +
        '`access` (nearest national highway, railway station, metro or suburban station, airport, bus stop), `services` (nearest hospital from three sources, school, places within 1 km), `infrastructure` (power line, power plant, water-supply facility, distance to India\'s outline). ' +
        'Entries follow /ground: `credit`, `about`, `status` (found, none_within_radius, not_covered), `non_commercial` and `licence_notice`, `units`, `summary`, `disclaimer`, `unavailable`. Raster entries (`match: pixel`) carry `values`. ' +
        '`air` points to the mugilu MCP (conditions_at) for the air above the point. Snapped to about 100 m and edge-cached like /ground; uses the locate rate limit (60 a minute).',
      parameters: [
        LAT, LNG,
        q('open_only', 'true leaves out the non-commercial layers (NRSC land degradation, NDEM floods, landslide hazard and cyclone tracks); they are named in `omitted_non_commercial`.', { type: 'boolean', default: false }),
      ],
      responses: {
        '200': ok('The profile', ref('schemas', 'SurfaceResult')),
        ...errors('400', '429', '500'),
      },
    },
  },
} as const;

const POINT_PROFILE_SCHEMAS = {
  GroundResult: {
    type: 'object',
    properties: {
      point: ref('schemas', 'Point'),
      summary: { type: 'string', description: 'The profile in one readable line.' },
      disclaimer: { type: 'string', description: 'Screening information, not for site or engineering decisions.' },
      omitted_non_commercial: { type: 'array', items: { type: 'string' }, description: 'With open_only=true: the non-commercial layers left out.' },
      sections: {
        type: 'object',
        description: 'seismic, geology, resources, groundwater, soil, subsidence, underground, watershed: each maps a layer id (or `soilgrids`) to its entry.',
        additionalProperties: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              layer_id: { type: 'string' },
              match: { type: 'string', enum: ['contains', 'nearest', 'pixel'] },
              status: { type: 'string', enum: ['found', 'none_within_radius', 'not_covered'], description: 'not_covered: the layer does not reach this point; none_within_radius: it does, but nothing is within radius_km (0: the point is in none of the areas of an all-India map).' },
              distance_to: { type: 'string', enum: ['point', 'shape'], description: 'nearest: distance to the feature point, or to the nearest part of the line or outline (0 inside a polygon).' },
              credit: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, publisher: { type: 'object' }, licence: { type: 'string' }, licence_url: { type: 'string' } } },
              non_commercial: { type: 'boolean' },
              licence_notice: { type: 'string' },
              units: { type: 'object', additionalProperties: { type: 'string' } },
              about: { type: 'object', properties: { scale: { type: 'string' }, vintage: { type: 'string', description: 'The period the data describe, or "not dated by the source" (then fetched_at dates it).' }, note: { type: 'string' }, fetched_at: { type: 'string', format: 'date' } } },
              features: { type: 'array', items: { type: 'object' }, description: 'contains: the features holding the point (identical ones once).' },
              decoded: { type: 'object', description: 'Source encodings in plain units (e.g. the GLHYMPS permeability class).' },
              radius_km: { type: 'number' },
              count: { type: 'integer', description: 'nearest: features within radius_km.' },
              count_capped: { type: 'boolean', description: 'More features were in range than were read; `count` and `stats` cover those read.' },
              nearest: { type: 'array', items: { type: 'object', properties: { distance_km: { type: 'number' }, lat: { type: 'number', description: 'The feature point, or the nearest point of the line.' }, lng: { type: 'number' }, properties: { type: 'object' }, decoded: { type: 'object' } } } },
              links: { type: 'object', additionalProperties: { type: 'string', format: 'uri' }, description: 'Related downloads, e.g. a station layer\'s full readings.' },
              stats: { type: 'object', additionalProperties: { type: ['number', 'null'] }, description: 'e.g. subsidence: median_VLM_cm_per_yr, the median over points of each point\'s median reading, with points and readings counted.' },
              values: { type: ['object', 'null'], description: 'pixel: the raster values at the point (field names carry units).' },
              resolution_m: { type: 'integer' },
              depths: { type: ['object', 'null'], description: 'SoilGrids: depth interval (0-5cm, 5-15cm, 15-30cm) to clay_pct, sand_pct, silt_pct, ph_water, soc_g_per_kg, bulk_density_g_per_cm3, cec_cmolc_per_kg, nitrogen_g_per_kg.' },
              wrb_class: { type: ['string', 'null'], description: 'SoilGrids: most probable WRB reference soil group.' },
              reason: { type: 'string', description: 'Why SoilGrids has no value here (water, built-up land, outside its land mask).' },
            },
          },
        },
      },
      unavailable: { type: 'array', items: { type: 'object', properties: { layer_id: { type: 'string' }, reason: { type: 'string' } } }, description: 'Layers that could not be read within 2.5 seconds (or at all): their absence says nothing about the point.' },
      attribution: { type: 'array', items: { type: 'string' }, description: 'The sources that answered, with their licences: credit them when you use the result.' },
      timing_ms: { type: 'integer' },
      layer_timing_ms: { type: 'object', additionalProperties: { type: 'integer' } },
    },
  },
  SurfaceResult: {
    allOf: [ref('schemas', 'GroundResult'), {
      type: 'object',
      properties: {
        air: { type: 'object', description: 'Where to ask about the air above the point: the mugilu MCP server, its tool and arguments.' },
      },
    }],
  },
} as const;

/** The full description (every route file, point lookups included): what the tests hold the handlers to. */
export const OPENAPI = openapiFor(true);

/** The description as published: without the point lookups while they are off. */
export function openapiFor(pointProfiles: boolean) {
  if (!pointProfiles) return BASE;
  return {
    ...BASE,
    info: { ...BASE.info, description: BASE.info.description + ' The point lookups /ground and /surface share the locate limit.' },
    paths: { ...BASE.paths, ...POINT_PROFILE_PATHS_SPEC },
    components: { ...BASE.components, schemas: { ...BASE.components.schemas, ...POINT_PROFILE_SCHEMAS } },
  };
}
