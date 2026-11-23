export interface Realm { id: string; name: string; desc: string }
export declare const REALMS: Realm[];
export declare const REALM_IDS: string[];
export declare function realmOverrides(): Array<[string, string]>;
export declare function realmOf(layer: { id: string; category?: string }): string;
