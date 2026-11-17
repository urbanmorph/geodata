export declare const LICENCE_URLS: Readonly<Record<string, string>>;
export declare function licenceUrl(id: string | null | undefined): string | undefined;
export declare function isNonCommercial(id: string | null | undefined): boolean;
export declare const NC_LABEL: string;
export declare const NC_NOTICE: string;
export declare function layerIsNonCommercial(layer: { licence?: string | null; non_commercial?: boolean } | null | undefined): boolean;
export declare function licenceBadgeHtml(licence: string, nonCommercial?: boolean): string;
