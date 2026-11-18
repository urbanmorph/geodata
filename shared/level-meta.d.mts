export type LevelMeta = {
  label: string;
  unit?: string;
  description?: string;
  /** SEO-tuned <title>/<h1>, overrides the short display `label` on the /view page only. */
  seo_title?: string;
  /** Snippet text (<= 158 chars) for the /view meta description, overriding `description`. */
  seo_description?: string;
};
export declare const LEVEL_META: Readonly<Record<string, LevelMeta>>;
