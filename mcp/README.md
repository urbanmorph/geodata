# bharatlas-mcp

[![npm](https://img.shields.io/npm/v/bharatlas-mcp)](https://www.npmjs.com/package/bharatlas-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Ask questions about India's geo data in natural language. This MCP server connects any LLM to bharatlas: open-licensed layers covering admin boundaries (state to village), city wards, forests, wildlife sanctuaries, rivers, canals, reservoirs, dams, groundwater (aquifers, extraction), eco-sensitive zones, agro-climatic and biogeographic zones, seismic zones, flood history, highways, airports, health facilities, pincodes, electoral constituencies, and community submissions.

## Install

Add to your MCP client config:

```json
{
  "mcpServers": {
    "bharatlas": {
      "command": "npx",
      "args": ["-y", "bharatlas-mcp"]
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
| **list_layers** | Discover layers by category, level, source, or text search |
| **get_layer_schema** | Column names, types, distinct values. Call before querying. |
| **query_layer** | Filter, select, group_by on any column. Runtime parquet reads. |
| **locate** | Point-in-polygon: what state, district, ward, zone is this point in? |
| **nearby** | Find features within a radius. Works for points, polygons, and lines. |
| **get_layer_detail** | Download URLs in 5 formats (parquet, pmtiles, geojson, kml, shapefile) |
| **list_categories** | Browse categories with layer counts |
| **list_submissions** | Community-contributed layers under open licenses |

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

Thin wrapper over the [bharatlas REST API](https://bharatlas.com/docs). Each tool call becomes one or more API requests to Cloudflare Workers that read parquet files and PMTiles directly from R2 at runtime. No pre-computation, no API key, no auth.

The server sends instructions to the LLM at connection time that teach:
- **Schema-first pattern**: check column names and sample values before querying (column names vary: `state` vs `State_LGD` vs `stname`)
- **Source preference**: LGD for admin boundaries, with SOI/Bhuvan/geoBoundaries as alternates
- **Concept-to-layer mapping**: "water bodies" = rivers + canals + reservoirs + wetlands + ramsar sites + dams; "groundwater" = aquifers + extraction stage
- **Spatial join workflow**: locate for context, query for data, nearby for proximity

## Links

- [bharatlas.com](https://bharatlas.com) -- the atlas
- [REST API docs](https://bharatlas.com/docs)
- [MCP setup guide](https://bharatlas.com/mcp) -- install + example questions
- [GitHub](https://github.com/urbanmorph/geodata) -- source code
- [npm](https://www.npmjs.com/package/bharatlas-mcp) -- this package

## License

MIT. Data: each layer carries its own open license (CC0, CC-BY, ODbL, GODL-India).
