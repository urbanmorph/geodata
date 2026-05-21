// /robots.txt served as a Pages Function so it wins against any
// Cloudflare Managed Robots injection at the zone level. Pages Functions
// are evaluated before static assets and before zone-level rewrites — if
// this route exists, our explicit content is what crawlers see.
//
// Policy: open data atlas → all search + AI crawlers are welcome.
// See web/public/robots.txt for the static fallback (same content).

const ROBOTS = `# bharatlas is open data — search engines, AI assistants and dataset
# crawlers are all welcome. The catalog is CC0/CC-BY upstream sources;
# community submissions carry their own open licence on each card.

User-agent: *
Allow: /

User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: DuckDuckBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Perplexity-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: CCBot
Allow: /

Sitemap: https://bharatlas.com/sitemap.xml
`;

export const onRequestGet: PagesFunction = async () =>
  new Response(ROBOTS, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
