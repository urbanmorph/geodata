// Which point lookup reads a layer, and in which section: from the lookups' own
// tables (GROUND_PROFILE, SURFACE_PROFILE, their rasters and the ward layers
// /surface adds), so the layer listings never drift from what the lookups read.
import { GROUND_PROFILE } from './ground';
import { SURFACE_PROFILE } from './surface';
import type { ProfileSpec } from './profile';
import { openapiFor, type LookupDoc, type LookupGuide } from './openapi';

export const LOOKUPS = { ground: GROUND_PROFILE, surface: SURFACE_PROFILE } as const satisfies Record<string, ProfileSpec>;
export type LookupName = keyof typeof LOOKUPS;

/** Lookup name to section, for a layer some lookup reads. */
export type LayerLookups = Partial<Record<LookupName, string>>;

function sectionsById(spec: ProfileSpec): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of spec.layers) if (!m.has(l.id)) m.set(l.id, l.section);
  for (const id of spec.expandable?.ids ?? []) m.set(id, spec.expandable!.section);
  return m;
}

const BY_LOOKUP = Object.entries(LOOKUPS).map(([name, spec]) => [name as LookupName, sectionsById(spec)] as const);

/** { ground: section, surface: section } for the lookups that read this layer, or undefined. */
export function lookupsOf(layerId: string): LayerLookups | undefined {
  const out: LayerLookups = {};
  for (const [name, m] of BY_LOOKUP) {
    const s = m.get(layerId);
    if (s) out[name] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A listed layer with its lookups added (when some lookup reads it). */
export function withLookups<T extends { id: string }>(layer: T): T & { lookups?: LayerLookups } {
  const lookups = lookupsOf(layer.id);
  return lookups ? { ...layer, lookups } : layer;
}

/** A lookup's sections and the layers each reads (rasters marked), for the API description. */
function lookupDoc(spec: ProfileSpec): LookupDoc {
  const bySection = spec.sections.map((s) => {
    const names = [
      ...spec.pixels.filter((p) => p.section === s).map((p) => `${p.id} (raster)`),
      ...new Set(spec.layers.filter((l) => l.section === s).map((l) => l.id)),
      ...(spec.expandable?.section === s ? ['the ward layer covering the point'] : []),
    ];
    return `${s}: ${names.join(', ')}`;
  }).join('; ');
  return { sections: spec.sections, bySection, wards: !!spec.expandable };
}

export const LOOKUP_GUIDE: LookupGuide = { ground: lookupDoc(GROUND_PROFILE), surface: lookupDoc(SURFACE_PROFILE) };

/** The API description as served (/api/v1/openapi.json), lookup filters included while the lookups are on. */
export const describeApi = (pointProfiles: boolean) => openapiFor(pointProfiles, LOOKUP_GUIDE);

/** The full description (every route file, point lookups and their filters included): what the tests hold the handlers to. */
export const OPENAPI = describeApi(true);
