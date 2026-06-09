# How bharatlas follows PDGI

[bharatlas](https://bharatlas.com) is built on the principles of [People's Digital Goods and Infrastructure (PDGI)](https://pdgi.org/blog/peoples-digital-goods-and-infrastructure/): people before digital, rights-centric, commons-oriented, transparent.

This is a public scorecard of how those principles are actually implemented, with links to the evidence and notes on where we fall short.

Status key: ✅ implemented · 🟡 partial · ⛳ gap, with intended direction.

## Scorecard

### People before digital (rights and collective identity) — ✅
We render upstream data unedited and never editorialize; disputes about the data belong with the source, not with us. Every layer and community submission carries its source, licence and vintage. Contributors own their data via a token and can edit or delete it at any time.
Evidence: [/terms#liability](https://bharatlas.com/terms#liability), per-card attribution, the anonymous submit and owner-token flow.

### Transparency and accountability — ✅
Open source (MIT), open repository, an open REST API with no key, a public single-source catalog, source and fetch-date on every layer, and this scorecard itself. Public disputes about rights or metadata go to GitHub issues, so the governance is an open, version-controlled record.
Evidence: this repository, [/docs](https://bharatlas.com/docs), `catalog.json`, this file's git history.

### Decentralisation and no lock-in — ✅
No account, no signup. Every layer downloads in full as open formats (Parquet, PMTiles, GeoJSON, KML, Shapefile), so nothing is trapped in the platform. The static architecture is self-hostable and forkable.
Evidence: per-card downloads, the [MIT licence](./LICENSE), open formats.

### Free software and the digital commons — ✅
MIT code. Open data under open licences only: the submission form rejects proprietary or "all rights reserved" content at the door. Curated layers carry CC0, CC-BY or GODL-India.
Evidence: [LICENSE](./LICENSE), the open-licence allowlist in the submit flow.

### Privacy — ✅
No third-party analytics, no tracking, no ad tech; first-party metrics only. Contribution is anonymous: no account, no email, no personal data collected.
Evidence: [/about](https://bharatlas.com/about) ("no tracking, no third-party analytics"), the anonymous token flow.

### Platform cooperativism — ✅
Anyone can publish open geo data here for free and anonymously. Community layers are permanent and credited to the contributor, on their terms.
Evidence: the submit flow, community cards, contributor attribution.

### Humans in the loop (AI does not cut people out) — 🟡
The MCP server and REST API expose data to AI agents with their source and licence, and the published-page provenance lets answers trace back to the origin. But the machine-readable rights signals that make this enforceable (attribution that travels with the data, an honor-the-terms norm for agents) are not shipped yet.
Direction: add schema.org `creditText`, `conditionsOfAccess` and `usageInfo` to the view-page structured data, one line in the MCP instructions, and a usage stanza in `robots.txt`. A small change that closes this gap.

### A non-digital alternative must exist — 🟡
Every layer is downloadable as files you can use offline and print, and view pages are plain HTML readable without JavaScript. But bharatlas is a data tool, not a citizen-facing service, so the true non-digital fallback for an end-need (for example, "which ward am I in") is the government office, not us.
Direction: keep offering printable and exportable artifacts as the bridge, and never make a data path digital-only.

### Grassroots and reaching the divide-affected — ⛳
Today's audience is English- and GIS-literate. Vernacular access is not built.
Direction: not classic interface translation (the authoritative data is English-transliteration, and translating place names ourselves would breach faithful presentation), but conversational access: let the AI layer take a question in any Indian language, query the canonical data, and answer in that language.

### Algorithmic fairness — mostly not applicable
bharatlas runs no algorithm that makes decisions about people; it is a catalog. The one place it touches AI is access (the MCP), covered by the "humans in the loop" row above.

## Fork this

Want to show your project follows PDGI? Map each principle to the concrete thing you do, link the evidence, and mark the gaps honestly. Copy this file as a template and keep it in your repo, where its git history becomes the record of your work.

Built by [Urban Morph](https://urbanmorph.com). PDGI framework: [pdgi.org](https://pdgi.org/).
