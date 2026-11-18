export type KmlFeature = { geometry: unknown; properties: Record<string, unknown> };
export declare function geometryToKML(g: unknown): string;
export declare function kmlHead(layerName: string): string;
export declare const KML_TAIL: string;
export declare function kmlPlacemarkHead(properties: Record<string, unknown> | null | undefined): string;
export declare function kmlPlacemark(f: KmlFeature): string;
export declare function featuresToKML(feats: KmlFeature[], layerName: string): string;
