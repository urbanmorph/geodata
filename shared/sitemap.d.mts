export type SitemapEntry = { loc: string; lastmod?: string | null; changefreq: string; priority: string };
export declare const SITE_ORIGIN: string;
export declare const STATIC_PAGES: SitemapEntry[];
export declare function releasePages(index: { latest?: Record<string, string> } | null | undefined): SitemapEntry[];
export declare function lastmodLine(date?: string | null): string;
export declare function urlset(entries: SitemapEntry[]): string;
