# bharatlas plugin for Claude Code

Wraps the [bharatlas-mcp](https://www.npmjs.com/package/bharatlas-mcp) server as a Claude Code plugin, so Claude can query India's open geo data and author your own maps without you touching an API.

## What it does

Adds 17 MCP tools in two halves:

**Read (no auth):** query curated geo layers (state to village boundaries, city wards, forests, wildlife, rivers, reservoirs, hospitals, highways, airports, floods, seismic and eco zones, pincodes) and community submissions; locate any lat/lng across all admin levels and zones; find nearby features; download in Parquet, PMTiles, GeoJSON, KML or Shapefile.

**Author (collect):** create a map online at collect.bharatlas.com, register its share link here, then review contributions and publish approved points into the bharatlas catalog. What you can do is set by the link scope (view / collect / admin).

Claude calls the tools automatically when you ask things like:

- "how many villages are in Bengaluru Urban district?"
- "what state, district and seismic zone is this coordinate in?"
- "reservoirs within 50 km of Mysuru"
- "download the Karnataka wards layer as GeoJSON"
- "register my collect admin link and publish the approved points"

## Install

```
/plugin marketplace add urbanmorph/geodata
/plugin install bharatlas@bharatlas
```

Then restart Claude Code (or `/reload-plugins`).

## Updates

The MCP version is pinned in this plugin's `.mcp.json` (`bharatlas-mcp@<version>`). When the plugin auto-updates from the marketplace, the pin moves with it, so `npx` fetches the exact new version rather than reusing a stale cached "latest". No manual `npx cache clean` needed.

## Authoring notes

- New maps are created **online** at [collect.bharatlas.com](https://collect.bharatlas.com) (no account, no key). This plugin manages maps you already made, via `register_map`.
- The share link is the credential; the server can only act on maps you register a link for. Admin actions (moderate, edit, import, publish) need the admin link.
- Published maps become community submissions, queryable through this same plugin's read tools.

## Links

- npm: https://www.npmjs.com/package/bharatlas-mcp
- Docs: https://bharatlas.com/docs
- MCP page: https://bharatlas.com/mcp
- Source: https://github.com/urbanmorph/geodata

MIT licensed.
