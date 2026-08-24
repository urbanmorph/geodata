// The Phase-2 schema builder: add fields from the 7 types, set required +
// type-specific config (options/chips for choices, whole-numbers for number),
// reorder, remove, and EDIT an existing field inline (click its name → the same
// config form opens directly under that row). Generates schema_doc.fields; keys
// derive from labels for new fields and stay stable across an edit.
import { deriveKey } from './schema/derive-key';
import { escapeHtml } from './util';

export interface BuilderField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  hint?: string;
  options?: string[];
  integer?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  render?: 'chips';
}

const TYPES: [string, string][] = [
  ['text', 'Text'],
  ['paragraph', 'Long text'],
  ['number', 'Number'],
  ['select', 'Choice (pick one)'],
  ['multiselect', 'Choice (pick many)'],
  ['date', 'Date'],
  ['url', 'Link (URL)'],
];
const MAX_FIELDS = 20;
const needsOptions = (t: string) => t === 'select' || t === 'multiselect';
const typeLabel = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;

interface FieldForm {
  read(): { field: BuilderField } | { error: string };
  focus(): void;
  setError(msg: string): void;
}

// The reusable field-config form (label / type / required / hint / type-extra).
// One instance backs the persistent "add" card; another is mounted inline under
// a row when editing. Everything is class-scoped to `host`, so instances never
// collide. `initial` prefills it for editing.
function createFieldForm(host: HTMLElement, initial: BuilderField | null): FieldForm {
  host.innerHTML = `
    <input class="ff-label" placeholder="Field label, e.g. Condition" />
    <div class="row" style="margin-top:6px">
      <select class="ff-type" style="flex:1">${TYPES.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select>
      <label class="chip" style="gap:6px"><input type="checkbox" class="ff-req" style="width:auto;min-height:auto" /> Required</label>
    </div>
    <input class="ff-hint" placeholder="Help text (optional), shown under the field" style="margin-top:6px" />
    <div class="ff-extra"></div>
    <p class="ff-err warn"></p>`;

  const $ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const labelEl = $<HTMLInputElement>('.ff-label');
  const typeEl = $<HTMLSelectElement>('.ff-type');
  const reqEl = $<HTMLInputElement>('.ff-req');
  const hintEl = $<HTMLInputElement>('.ff-hint');
  const extraEl = $<HTMLElement>('.ff-extra');
  const errEl = $<HTMLElement>('.ff-err');

  function renderExtra(): void {
    const t = typeEl.value;
    if (needsOptions(t)) {
      extraEl.innerHTML = `<label>Options <span class="hint">(one per line)</span></label>
        <textarea class="ff-opts" placeholder="Good&#10;Needs repair&#10;Unusable"></textarea>
        <label class="chip" style="gap:6px;margin-top:6px"><input type="checkbox" class="ff-chips" style="width:auto;min-height:auto" /> Show as chips</label>`;
    } else if (t === 'number') {
      extraEl.innerHTML = `<div class="row" style="margin-top:6px">
          <input class="ff-min" inputmode="decimal" placeholder="Min" style="flex:1" />
          <input class="ff-max" inputmode="decimal" placeholder="Max" style="flex:1" />
        </div>
        <label class="chip" style="gap:6px;margin-top:6px"><input type="checkbox" class="ff-int" style="width:auto;min-height:auto" /> Whole numbers only</label>`;
    } else if (t === 'text' || t === 'paragraph') {
      extraEl.innerHTML = `<label>Max length <span class="hint">(optional)</span></label>
        <input class="ff-maxlen" inputmode="numeric" placeholder="e.g. 200" />`;
    } else {
      extraEl.innerHTML = '';
    }
  }
  typeEl.onchange = renderExtra;

  if (initial) {
    labelEl.value = initial.label;
    typeEl.value = initial.type;
    reqEl.checked = !!initial.required;
    hintEl.value = initial.hint || '';
  }
  renderExtra();
  if (initial) {
    if (needsOptions(initial.type)) {
      const o = host.querySelector<HTMLTextAreaElement>('.ff-opts'); if (o) o.value = (initial.options || []).join('\n');
      const c = host.querySelector<HTMLInputElement>('.ff-chips'); if (c) c.checked = initial.render === 'chips';
    } else if (initial.type === 'number') {
      const mn = host.querySelector<HTMLInputElement>('.ff-min'); if (mn && initial.min != null) mn.value = String(initial.min);
      const mx = host.querySelector<HTMLInputElement>('.ff-max'); if (mx && initial.max != null) mx.value = String(initial.max);
      const it = host.querySelector<HTMLInputElement>('.ff-int'); if (it) it.checked = !!initial.integer;
    } else if (initial.type === 'text' || initial.type === 'paragraph') {
      const ml = host.querySelector<HTMLInputElement>('.ff-maxlen'); if (ml && initial.maxLength != null) ml.value = String(initial.maxLength);
    }
  }

  function read(): { field: BuilderField } | { error: string } {
    errEl.textContent = '';
    const label = labelEl.value.trim();
    if (!label) return { error: 'Give the field a label.' };
    const type = typeEl.value;
    const f: BuilderField = { key: '', label, type };
    if (reqEl.checked) f.required = true;
    const hint = hintEl.value.trim();
    if (hint) f.hint = hint;

    if (needsOptions(type)) {
      const opts = (host.querySelector<HTMLTextAreaElement>('.ff-opts')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (!opts.length) return { error: 'Add at least one option.' };
      f.options = opts;
      if (host.querySelector<HTMLInputElement>('.ff-chips')?.checked) f.render = 'chips';
    }
    if (type === 'number') {
      const min = host.querySelector<HTMLInputElement>('.ff-min')?.value.trim();
      const max = host.querySelector<HTMLInputElement>('.ff-max')?.value.trim();
      if (min && Number.isFinite(Number(min))) f.min = Number(min);
      if (max && Number.isFinite(Number(max))) f.max = Number(max);
      if (host.querySelector<HTMLInputElement>('.ff-int')?.checked) f.integer = true;
    }
    if (type === 'text' || type === 'paragraph') {
      const ml = host.querySelector<HTMLInputElement>('.ff-maxlen')?.value.trim();
      if (ml && Number.isInteger(Number(ml)) && Number(ml) > 0) f.maxLength = Number(ml);
    }
    return { field: f };
  }

  return { read, focus: () => labelEl.focus(), setError: (m) => { errEl.textContent = m; } };
}

export function mountSchemaBuilder(
  container: HTMLElement,
  initial: BuilderField[] = [],
): { getFields: () => BuilderField[] } {
  const fields: BuilderField[] = initial.slice();
  let editingIndex: number | null = null; // which row is open for inline edit

  container.innerHTML = `
    <div id="sb-list"></div>
    <div class="card" id="sb-add">
      <div class="ff-host"></div>
      <button type="button" id="sb-add-btn">+ Add field</button>
    </div>`;
  const listEl = container.querySelector<HTMLElement>('#sb-list')!;
  const addCardEl = container.querySelector<HTMLElement>('#sb-add')!;
  const addBtn = container.querySelector<HTMLButtonElement>('#sb-add-btn')!;
  let addForm = createFieldForm(container.querySelector<HTMLElement>('#sb-add .ff-host')!, null);

  addBtn.onclick = () => {
    if (fields.length >= MAX_FIELDS) { addForm.setError(`Max ${MAX_FIELDS} fields.`); return; }
    const built = addForm.read();
    if ('error' in built) { addForm.setError(built.error); return; }
    built.field.key = deriveKey(built.field.label, fields.map((x) => x.key));
    fields.push(built.field);
    addForm = createFieldForm(container.querySelector<HTMLElement>('#sb-add .ff-host')!, null); // reset
    renderList();
  };

  function renderList(): void {
    // one form at a time: while a field is open for inline edit, hide the add card
    addCardEl.style.display = editingIndex === null ? '' : 'none';
    if (!fields.length) {
      listEl.innerHTML = '<p class="hint">No fields yet. Add at least one.</p>';
      return;
    }
    listEl.innerHTML = fields.map((f, i) => `
      <div class="link-box${editingIndex === i ? ' link-box--editing' : ''}">
        <button type="button" class="sb-name" data-edit="${i}" aria-expanded="${editingIndex === i}" aria-label="Edit field ${escapeHtml(f.label)}">${escapeHtml(f.label)}${f.required ? ' *' : ''}
          <span class="hint">${typeLabel(f.type)}${f.options ? ` · ${f.options.length} options` : ''}</span></button>
        <button data-mv="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-mv="dn" data-i="${i}" aria-label="Move down" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-rm="${i}" aria-label="Remove field">✕</button>
      </div>${editingIndex === i ? `
      <div class="card sb-edit" data-editcard="${i}">
        <div class="ff-host"></div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="sb-save primary" style="flex:1">Save field</button>
          <button type="button" class="sb-cancel">Cancel</button>
        </div>
      </div>` : ''}`).join('');

    // click a field name → open its inline editor (or close it if already open)
    listEl.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.edit);
        editingIndex = editingIndex === i ? null : i;
        renderList();
      };
    });
    // reorder / remove close any open editor first (indices would otherwise drift)
    listEl.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => {
      b.onclick = () => { fields.splice(Number(b.dataset.rm), 1); editingIndex = null; renderList(); };
    });
    listEl.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const j = b.dataset.mv === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= fields.length) return;
        [fields[i], fields[j]] = [fields[j], fields[i]];
        editingIndex = null;
        renderList();
      };
    });

    // mount the inline edit form under the open row
    if (editingIndex !== null) {
      const i = editingIndex;
      const card = listEl.querySelector<HTMLElement>(`[data-editcard="${i}"]`);
      if (card) {
        const editForm = createFieldForm(card.querySelector<HTMLElement>('.ff-host')!, fields[i]);
        editForm.focus();
        (card.querySelector('.sb-save') as HTMLButtonElement).onclick = () => {
          const built = editForm.read();
          if ('error' in built) { editForm.setError(built.error); return; }
          built.field.key = fields[i].key; // keep the key stable across an edit
          fields[i] = built.field;
          editingIndex = null;
          renderList();
        };
        (card.querySelector('.sb-cancel') as HTMLButtonElement).onclick = () => { editingIndex = null; renderList(); };
      }
    }
  }

  renderList();
  return { getFields: () => fields.slice() };
}
