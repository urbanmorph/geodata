// How a map is collected (schema_doc.mode), chosen by its owner:
//   form      : people fill in the form (every map made before modes existed)
//   form_ai   : the form, plus notes a model writes from the photo
//   photos_ai : people only take photos; a model fills the form, a person checks
// A model only suggests: its notes are kept apart until a person accepts them.
import type { Field } from './validate-record';

export const COLLECT_MODES = ['form', 'form_ai', 'photos_ai'] as const;
export type CollectMode = (typeof COLLECT_MODES)[number];

export const MAX_PHOTOS = 3;

export function modeOf(schema: { mode?: unknown }): CollectMode {
  return COLLECT_MODES.includes(schema.mode as CollectMode) ? (schema.mode as CollectMode) : 'form';
}

export const usesAi = (mode: CollectMode): boolean => mode !== 'form';

/** A photo shows where it was taken, not a route or a boundary. */
export function photosOnlyAllowed(geometry: readonly string[]): boolean {
  return geometry.length === 1 && geometry[0] === 'point';
}

export const photoFields = (fields: Field[]): Field[] => fields.filter((f) => f.type === 'photo' && !f.deleted);

/** What a model may answer from a photo: choices and short text. Never numbers
 *  (a guessed measurement isn't reliable), dates, links or long text. */
export const aiFillable = (f: Field): boolean =>
  !f.deleted && (f.type === 'select' || f.type === 'multiselect' || f.type === 'text');

/** Why a mode can't be used with this form, or null when it can. */
export function modeProblem(mode: CollectMode, geometry: readonly string[], fields: Field[]): string | null {
  if (!usesAi(mode)) return null;
  if (!photoFields(fields).length) return 'AI notes need a Photo question in the form';
  if (mode === 'photos_ai' && !photosOnlyAllowed(geometry)) return 'Just photos is for places only (a photo shows where it was taken, not a route or an area)';
  return null;
}
