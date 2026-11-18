// A map's questions as form controls, for the add form and the record editor.
// Each control is labelled by its question (<label for>, ids from the field key,
// unique on the form); chips and photos sit in a group named the same way; a
// hint is tied to its control. The form reads answers back by data-k.
import { escapeHtml } from './util';
import type { Field } from './schema/validate-record';

const idOf = (f: Field): string => `fld-${f.key}`;

function fieldInput(f: Field, a11y: string): string {
  const k = `data-k="${f.key}" id="${idOf(f)}"${a11y}`;
  const req = f.required ? ' required' : '';
  // Numbers are checked when a form is saved; escaped here too, as these go into attributes.
  const ml = f.maxLength ? ` maxlength="${escapeHtml(f.maxLength)}"` : '';
  switch (f.type) {
    case 'paragraph': return `<textarea ${k}${req}${ml}></textarea>`;
    case 'number': return `<input ${k} inputmode="${f.integer ? 'numeric' : 'decimal'}"${f.min != null ? ` min="${escapeHtml(f.min)}"` : ''}${f.max != null ? ` max="${escapeHtml(f.max)}"` : ''} step="${f.integer ? '1' : 'any'}"${req} />`;
    case 'date': return `<input ${k} type="date"${req} />`;
    case 'datetime': return `<input ${k} type="datetime-local"${req} />`;
    case 'url': return `<input ${k} type="url"${req} placeholder="https://" />`;
    case 'photo': return `<div ${k} role="group" aria-labelledby="${idOf(f)}-label" data-photo></div>`; // mounted by mountPhotoFields
    case 'select':
      return `<select ${k}${req}><option value=""></option>${(f.options || []).map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
    case 'multiselect':
      return `<div class="row" ${k} role="group" aria-labelledby="${idOf(f)}-label" data-multi>${(f.options || []).map((o) => `<button type="button" class="chip" aria-pressed="false" data-v="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}</div>`;
    default: return `<input ${k}${req}${ml} />`;
  }
}

/** One question: its label, its hint and its control. */
function fieldHtml(f: Field): string {
  const id = idOf(f);
  const group = f.type === 'multiselect' || f.type === 'photo';
  const label = `<label id="${id}-label"${group ? '' : ` for="${id}"`}>${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>`;
  const hint = f.hint ? `<p class="hint" id="${id}-hint" style="margin:-2px 0 4px">${escapeHtml(f.hint)}</p>` : '';
  return label + hint + fieldInput(f, f.hint ? ` aria-describedby="${id}-hint"` : '');
}

export const fieldsHtml = (fields: Field[]): string => fields.map(fieldHtml).join('');

/** A toggle button's look (.on) and its state for screen readers, together. */
export function setPressed(el: Element, on: boolean): void {
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
}
