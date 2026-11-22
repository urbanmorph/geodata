type Org = Readonly<{ '@type': 'Organization'; name: string; url: string }>;
export declare const SITE_ORIGIN: string;
export declare const PUBLISHER_LD: Readonly<Org & { parentOrganization: Org }>;
export declare const PALETTE: Readonly<{
  saffron: string;
  saffronHover: string;
  saffronLight: string;
  green: string;
  greenText: string;
  navy: string;
  navyLink: string;
  white: string;
}>;
type Tokens = Readonly<Record<
  '--fg' | '--brand-ink' | '--accent' | '--accent-strong' | '--accent-fill' | '--accent-fill-hover' | '--on-accent-fill' | '--brand-green',
  string
>>;
export declare const THEME: Readonly<{ light: Tokens; dark: Tokens }>;
export declare function themeDecls(mode: 'light' | 'dark'): string;
export declare function brandMarkSvg(size?: number): string;
export declare function faviconSvg(): string;
export declare function collectFaviconSvg(): string;
export declare function wordmarkHtml(opts?: { href?: string; tagline?: string; className?: string; size?: number }): string;
export declare const WORDMARK_CSS: string;
