// The schema builder: add fields from the 8 types, set required + type-specific
// config (options/chips for choices, whole-numbers for number), reorder, remove,
// and EDIT an existing field inline (click its name → the same config form opens
// directly under that row). Generates schema_doc.fields; keys derive from labels
// for new fields and stay stable across an edit.
//
// Given the data (a file's columns before "Create", or the map's saved points
// after: Manage → Edit form) it checks every field against it with the same
// validator the server uses: each field says how many rows fit and why the rest
// don't, options the data uses are locked (new ones can be added), every type
// says how many rows it would refuse, and after Create existing fields are
// hidden rather than removed and types the saved points don't fit are disabled.
import { deriveKey } from './schema/derive-key';
import { escapeHtml } from './util';
import { checkField, type FieldCheck } from './import/check';
import { cellValue } from './import/build';
import type { Field } from './schema/validate-record';

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
  deleted?: boolean;
  /** Shown while building only (e.g. why a column was read as text); never saved. */
  note?: string;
}

export interface BuilderData {
  /** What one item is called: 'row' (a file) or 'point' (a map). */
  noun: string;
  /** The value of this field in every item (blank where there is none). */
  values: (f: BuilderField) => unknown[];
}

export interface BuilderOptions {
  data?: BuilderData;
  /** After Create: the initial fields have saved points, so they are hidden, not removed. */
  existing?: boolean;
  onChange?: (fields: BuilderField[]) => void;
}

const TYPES: [string, string][] = [
  ['text', 'Text'],
  ['paragraph', 'Long text'],
  ['number', 'Number'],
  ['select', 'Choice (pick one)'],
  ['multiselect', 'Choice (pick many)'],
  ['date', 'Date'],
  ['datetime', 'Date and time'],
  ['url', 'Link (URL)'],
];
const needsOptions = (t: string) => t === 'select' || t === 'multiselect';
const typeLabel = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The distinct values in the data, as options for a choice of this type. */
function dataOptions(data: BuilderData, f: BuilderField, type: string): string[] {
  const probe = { ...f, type } as Field;
  const seen = new Set<string>();
  for (const raw of data.values(f)) {
    for (const v of [cellValue(probe, raw).value].flat()) {
      const s = v == null ? '' : String(v).trim();
      if (s) seen.add(s);
    }
  }
  return [...seen];
}

const check = (data: BuilderData, f: BuilderField): FieldCheck => checkField(f as Field, data.values(f));

/** "✓ all 88 rows fit" / "⚠ 3 of 88 rows won't fit: … (2); … (1)" (+ what is lost). */
function checkLine(c: FieldCheck, noun: string): string {
  const bad = c.total - c.fit;
  const reasons = (rs: { reason: string; count: number }[]) => rs.slice(0, 3).map((r) => `${escapeHtml(r.reason)} (${r.count})`).join('; ');
  const parts = [
    c.filled === 0 ? `<span class="hint">empty in all ${plural(c.total, noun)}</span>`
      : bad ? `<span class="warn">⚠ ${bad} of ${plural(c.total, noun)} won't fit: ${reasons(c.problems)}</span>`
      : `<span class="ok">✓ all ${plural(c.total, noun)} fit</span>`,
  ];
  if (c.warnings.length) parts.push(`<span class="warn">${reasons(c.warnings)}</span>`);
  return parts.join(' · ');
}

interface FieldForm {
  read(): { field: BuilderField } | { error: string };
  focus(): void;
  setError(msg: string): void;
}

