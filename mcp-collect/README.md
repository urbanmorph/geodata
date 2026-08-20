# collect-mcp (DEPRECATED — folded into bharatlas-mcp v1.1.0)

> **This package is retired.** Its authoring tools now live in the main
> [`bharatlas-mcp`](../mcp) server (v1.1.0+), which drives both the read-only
> catalog and collect authoring in one server. Create maps online at
> collect.bharatlas.com, then `register_map` a share link — the link's token
> scope (view / collect / admin) sets what you can do. This directory is kept
> only for reference and should be removed.

MCP server for [collect.bharatlas.com](https://collect.bharatlas.com) — the crowd
map-capture tool in the bharatlas suite. **Author-side only**: design a map form,
review contributions, edit settings, and publish to the bharatlas catalog.

It is deliberately **not** a bulk-contribution surface — human field contributors
are the source of truth. Bulk-from-existing-data is `import_records`, which
requires a named source and a rights confirmation, and lands each row with that
source as provenance.

## Setup

```jsonc
// claude_desktop_config.json (or your MCP client)
{
  "mcpServers": {
    "collect": {
      "command": "npx",
      "args": ["-y", "collect-mcp"],
      "env": {
        "COLLECT_API_KEY": "cak_…"          // required to create maps (see below)
        // "COLLECT_API": "https://collect.bharatlas.com/api/collect/v1",  // default
        // "COLLECT_MCP_STORE": "~/.collect-mcp.json"                       // admin-token store
      }
    }
  }
}
```

### The API key

Creating maps programmatically bypasses the browser's Turnstile, so it is gated
by an **API key** (the programmatic-abuse gate). Keys are minted out-of-band by a
maintainer and rate-limited per key:

```
python3 scripts/mint_collect_api_key.py --label "mcp: you" --daily 50 --remote
```

The key is shown **once** and stored hash-only. Put it in `COLLECT_API_KEY`.

### The credential store

`create_collection` stores the returned **admin token** (keyed by collection id)
in `COLLECT_MCP_STORE`, so later `moderate`/`publish`/`edit` calls find it without
re-supplying the admin link. No accounts — the link is the credential.

## Tools

| tool | what it does |
|---|---|
| `create_collection` | design a map (name, purpose, geometry, fields) → share links; needs the API key |
| `list_my_collections` | maps created through this MCP (local store) |
| `get_collection` | a map's metadata + counts |
| `edit_collection` | fix name / description / category / data year / basemap (licence only with no records) |
| `list_records` | records as a GeoJSON FeatureCollection (status-filterable) |
| `moderate_record` | approve / reject one pending record |
| `import_records` | bulk-import data you hold, with a source + rights confirmation |
| `publish` | bake approved records into a bharatlas catalogue submission |

The field schema is validated server-side against the public meta-schema at
`collect.bharatlas.com/schema/v1.json` — the same contract the web builder uses.

Once published, the map is discoverable through the read-only **bharatlas MCP**
(`list_submissions`, `query_layer`, `locate`). MIT licensed.
