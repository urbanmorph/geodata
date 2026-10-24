// The choices behind the guided "Make a new map" steps, kept apart from the
// screens: what people mark, how they collect, and the form those add up to.
import { deriveKey } from '../schema/derive-key';
import { modeProblem, type CollectMode } from '../schema/modes';
import type { BuilderField } from '../schema-builder';
import type { Field } from '../schema/validate-record';

export const MARKS = [
  { id: 'point', label: 'Places', hint: 'A spot, like a tree or a garbage heap' },
  { id: 'line', label: 'Routes', hint: 'A line, like a footpath or a drain' },
  { id: 'polygon', label: 'Areas', hint: 'A boundary, like a farm or a park' },
] as const;

export interface ModeChoice { id: CollectMode; title: string; blurb: string; disabled?: boolean; why?: string; }

const MODES: Omit<ModeChoice, 'disabled' | 'why'>[] = [
  { id: 'form', title: 'Fill in a form', blurb: 'People answer your questions. A photo only if you ask for one.' },
  { id: 'form_ai', title: 'Form, plus AI notes', blurb: 'People fill in the form and add a photo. A model then describes the photo and suggests answers for you to check. It never changes what people wrote.' },
  { id: 'photos_ai', title: 'Just photos, AI fills the form', blurb: 'People only take photos. Each becomes a point where it was taken, and a model answers your questions for you to check.' },
];

/** The three modes, with "just photos" greyed out (and why) unless only places are marked. */
export function modeChoices(geometry: readonly string[]): ModeChoice[] {
  return MODES.map((m) => {
    // Checked with a stand-in photo question: here only what people mark matters.
    const why = modeProblem(m.id, geometry, [{ key: 'p', label: 'p', type: 'photo' }]);
    return why ? { ...m, disabled: true, why } : { ...m };
  });
}

/** AI notes work from a photo: give the form a Photo question if it has none. */
export function withPhotoQuestion(fields: BuilderField[], mode: CollectMode): BuilderField[] {
  if (mode === 'form' || fields.some((f) => f.type === 'photo' && !f.deleted)) return fields;
  return [{ key: deriveKey('photo', fields.map((f) => f.key)), label: 'Photo', type: 'photo', max_photos: 3 }, ...fields];
}

export interface PlanDoc {
  geometry: string[];
  fields: BuilderField[] | Field[];
  mode: CollectMode;
  category: string;
  dataSaver?: boolean;
  reference?: { id: string; pmtiles_url: string } | null;
}

/** The form document sent at Create (a plain form carries no mode, as before). */
export function schemaDocFor(p: PlanDoc): Record<string, unknown> {
  return {
    version: 1,
    geometry: p.geometry,
    fields: p.fields,
    category: p.category,
    ...(p.mode !== 'form' ? { mode: p.mode } : {}),
    ...(p.dataSaver ? { data_saver: true } : {}),
    ...(p.reference ? { reference_layer: p.reference } : {}),
  };
}