// The reusable field-config form (label / type / required / hint / type-extra).
// One instance backs the persistent "add" card; another is mounted inline under
// a row when editing. Everything is class-scoped to `host`, so instances never
// collide. `initial` prefills it for editing; `data` makes it check as you go;
// `saved` means the field already has saved points (its type is locked to ones
// they fit).
function createFieldForm(host: HTMLElement, initial: BuilderField | null, data?: BuilderData, saved = false): FieldForm {
  host.innerHTML = `
    <input class="ff-label" placeholder="Field label, e.g. Condition" />
    <div class="row" style="margin-top:6px">
      <select class="ff-type" style="flex:1">${TYPES.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select>
      <label class="chip" style="gap:6px"><input type="checkbox" class="ff-req" style="width:auto;min-height:auto" /> Required</label>
    </div>
    <input class="ff-hint" placeholder="Help text (optional), shown under the field" style="margin-top:6px" />
    <div class="ff-extra"></div>
    <p class="ff-check hint"></p>
    <p class="ff-err warn"></p>`;

  const $ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const labelEl = $<HTMLInputElement>('.ff-label');
  const typeEl = $<HTMLSelectElement>('.ff-type');
  const reqEl = $<HTMLInputElement>('.ff-req');
  const hintEl = $<HTMLInputElement>('.ff-hint');
  const extraEl = $<HTMLElement>('.ff-extra');
  const checkEl = $<HTMLElement>('.ff-check');
  const errEl = $<HTMLElement>('.ff-err');
  // Checked against the data only when editing an existing field.
  const live = data && initial ? data : undefined;
  let opts: string[] = initial?.options?.slice() ?? []; // the kept options (data mode)

  function renderExtra(): void {
    const t = typeEl.value;
    if (needsOptions(t) && live) {
      const c = check(live, { ...initial!, type: t, options: opts });
      const missing = dataOptions(live, initial!, t).filter((o) => !opts.includes(o));
      extraEl.innerHTML = `<label>Options <span class="hint">(ones the data uses are locked)</span></label>
        <div class="row opt-chips">${opts.map((o) => {
          const used = c.uses[o] ?? 0;
          return `<span class="chip opt-chip" data-opt="${escapeHtml(o)}">${escapeHtml(o)} <span class="hint">${used}</span>${used ? '' : ` <button type="button" data-rmopt="${escapeHtml(o)}" aria-label="Remove ${escapeHtml(o)}">✕</button>`}</span>`;
        }).join('')}</div>
        ${missing.length ? `<p class="hint" style="margin:6px 0 2px">Also in the data:</p><div class="row">${missing.map((o) => `<button type="button" class="chip" data-addopt="${escapeHtml(o)}">+ ${escapeHtml(o)} <span class="hint">${c.uses[o] ?? 0}</span></button>`).join('')}</div>` : ''}
        <label>Add options <span class="hint">(one per line)</span></label>
        <textarea class="ff-opts" placeholder="Another option"></textarea>
        <label class="chip" style="gap:6px;margin-top:6px"><input type="checkbox" class="ff-chips" style="width:auto;min-height:auto"${initial?.render === 'chips' ? ' checked' : ''} /> Show as chips</label>`;
      extraEl.querySelectorAll<HTMLButtonElement>('[data-rmopt]').forEach((b) => {
        b.onclick = () => { opts = opts.filter((o) => o !== b.dataset.rmopt); renderExtra(); };
      });
      extraEl.querySelectorAll<HTMLButtonElement>('[data-addopt]').forEach((b) => {
        b.onclick = () => { opts.push(b.dataset.addopt!); renderExtra(); };
      });
    } else if (needsOptions(t)) {
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
    renderCheck();
  }

  // Live: how the data fits the field as it is being edited.
  function renderCheck(): void {
    if (!live) return;
    const r = read(true);
    checkEl.innerHTML = 'field' in r ? checkLine(check(live, r.field), live.noun) : '';
  }

  // Each type, labelled with how many rows it would refuse (after Create, a
  // type the saved points don't fit can't be chosen at all).
  function labelTypes(): void {
    if (!live) return;
    const cur = initial!;
    for (const o of [...typeEl.options]) {
      const t = o.value;
      const options = needsOptions(t) ? (needsOptions(cur.type) ? cur.options : dataOptions(live, cur, t)) : undefined;
      const c = check(live, { ...cur, type: t, options });
      const bad = c.total - c.fit;
      o.textContent = bad ? `${typeLabel(t)} · ${plural(bad, live.noun)} won't fit` : typeLabel(t);
      o.disabled = saved && bad > 0 && t !== cur.type;
    }
  }

  typeEl.onchange = () => {
    // Switching to a choice: fill the options from the data, so nothing is retyped.
    if (live && needsOptions(typeEl.value) && !needsOptions(initial!.type) && !opts.length) opts = dataOptions(live, initial!, typeEl.value);
    renderExtra();
  };
  reqEl.onchange = renderCheck;

  if (initial) {
    labelEl.value = initial.label;
    typeEl.value = initial.type;
    reqEl.checked = !!initial.required;
    hintEl.value = initial.hint || '';
  }
  labelTypes();
  renderExtra();
  if (initial) {
    if (needsOptions(initial.type) && !live) {
      const o = host.querySelector<HTMLTextAreaElement>('.ff-opts'); if (o) o.value = (initial.options || []).join('\n');
      const c = host.querySelector<HTMLInputElement>('.ff-chips'); if (c) c.checked = initial.render === 'chips';
    } else if (initial.type === 'number') {
      const mn = host.querySelector<HTMLInputElement>('.ff-min'); if (mn && initial.min != null) mn.value = String(initial.min);
      const mx = host.querySelector<HTMLInputElement>('.ff-max'); if (mx && initial.max != null) mx.value = String(initial.max);
      const it = host.querySelector<HTMLInputElement>('.ff-int'); if (it) it.checked = !!initial.integer;
    } else if (initial.type === 'text' || initial.type === 'paragraph') {
      const ml = host.querySelector<HTMLInputElement>('.ff-maxlen'); if (ml && initial.maxLength != null) ml.value = String(initial.maxLength);
    }
    renderCheck();
  }
  // Typing re-checks the whole column: wait for a pause rather than every key.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const checkSoon = (): void => { clearTimeout(pending); pending = setTimeout(renderCheck, 150); };
  host.addEventListener('input', (e) => { if ((e.target as HTMLElement).matches('.ff-min, .ff-max, .ff-maxlen, .ff-opts')) checkSoon(); });
  host.addEventListener('change', (e) => { if ((e.target as HTMLElement).matches('.ff-int')) renderCheck(); });

  // quiet: for the live check (no error shown; an emptied label keeps the old one)
  function read(quiet = false): { field: BuilderField } | { error: string } {
    if (!quiet) errEl.textContent = '';
    const label = labelEl.value.trim() || (quiet ? initial?.label ?? '' : '');
    if (!label) return { error: 'Give the field a label.' };
    const type = typeEl.value;
    const f: BuilderField = { key: initial?.key ?? '', label, type };
    if (reqEl.checked) f.required = true;
    const hint = hintEl.value.trim();
    if (hint) f.hint = hint;

    if (needsOptions(type)) {
      const typed = (host.querySelector<HTMLTextAreaElement>('.ff-opts')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      const all = [...new Set(live ? [...opts, ...typed] : typed)];
      if (!all.length) return { error: 'Add at least one option.' };
      f.options = all;
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

  return { read: () => read(), focus: () => labelEl.focus(), setError: (m) => { errEl.textContent = m; } };
}

export function mountSchemaBuilder(
  container: HTMLElement,
  initial: BuilderField[] = [],
  opts: BuilderOptions = {},
): { getFields: () => BuilderField[] } {
  const { data, existing, onChange } = opts;
  const fields: BuilderField[] = initial.map((f) => ({ ...f }));
  const savedKeys = new Set(existing ? initial.map((f) => f.key) : []);
  let editingIndex: number | null = null; // which row is open for inline edit
  const getFields = (): BuilderField[] => fields.map(({ note: _note, ...f }) => f);
  const changed = (): void => onChange?.(getFields());

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
    const built = addForm.read();
    if ('error' in built) { addForm.setError(built.error); return; }
    built.field.key = deriveKey(built.field.label, fields.map((x) => x.key));
    fields.push(built.field);
    addForm = createFieldForm(container.querySelector<HTMLElement>('#sb-add .ff-host')!, null); // reset
    renderList();
    changed();
  };

  function renderList(): void {
    // one form at a time: while a field is open for inline edit, hide the add card
    addCardEl.style.display = editingIndex === null ? '' : 'none';
    if (!fields.length) {
      listEl.innerHTML = '<p class="hint">No fields yet. Add at least one.</p>';
      return;
    }
    listEl.innerHTML = fields.map((f, i) => {
      // Saved fields are hidden, not removed: their points keep the data.
      const remove = savedKeys.has(f.key)
        ? `<button data-hide="${i}" aria-label="${f.deleted ? 'Show' : 'Hide'} field ${escapeHtml(f.label)}">${f.deleted ? 'Show' : 'Hide'}</button>`
        : `<button data-rm="${i}" aria-label="Remove field">✕</button>`;
      const status = data && !f.deleted ? `<p class="sb-check hint">${checkLine(check(data, f), data.noun)}</p>` : '';
      return `
      <div class="link-box${editingIndex === i ? ' link-box--editing' : ''}${f.deleted ? ' sb-hidden' : ''}">
        <button type="button" class="sb-name" data-edit="${i}" aria-expanded="${editingIndex === i}" aria-label="Edit field ${escapeHtml(f.label)}">${escapeHtml(f.label)}${f.required ? ' *' : ''}
          <span class="hint">${f.deleted ? 'Hidden · ' : ''}${typeLabel(f.type)}${f.options ? ` · ${f.options.length} options` : ''}</span></button>
        <button data-mv="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-mv="dn" data-i="${i}" aria-label="Move down" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button>
        ${remove}
      </div>${status}${f.note ? `<p class="hint sb-note">${escapeHtml(f.note)}</p>` : ''}${editingIndex === i ? `
      <div class="card sb-edit" data-editcard="${i}">
        <div class="ff-host"></div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="sb-save primary" style="flex:1">Save field</button>
          <button type="button" class="sb-cancel">Cancel</button>
        </div>
      </div>` : ''}`;
    }).join('');

    // click a field name → open its inline editor (or close it if already open)
    listEl.querySelectorAll<HTMLButtonElement>('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.edit);
        editingIndex = editingIndex === i ? null : i;
        renderList();
      };
    });
    // reorder / remove / hide close any open editor first (indices would otherwise drift)
    listEl.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => {
      b.onclick = () => { fields.splice(Number(b.dataset.rm), 1); editingIndex = null; renderList(); changed(); };
    });
    listEl.querySelectorAll<HTMLButtonElement>('[data-hide]').forEach((b) => {
      b.onclick = () => {
        const f = fields[Number(b.dataset.hide)];
        if (f.deleted) delete f.deleted; else f.deleted = true;
        editingIndex = null; renderList(); changed();
      };
    });
    listEl.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const j = b.dataset.mv === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= fields.length) return;
        [fields[i], fields[j]] = [fields[j], fields[i]];
        editingIndex = null;
        renderList();
        changed();
      };
    });

    // mount the inline edit form under the open row
    if (editingIndex !== null) {
      const i = editingIndex;
      const card = listEl.querySelector<HTMLElement>(`[data-editcard="${i}"]`);
      if (card) {
        const editForm = createFieldForm(card.querySelector<HTMLElement>('.ff-host')!, fields[i], data, savedKeys.has(fields[i].key));
        editForm.focus();
        (card.querySelector('.sb-save') as HTMLButtonElement).onclick = () => {
          const built = editForm.read();
          if ('error' in built) { editForm.setError(built.error); return; }
          built.field.key = fields[i].key; // keep the key stable across an edit
          if (fields[i].deleted) built.field.deleted = true;
          fields[i] = built.field; // a saved edit drops the guesser's note
          editingIndex = null;
          renderList();
          changed();
        };
        (card.querySelector('.sb-cancel') as HTMLButtonElement).onclick = () => { editingIndex = null; renderList(); };
      }
    }
  }

  renderList();
  return { getFields };
}
