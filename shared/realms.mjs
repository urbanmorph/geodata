// Layers sit in three realms: below ground, on the ground, in the air. /layers
// groups its themes under them, and the API and MCP say each layer's realm
// (and filter by it). A layer's category is unchanged. realms.json is the one
// source: the realms in page order, a default realm per category, and the
// layers that sit elsewhere. Community layers take their category's default.
import DATA from './realms.json' with { type: 'json' };

/** [{ id, name, desc }] in page order. */
export const REALMS = DATA.realms;

/** The realm ids, in page order. */
export const REALM_IDS = REALMS.map((r) => r.id);

/** Every override as [layer id, realm] (a list, so a repeated id stays visible to tests). */
export const realmOverrides = () => Object.entries(DATA.layers).flatMap(([realm, ids]) => ids.map((id) => [id, realm]));

const OVERRIDE = new Map(realmOverrides());

/** The realm a layer (or community submission) sits in. */
export const realmOf = ({ id, category }) => OVERRIDE.get(id) ?? DATA.categories[category] ?? 'ground';
