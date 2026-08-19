// The Phase-2 schema builder: add fields from the 7 types, set required +
// type-specific config (options/chips for choices, whole-numbers for number),
// reorder, remove. Generates schema_doc.fields. Keys derive from labels.
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

export function mountSchemaBuilder(
  container: HTMLElement,
  initial: BuilderField[] = [],
): { getFields: () => BuilderField[] } {
  const fields: BuilderField[] = initial.slice();

  container.innerHTML = `
    <div id="sb-list"></div>
    <div class="card">
      <input id="sb-label" placeholder="Field label, e.g. Condition" />
      <div class="row" style="margin-top:6px">
        <select id="sb-type" style="flex:1">${TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label class="chip" style="gap:6px"><input type="checkbox" id="sb-req" style="width:auto;min-height:auto" /> Required</label>
      </div>
      <input id="sb-hint" placeholder="Help text (optional), shown under the field" style="margin-top:6px" />
      <div id="sb-extra"></div>
      <p id="sb-err" class="warn"></p>
      <button id="sb-add">+ Add field</button>
    </div>`;

  const q = <T extends HTMLElement>(sel: string) => container.querySelector<T>(sel)!;
  const listEl = q<HTMLElement>('#sb-list');
  const labelEl = q<HTMLInputElement>('#sb-label');
  const typeEl = q<HTMLSelectElement>('#sb-type');
  const reqEl = q<HTMLInputElement>('#sb-req');
  const extraEl = q<HTMLElement>('#sb-extra');
  const errEl = q<HTMLElement>('#sb-err');

  function renderList(): void {
    if (!fields.length) {
      listEl.innerHTML = '<p class="hint">No fields yet. Add at least one.</p>';
      return;
    }
    listEl.innerHTML = fields.map((f, i) => `
      <div class="link-box">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${escapeHtml(f.label)}${f.required ? ' *' : ''}
          <span class="hint">${typeLabel(f.type)}${f.options ? ` · ${f.options.length} options` : ''}</span></span>
        <button data-mv="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button data-mv="dn" data-i="${i}" aria-label="Move down" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button>
        <button data-rm="${i}" aria-label="Remove field">✕</button>
      </div>`).join('');

    listEl.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => {
      b.onclick = () => { fields.splice(Number(b.dataset.rm), 1); renderList(); };
    });
    listEl.querySelectorAll<HTMLButtonElement>('[data-mv]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.i);
        const j = b.dataset.mv === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= fields.length) return;
        [fields[i], fields[j]] = [fields[j], fields[i]];
        renderList();
      };
    });
  }

  function renderExtra(): void {
    const t = typeEl.value;
    if (needsOptions(t)) {
      extraEl.innerHTML = `<label>Options <span class="hint">(one per line)</span></label>
        <textarea id="sb-opts" placeholder="Good&#10;Needs repair&#10;Unusable"></textarea>
        <label class="chip" style="gap:6px;margin-top:6px"><input type="checkbox" id="sb-chips" style="width:auto;min-height:auto" /> Show as chips</label>`;
    } else if (t === 'number') {
      extraEl.innerHTML = `<div class="row" style="margin-top:6px">
          <input id="sb-min" inputmode="decimal" placeholder="Min" style="flex:1" />
          <input id="sb-max" inputmode="decimal" placeholder="Max" style="flex:1" />
        </div>
        <label class="chip" style="gap:6px;margin-top:6px"><input type="checkbox" id="sb-int" style="width:auto;min-height:auto" /> Whole numbers only</label>`;
    } else if (t === 'text' || t === 'paragraph') {
      extraEl.innerHTML = `<label>Max length <span class="hint">(optional)</span></label>
        <input id="sb-maxlen" inputmode="numeric" placeholder="e.g. 200" />`;
    } else {
      extraEl.innerHTML = '';
    }
  }
  typeEl.onchange = renderExtra;

  q<HTMLButtonElement>('#sb-add').onclick = () => {
    errEl.textContent = '';
    const label = labelEl.value.trim();
    if (!label) { errEl.textContent = 'Give the field a label.'; return; }
    if (fields.length >= MAX_FIELDS) { errEl.textContent = `Max ${MAX_FIELDS} fields.`; return; }

    const type = typeEl.value;
    const f: BuilderField = { key: deriveKey(label, fields.map((x) => x.key)), label, type };
    if (reqEl.checked) f.required = true;
    const hint = q<HTMLInputElement>('#sb-hint').value.trim();
    if (hint) f.hint = hint;

    if (needsOptions(type)) {
      const opts = (container.querySelector<HTMLTextAreaElement>('#sb-opts')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (!opts.length) { errEl.textContent = 'Add at least one option.'; return; }
      f.options = opts;
      if (container.querySelector<HTMLInputElement>('#sb-chips')?.checked) f.render = 'chips';
    }
    if (type === 'number') {
      const min = container.querySelector<HTMLInputElement>('#sb-min')?.value.trim();
      const max = container.querySelector<HTMLInputElement>('#sb-max')?.value.trim();
      if (min && Number.isFinite(Number(min))) f.min = Number(min);
      if (max && Number.isFinite(Number(max))) f.max = Number(max);
      if (container.querySelector<HTMLInputElement>('#sb-int')?.checked) f.integer = true;
    }
    if (type === 'text' || type === 'paragraph') {
      const ml = container.querySelector<HTMLInputElement>('#sb-maxlen')?.value.trim();
      if (ml && Number.isInteger(Number(ml)) && Number(ml) > 0) f.maxLength = Number(ml);
    }

    fields.push(f);
    labelEl.value = '';
    q<HTMLInputElement>('#sb-hint').value = '';
    reqEl.checked = false;
    renderExtra();
    renderList();
  };

  renderExtra();
  renderList();
  return { getFields: () => fields.slice() };
}
