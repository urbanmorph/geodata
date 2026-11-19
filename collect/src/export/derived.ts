// The columns collect adds to a point, the same in the published layer
// (functions/lib/handlers.ts publish) and in the owner's downloads (formats.ts):
// notes a person accepted from the photo, an area's size, and when it was added.
import { ringArea } from '../geo/measure';

export const DERIVED_COLUMNS = ['photo_description', 'photo_tags', 'photo_notes_model', 'area_sq_m'] as const;

type Notes = { description?: string; tags?: string[]; model?: string } | null | undefined;

/** Accepted notes from the photo as columns; nothing without notes. */
export function noteColumns(n: Notes): Record<string, unknown> {
  if (!n) return {};
  return { photo_description: n.description ?? '', photo_tags: (n.tags ?? []).join(' | '), photo_notes_model: n.model ?? '' };
}

/** An area's size in square metres; nothing for a point or a line. */
export function areaColumn(geometry: { type?: string; coordinates?: unknown } | null | undefined): Record<string, unknown> {
  return geometry?.type === 'Polygon'
    ? { area_sq_m: Math.round(ringArea((geometry.coordinates as [number, number][][])[0])) }
    : {};
}

/** When the point was added: the phone's capture time, else when it was saved. */
export const addedAt = (capturedAt: unknown, createdAt: unknown): string => String(capturedAt ?? createdAt ?? '');
