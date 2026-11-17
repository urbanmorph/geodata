export interface ChoroplethSpec {
  column: string;
  label: string;
  unit: string;
  breaks: number[];
}
// MapLibre expressions are plain JSON arrays.
type Expr = unknown[];
export declare const CHOROPLETH_RAMP: readonly string[];
export declare const NO_DATA_HATCH: string;
export declare function rampFor(n: number): string[];
export declare function fmtLegendNumber(n: number): string;
export declare function fillColorExpr(spec: Pick<ChoroplethSpec, 'column' | 'breaks'>): Expr;
export declare function noDataFilter(spec: Pick<ChoroplethSpec, 'column'>): Expr;
export declare function combineFilters<T>(base: T | null | undefined, user: T | null | undefined): T | ['all', T, T] | null;
export declare function legendHtml(spec: ChoroplethSpec, unitNoun?: string): string;
export declare function hatchPixels(size?: number): { width: number; height: number; data: Uint8Array };
