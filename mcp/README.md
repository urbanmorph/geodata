# bharatlas-mcp

[![npm](https://img.shields.io/npm/v/bharatlas-mcp)](https://www.npmjs.com/package/bharatlas-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Ask questions about India's geo data in natural language. This MCP server connects any LLM to bharatlas: open-licensed layers covering admin boundaries (state to village), city wards, forests, wildlife sanctuaries, rivers, canals, reservoirs, dams, groundwater (aquifers, extraction), eco-sensitive zones, agro-climatic and biogeographic zones, seismic zones, flood history, highways, airports, health facilities, pincodes, electoral constituencies, and community submissions.

## Install

No install needed for the eight read tools: they also run hosted at `https://bharatlas.com/mcp` (Streamable HTTP, read-only), e.g. `claude mcp add --transport http bharatlas https://bharatlas.com/mcp`. Install this package for all 17 tools, including collect authoring.

Add to your MCP client config:

```json
{
  "mcpServers": {
    "bharatlas": {
      "command": "npx",
      "args": ["-y", "bharatlas-mcp@latest"]
    }
  }
}
```

**Where to put it:**

| Client | Config file |
|--------|------------|
| Claude Code | `.mcp.json` (project root) or `~/.claude.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `.vscode/mcp.json` |

## Tools

| Tool | What it does |
|------|-------------|
| **list_layers** | Discover layers by category, realm (below, ground, air), level, source, or text search |
| **get_layer_schema** | Column names, types, distinct values. Call before querying. |
| **query_layer** | Select any column; filter (exact, case-insensitive) and group_by on flat columns, with per-group sums of numeric columns. Runtime parquet reads. |
| **locate** | Point-in-polygon: what state, district, ward, zone is this point in? |
| **nearby** | Find features within a radius. Works for points, polygons, and lines: lines and polygons are measured to the nearest part of their shape. |
| **get_layer_detail** | Download URLs for the formats a layer has (parquet and pmtiles always; geojson, kml and shapefile for most), its attribution, licence and dated versions to cite |
| **list_categories** | Browse categories with layer counts |
| **list_submissions** | Community-contributed layers under open licenses |

### Point profiles (built, switched off until their release)

| Tool | What it does |
|------|-------------|
| **ground_at** | What is below a point, in one call: seismic zone (BIS 2016), faults, lineaments and recorded earthquakes; rock and landform; coal, hydrocarbon and mineral blocks; aquifer, groundwater extraction, a permeability class (GLHYMPS, global and coarse) and nearby wells and samples; soil at three depths (ISRIC SoilGrids 2.0, 250 m) and the nearest Soil Health Card; subsidence in five megacities; tunnels and buried utilities |
| **surface_at** | What is on the ground at a point, in one call: admin units, ward and pincode; land cover (ESA WorldCover), elevation and slope (Copernicus DEM) and population (WorldPop 2020); climate zones; basin, nearest river, water body, dam and wetland, flood history; hazards; forests and protected areas; nearest highway, station, airport and bus stop; nearest hospital and school; power lines and plants. For the air above, it points to mugilu's `conditions_at` |

Both take `sections` and `layers` (arrays, or comma-separated strings) to read only part of the answer: `sections: ["seismic"]` for the seismic zone, `sections: ["place"]` for the ward, `layers: ["ir_stations", "dem"]` for the nearest station and the elevation. One section answers in about 0.1 to 0.3 s; everything in up to 2 s. `list_layers` and `get_layer_detail` say each layer's `realm` (below, ground or air; `list_layers` filters by it) and, for a layer a lookup reads, its `lookups` (the section that reads it).

Each part of the answer names its source, licence, scale and year (or "not dated by the source", with the date bharatlas fetched it), and says `found`, `none_within_radius` or `not_covered` (the layer does not reach the point). Non-commercial layers carry `non_commercial: true` and their licence notice; `open_only: true` leaves them out. Both answers carry a disclaimer: screening information, not for site, engineering or legal decisions. These tools are offered only once the lookups are published (`BHARATLAS_POINT_PROFILES=on` turns them on in this package before then).

List arguments (`select` and `sum` on `query_layer`, `layers` on `locate`) take an array of strings or one comma-separated string: `["dtname", "dist_lgd"]` or `"dtname,dist_lgd"`. `where` takes an object, `{"stname": "KERALA", "type": "PHC"}`, or a string, `"stname=KERALA, type=PHC"`. An argument of the wrong shape, or a column the layer does not have, comes back as an error that names it (with the layer's columns), so the model can correct itself.

## What you can ask

**Counting and filtering**
- "How many national parks vs wildlife sanctuaries?" (101 vs 560)
- "How many villages in Bengaluru Urban district?" (949)
- "How many health facilities in Bihar?" (8,363: 3,232 sub-centres, 591 PHCs, 74 CHCs)
- "How many wards does Chennai have vs Pune?" (200 vs 58)

**Spatial**
- "What state, district, seismic zone is Bengaluru in?" (Karnataka, Bengaluru Urban, Zone II)
- "Reservoirs within 50km of Bengaluru?" (12 found)
- "Wildlife sanctuaries near Mysuru?" (Ranganathittu 15km, Nagarahole NP 60km)

**Cross-layer**
- "Which airports in Karnataka are near water bodies?" (Hubballi: Unkal Lake 2.3km, 14 rivers)
- "Which blocks are in district 571?" (10 blocks: Kunigal, Tumakuru, Gubbi...)
- "Which villages in Madhya Pradesh are in eco-sensitive zones?" (narrows by district, then locates)

## How it works

Thin wrapper over the [bharatlas REST API](https://bharatlas.com/docs). Each tool call becomes one or more API requests to Cloudflare Workers that read parquet files and PMTiles directly from R2 at runtime. No pre-computation, no API key, no auth. We count MCP calls per layer, and keep nothing about the caller.

The server sends instructions to the LLM at connection time that teach:
- **Schema-first pattern**: check column names and sample values before querying (column names vary: `state` vs `State_LGD` vs `stname`)
- **Source preference**: LGD for admin boundaries, with SOI/Bhuvan/geoBoundaries as alternates
- **Concept-to-layer mapping**: "water bodies" = rivers + canals + reservoirs + wetlands + ramsar sites + dams; "groundwater" = aquifers + extraction stage + wells (minor irrigation census); "places/shops/ATMs" = Overture places
- **Spatial join workflow**: locate for context, query for data, nearby for proximity

## Links

- [bharatlas.com](https://bharatlas.com): the atlas
- [REST API docs](https://bharatlas.com/docs)
- [MCP setup guide](https://bharatlas.com/mcp): install and example questions
- [GitHub](https://github.com/urbanmorph/geodata): source code
- [npm](https://www.npmjs.com/package/bharatlas-mcp): this package

## License

MIT. Data: each layer carries its own open license (CC0, CC-BY, CC-BY-SA, ODbL, GODL-India, MIT, CDLA-Permissive), named in `get_layer_detail`; credit its source when you use it.
