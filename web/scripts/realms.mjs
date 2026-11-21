// /layers groups its themes under three realms: below ground, on the ground,
// in the air. Site organisation only: a layer's category (the API and MCP use
// it) is unchanged. realms.json is the one source: the realms in page order,
// a default realm per category, and the layers that sit elsewhere. Community
// layers take their category's default.
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('./realms.json', import.meta.url), 'utf8'));

/** [{ id, name, desc }] in page order. */
export const REALMS = DATA.realms;

/** Every override as [layer id, realm] (a list, so a repeated id stays visible to tests). */
export const realmOverrides = () => Object.entries(DATA.layers).flatMap(([realm, ids]) => ids.map((id) => [id, realm]));

const OVERRIDE = new Map(realmOverrides());

/** The realm a layer (or community submission) sits in. */
export const realmOf = ({ id, category }) => OVERRIDE.get(id) ?? DATA.categories[category] ?? 'ground';
