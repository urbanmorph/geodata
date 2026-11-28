export declare const REQUEST_URL: string;
export declare function requestLayerUrl(q: string | null | undefined): string;
export type RequestedLayer = { id?: string; name?: string; licence?: string; non_commercial?: boolean; requested_by?: { name?: string; line?: string; url?: string; logo?: string } | null };
export declare function requestedBy(layer: RequestedLayer | null | undefined): { name: string; line: string; url: string; logo: string } | null;
export declare function requestedByTagHtml(layer: RequestedLayer | null | undefined): string;
export declare function requestedByAboutHtml(layer: RequestedLayer | null | undefined): string;
export declare function requestedLayersThatAreNonCommercial(layers: RequestedLayer[] | null | undefined): string[];
export declare function requestedStripHtml(layers: RequestedLayer[] | null | undefined, labelOf?: (l: RequestedLayer) => string): string;
export declare function requestedFirst(levels: string[], byLevel: Record<string, RequestedLayer[]>): string[];
