// "Make a new map", guided in four steps, then a Ready screen:
//   1. What are you mapping?  (a template, or start from a spreadsheet)
//   2. What will people mark, and how will they collect?
//   3. What should people note?  (the questions)
//   4. Name your map  (more options folded away)
//   Ready: invite people now (optional) or skip; links live in Manage → Share.
// Only the create screens live here: leaving the flow returns to the home
// screen, which keeps "Your maps on all your devices" (passkey sync) as it was.
import { apiJson } from '../api';
import { turnstileToken } from '../turnstile';
import { mountSchemaBuilder, type BuilderField } from '../schema-builder';
import { escapeHtml, downloadText } from '../util';
import { type RefLayer } from '../geo/catalog';
import { mountLayerPicker } from '../geo/layer-picker';
import { detectFormat, parseImport, type Parsed } from '../import/parse';
import { inferSchema } from '../import/infer';
import { autoMapping, buildRecords, errorsToCSV, type Mapping } from '../import/build';
import { summarizeErrors } from '../import/check';
import { importReport, importReportHtml, importInChunks, type ImportReply, type ImportReport } from '../import/report';
import type { Field } from '../schema/validate-record';
import { saveOwnedMap } from '../maps-store';
import { CATEGORIES, OPEN_LICENCES } from '../options';
import { shareItemHtml, wireShareItems } from '../share-ui';
import { syncState } from '../syncing';
import { TEMPLATES, templateById } from './templates';
import { MARKS, modeChoices, withPhotoQuestion, schemaDocFor } from './plan';
import { usesAi, type CollectMode } from '../schema/modes';

export interface WizardHost {
  app: HTMLElement;
  /** Back to the home screen (with its sync section); `focusSync` scrolls to it. */
  home: (focusSync?: boolean) => void;
}

interface Seed { parsed: Parsed; format: string; columns: Record<string, string>; fileName: string; }

interface State {
  step: 1 | 2 | 3 | 4;
  template: string | null; // a template id, or 'file'
  geometry: string[];
  mode: CollectMode;
  fields: BuilderField[];
  category: string;
  name: string;
  purpose: string;
  moderation: boolean;
  license: string;
  year: string;
  dataSaver: boolean;
  ref: RefLayer | null;
  seed: Seed | null;
  source: string;
  rights: boolean;
}

const fresh = (): State => ({
  step: 1, template: null, geometry: ['point'], mode: 'form', fields: [], category: 'other',
  name: '', purpose: '', moderation: true, license: OPEN_LICENCES[0][0], year: '', dataSaver: false,
  ref: null, seed: null, source: '', rights: false,
});

const STEP_TITLES = ['What are you mapping?', 'What will people mark?', 'What should people note?', 'Name your map'];

export function startCreate(host: WizardHost): void {
  const { app } = host;
  const s = fresh();
  let builder: { getFields: () => BuilderField[] } | null = null;

  // Leaving step 3 keeps the questions as they stand.
  const keepFields = (): void => { if (builder) s.fields = builder.getFields(); builder = null; };

  function frame(body: string, foot: string): void {
    app.innerHTML = `
      <div class="topbar"><a href="#" id="wz-back-top" aria-label="${s.step === 1 ? 'Back to your maps' : 'Back a step'}">←</a><span>New map</span><span class="muted" style="margin-left:auto">Step ${s.step} of 4</span></div>
      <div class="pad wizard">
        <div class="steps" role="progressbar" aria-label="Step ${s.step} of 4" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${s.step}">${[1, 2, 3, 4].map((k) => `<span class="${k <= s.step ? 'on' : ''}"></span>`).join('')}</div>
        <h1>${STEP_TITLES[s.step - 1]}</h1>
        ${body}
        <p id="wz-err" class="warn" role="alert"></p>
      </div>
      <div class="wizard-foot">${foot}</div>`;
    app.querySelector<HTMLAnchorElement>('#wz-back-top')!.onclick = (e) => { e.preventDefault(); back(); };
    app.querySelector<HTMLButtonElement>('#wz-back')?.addEventListener('click', back);
  }
  const footer = (next: string, nextId = 'wz-next'): string =>
    `<button type="button" id="wz-back">${s.step === 1 ? '← Your maps' : '← Back'}</button><button type="button" class="primary" id="${nextId}" style="flex:1">${next}</button>`;

  function back(): void {
    if (s.step === 3) keepFields();
    if (s.step === 1) return host.home();
    s.step = (s.step - 1) as State['step'];
    render();
  }
  function go(step: State['step']): void { s.step = step; render(); }
  function stop(msg: string, field?: string): void {
    const err = app.querySelector<HTMLElement>('#wz-err')!;
    err.textContent = msg;
    const el = field ? app.querySelector<HTMLElement>(field) : null;
    (el ?? err).scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }

  function render(): void {
    window.scrollTo(0, 0);
    if (s.step === 1) return stepWhat();
    if (s.step === 2) return stepMark();
    if (s.step === 3) return stepQuestions();
    return stepName();
  }

  // ── 1. What are you mapping? ────────────────────────────────────────────
  function stepWhat(): void {
    frame(`
      <p class="hint">Pick the closest. You can change everything in the next steps.</p>
      <div class="choices" role="radiogroup" aria-label="What are you mapping?">
        ${TEMPLATES.map((t) => `<button type="button" class="choice" role="radio" aria-checked="${s.template === t.id}" data-t="${t.id}">
          <strong>${escapeHtml(t.title)}</strong><span class="hint">${escapeHtml(t.blurb)}</span></button>`).join('')}
        <label class="choice choice--file${s.template === 'file' ? ' on' : ''}">
          <strong>Start from a spreadsheet</strong>
          <span class="hint">${s.seed ? `${escapeHtml(s.seed.fileName)}: ${s.seed.parsed.features.length} rows read` : 'CSV, GeoJSON or KML. We read the columns and turn them into questions.'}</span>
          <input id="seed-file" type="file" accept=".csv,.geojson,.json,.kml" hidden>
        </label>
      </div>
      <p id="seed-note" class="hint" aria-live="polite"></p>`, footer('Next'));

    app.querySelectorAll<HTMLButtonElement>('.choice[data-t]').forEach((b) => {
      b.onclick = () => {
        const t = templateById(b.dataset.t!)!;
        if (s.template !== t.id) {
          Object.assign(s, { template: t.id, geometry: [...t.geometry], fields: t.fields.map((f) => ({ ...f })), category: t.category, seed: null, mode: 'form' as CollectMode });
        }
        go(2);
      };
    });
    app.querySelector<HTMLInputElement>('#seed-file')!.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      const note = app.querySelector('#seed-note')!;
      if (!file) return;
      const format = detectFormat(file.name);
      if (!format) { note.textContent = 'Use a .csv, .geojson or .kml file.'; return; }
      try {
        const parsed = parseImport(await file.text(), format);
        if (!parsed.features.length) { note.textContent = 'No rows found in that file.'; return; }
        const inf = inferSchema(parsed, format);
        Object.assign(s, { template: 'file', seed: { parsed, format, columns: inf.mapping, fileName: file.name }, fields: inf.fields, geometry: [...inf.geometry], mode: 'form' as CollectMode, category: 'other' });
        go(2);
      } catch (err) {
        note.textContent = `Couldn't read the file: ${(err as Error).message}`;
      }
    };
    app.querySelector<HTMLButtonElement>('#wz-next')!.onclick = () => {
      if (!s.template) { stop('Pick what you are mapping, or start from a spreadsheet.'); return; }
      go(2);
    };
  }

  // ── 2. What will people mark? How will they collect? ─────────────────────
  function stepMark(): void {
    const modes = modeChoices(s.geometry);
    if (modes.find((m) => m.id === s.mode)?.disabled) s.mode = 'form';
    frame(`
      <p class="hint">Choose one or more.</p>
      <div class="choices choices--row" role="group" aria-label="What will people mark?">
        ${MARKS.map((m) => `<button type="button" class="choice" aria-pressed="${s.geometry.includes(m.id)}" data-g="${m.id}"><strong>${m.label}</strong><span class="hint">${m.hint}</span></button>`).join('')}
      </div>
      <h2>How will people collect?</h2>
      <div class="choices" role="radiogroup" aria-label="How will people collect?">
        ${modes.map((m) => `<button type="button" class="choice" role="radio" aria-checked="${s.mode === m.id}" data-m="${m.id}"${m.disabled ? ' disabled aria-disabled="true"' : ''}>
          <strong>${m.title}</strong><span class="hint">${m.disabled ? escapeHtml(m.why) : m.blurb}</span></button>`).join('')}
      </div>
      <p class="hint">You can change this later in Manage → Settings.</p>`, footer('Next'));

    app.querySelectorAll<HTMLButtonElement>('.choice[data-g]').forEach((b) => {
      b.onclick = () => {
        const g = b.dataset.g!;
        if (s.geometry.includes(g)) { if (s.geometry.length > 1) s.geometry = s.geometry.filter((x) => x !== g); }
        else s.geometry = (['point', 'line', 'polygon'] as string[]).filter((x) => x === g || s.geometry.includes(x));
        stepMark();
      };
    });
    app.querySelectorAll<HTMLButtonElement>('.choice[data-m]').forEach((b) => {
      b.onclick = () => { s.mode = b.dataset.m as CollectMode; stepMark(); };
    });
    app.querySelector<HTMLButtonElement>('#wz-next')!.onclick = () => {
      s.fields = withPhotoQuestion(s.fields, s.mode);
      go(3);
    };
  }

  // ── 3. What should people note? ─────────────────────────────────────────
  function stepQuestions(): void {
    const n = s.seed?.parsed.features.length ?? 0;
    frame(`
      <p class="hint">Tap a question to change it. ${s.mode === 'photos_ai' ? 'People only take photos; the model answers the pick-one, pick-any and short-answer questions, and you check each point.' : ''}${s.mode === 'form_ai' ? 'The model also suggests answers to pick-one, pick-any and short-answer questions from the photo, for you to check. Numbers stay for people.' : ''}</p>
      ${s.seed ? `<p class="hint">Checked against the <strong>${n}</strong> row${n === 1 ? '' : 's'} in ${escapeHtml(s.seed.fileName)}.</p>` : ''}
      <div id="fields-builder"></div>
      <p class="hint">Every point also records where and when it was added.</p>`, footer('Next'));
    builder = mountSchemaBuilder(app.querySelector<HTMLElement>('#fields-builder')!, s.fields, s.seed ? { data: fileData(s.seed) } : {});
    app.querySelector<HTMLButtonElement>('#wz-next')!.onclick = () => {
      const fields = builder!.getFields();
      if (!fields.filter((f) => !f.deleted).length) { stop('Add at least one question.'); return; }
      if (usesAi(s.mode) && !fields.some((f) => f.type === 'photo')) { stop('AI notes need a Photo question. Add one, or go back and choose "Fill in a form".'); return; }
      keepFields();
      go(4);
    };
  }

  // ── 4. Name your map ────────────────────────────────────────────────────
  function stepName(): void {
    const t = s.template && s.template !== 'file' ? templateById(s.template) : undefined;
    frame(`
      <label for="name">Name</label>
      <input id="name" maxlength="120" placeholder="${escapeHtml(t?.name ?? 'Bengaluru footpath survey')}" value="${escapeHtml(s.name)}" />
      <label for="purpose">What should people do? <span class="hint">(shown to everyone who opens the map)</span></label>
      <textarea id="purpose" maxlength="2000" placeholder="${escapeHtml(t?.purpose ?? 'Mark every footpath in the ward')}">${escapeHtml(s.purpose)}</textarea>
      <label class="toggle"><input type="checkbox" id="moderation"${s.moderation ? ' checked' : ''}> <span><strong>Check points before others see them</strong><span class="hint">You approve each point in Manage. Your own points show at once.${s.mode === 'photos_ai' ? ' Points filled in from photos always wait for your check.' : ''}</span></span></label>
      ${s.seed ? `
        <label for="seed-source">Where's this data from? <span class="hint">(shown in the published credit)</span></label>
        <input id="seed-source" maxlength="200" placeholder="e.g. SOI Forest Atlas 2021, or a link" value="${escapeHtml(s.source)}" />
        <label class="toggle"><input type="checkbox" id="seed-rights"${s.rights ? ' checked' : ''}> <span>I have the right to publish this data under the map's licence, and to load it here.</span></label>
        <div id="seed-summary" aria-live="polite"></div>` : ''}
      <details class="more">
        <summary>More options</summary>
        <label for="category">Category <span class="hint">(where it sits in the catalog when published)</span></label>
        <select id="category">${CATEGORIES.map(([id, l]) => `<option value="${id}"${id === s.category ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label for="ref-search">Reference layer <span class="hint">(optional, a bharatlas layer shown for context)</span></label>
        <input id="ref-search" placeholder="Tap to browse all layers, or type to filter…" autocomplete="off" />
        <div id="ref-results" class="ref-results"></div>
        <div id="ref-chosen"></div>
        <label for="license">Licence <span class="hint">(open licences only, the map publishes openly)</span></label>
        <select id="license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}"${id === s.license ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label for="year">Data year <span class="hint">(optional)</span></label>
        <input id="year" inputmode="numeric" placeholder="2026" value="${escapeHtml(s.year)}" />
        <label class="toggle"><input type="checkbox" id="data-saver"${s.dataSaver ? ' checked' : ''}> <span><strong>Data saver</strong><span class="hint">Smaller photos (about 150 KB instead of 300 KB), for paid or weak mobile data.</span></span></label>
      </details>
      <p class="hint">Map <strong>public places and assets</strong>, not people or private details. You're responsible for what's collected and published. <a href="https://bharatlas.com/terms" target="_blank" rel="noopener">Terms</a>.</p>`,
    footer('Create map', 'create'));

    const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
    const read = (): void => {
      s.name = $<HTMLInputElement>('#name').value;
      s.purpose = $<HTMLTextAreaElement>('#purpose').value;
      s.moderation = $<HTMLInputElement>('#moderation').checked;
      s.category = $<HTMLSelectElement>('#category').value;
      s.license = $<HTMLSelectElement>('#license').value;
      s.year = $<HTMLInputElement>('#year').value;
      s.dataSaver = $<HTMLInputElement>('#data-saver').checked;
      if (s.seed) { s.source = $<HTMLInputElement>('#seed-source').value; s.rights = $<HTMLInputElement>('#seed-rights').checked; }
    };
    const pad = $<HTMLElement>('.pad');
    pad.addEventListener('input', read);
    pad.addEventListener('change', read);

    const refChosen = $<HTMLElement>('#ref-chosen');
    const renderChosen = (): void => {
      refChosen.innerHTML = s.ref ? `<div class="link-box"><code>${escapeHtml(s.ref.label)}${s.ref.category ? ` · ${escapeHtml(s.ref.category)}` : ''}</code><button type="button" id="ref-clear">Remove</button></div>` : '';
      const clr = app.querySelector<HTMLButtonElement>('#ref-clear');
      if (clr) clr.onclick = () => { s.ref = null; renderChosen(); };
    };
    renderChosen();
    const refSearch = $<HTMLInputElement>('#ref-search');
    const refResults = $<HTMLElement>('#ref-results');
    mountLayerPicker(refSearch, refResults, (l) => { s.ref = l; refResults.innerHTML = ''; refSearch.value = ''; renderChosen(); });

    if (s.seed) renderSeedSummary(app, s);
    $<HTMLButtonElement>('#create').onclick = (ev) => void create(ev.currentTarget as HTMLButtonElement, read);
  }

  async function create(btn: HTMLButtonElement, read: () => void): Promise<void> {
    read();
    const name = s.name.trim();
    if (name.length < 3) return stop('Give your map a name (at least 3 characters).', '#name');
    const purpose = s.purpose.trim();
    if (!purpose) return stop('Say what people should do (it is shown on the map).', '#purpose');
    const year = s.year.trim();
    const dataYear = year ? Number(year) : undefined;
    if (dataYear !== undefined && !Number.isInteger(dataYear)) {
      app.querySelector<HTMLDetailsElement>('details.more')!.open = true;
      return stop('Data year must be a whole number like 2026.', '#year');
    }
    if (s.seed) {
      if (!s.source.trim()) return stop('Name where this data comes from.', '#seed-source');
      if (!s.rights) return stop('Tick the box confirming you can publish this data under the licence.', '#seed-rights');
    }
    btn.disabled = true;
    try {
      const turnstile_token = await turnstileToken();
      const res = await apiJson<{ id: string; links: Record<string, string>; tokens: { admin: string } }>('/collections', '', {
        method: 'POST',
        body: JSON.stringify({
          name, purpose, license: s.license, data_year: dataYear, moderation: s.moderation ? 1 : 0,
          schema_doc: schemaDocFor({ geometry: s.geometry, fields: s.fields, mode: s.mode, category: s.category, dataSaver: s.dataSaver, reference: s.ref ? { id: s.ref.id, pmtiles_url: s.ref.pmtiles_url } : null }),
          turnstile_token,
        }),
      });
      // The map exists now; whatever happens to the rows is reported, never dropped quietly.
      let report: ImportReport | undefined;
      if (s.seed) {
        const plan = planSeed(s);
        const reply = await importInChunks(plan.records, (records) => apiJson<ImportReply>(`/collections/${res.id}/import`, res.tokens.admin, {
          method: 'POST',
          body: JSON.stringify({ records, source: s.source.trim(), rights_confirmed: true, client_skipped: { count: plan.errors.length, reasons: summarizeErrors(plan.errors) } }),
        }));
        report = importReport(s.seed.parsed.features, plan, reply);
      }
      saveOwnedMap(res.id, name, res.links); // syncs to the other devices when sync is on
      ready(host, { id: res.id, name, links: res.links, admin: res.tokens.admin, report });
    } catch (e) {
      btn.disabled = false;
      stop((e as Error).message);
    }
  }

  render();
}

// ── a spreadsheet's rows against the form ─────────────────────────────────

function seedMapping(s: State): Mapping {
  const ll = autoMapping([], s.seed!.parsed.columns);
  const cols: Record<string, string> = {};
  for (const f of s.fields) if (s.seed!.columns[f.key]) cols[f.key] = s.seed!.columns[f.key];
  return { fields: cols, lng: ll.lng, lat: ll.lat };
}
const planSeed = (s: State) => buildRecords(s.seed!.parsed.features, seedMapping(s), s.fields as unknown as Field[], s.geometry);

// Each column's cells, read once per file (the builder asks for them on every check).
function fileData(seed: Seed): { noun: string; values: (f: BuilderField) => unknown[] } {
  const byColumn = new Map<string, unknown[]>();
  const blank = seed.parsed.features.map(() => '');
  return {
    noun: 'row',
    values: (f) => {
      const col = seed.columns[f.key];
      if (!col) return blank;
      let v = byColumn.get(col);
      if (!v) byColumn.set(col, (v = seed.parsed.features.map((ft) => ft.props[col])));
      return v;
    },
  };
}

function renderSeedSummary(app: HTMLElement, s: State): void {
  const box = app.querySelector<HTMLElement>('#seed-summary');
  const btn = app.querySelector<HTMLButtonElement>('#create');
  if (!box || !btn || !s.seed) return;
  const n = s.seed.parsed.features.length;
  const plan = planSeed(s);
  const ok = plan.records.length;
  btn.textContent = ok === n ? `Create map & add all ${n} rows` : `Create map & add ${ok} of ${n} rows`;
  if (ok === n) { box.innerHTML = `<p class="ok">✓ All ${n} rows fit the questions.</p>`; return; }
  const reasons = summarizeErrors(plan.errors);
  box.innerHTML = `<div class="notice"><div>
      <strong>${n - ok} of ${n} rows won't be added</strong> as the questions stand. Go back a step to change them, or create the map without those rows.
      <ul class="reasons">${reasons.slice(0, 6).map((r) => `<li>${escapeHtml(r.reason)} (${r.count})</li>`).join('')}</ul>
    </div>
    <button type="button" id="dl-skip">⬇ Download the ${n - ok} rows that won't be added</button></div>`;
  box.querySelector<HTMLButtonElement>('#dl-skip')!.onclick = () => downloadText(errorsToCSV(plan.errors), 'rows-not-added.csv', 'text/csv');
}

// ── Ready ─────────────────────────────────────────────────────────────────

interface Made { id: string; name: string; links: Record<string, string>; admin: string; report?: ImportReport; }

export function ready(host: WizardHost, m: Made): void {
  const { app } = host;
  const synced = !!syncState()?.passkey;
  app.innerHTML = `
    <div class="topbar"><a href="#" id="rd-home" aria-label="Back to your maps">←</a><span>Map ready</span><a class="brand" href="https://bharatlas.com">bhar<span class="brand-accent">atlas</span></a></div>
    <div class="pad wizard">
      <svg class="ready-mark" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>
      <h1>${escapeHtml(m.name)} is ready</h1>
      ${m.report ? importReportHtml(m.report) : ''}
      <p class="hint">${synced
        ? "Saved to Your maps on this device. Sync is on, so it's on your other devices too."
        : 'Saved to Your maps on this device. Want it on your other devices too? <a href="#" id="rd-sync">Set up sync</a>'}</p>
      <section class="card invite">
        <div class="invite__head"><strong>Invite people to collect</strong><span class="hint">optional</span></div>
        <p class="hint">Each person gets their own link. You'll see who added what, and can switch one link off. You can do this any time from <strong>Manage → Share</strong>.</p>
        <label for="who">Name</label>
        <div class="row">
          <input id="who" maxlength="60" placeholder="e.g. Aarushi, or Ward 12 team" style="flex:1" />
          <button type="button" class="primary" id="invite">Make link</button>
        </div>
        <div id="invited" class="row" aria-live="polite"></div>
        <div id="invite-link"></div>
      </section>
      <p class="hint">Your admin link, view-only link and QR codes are in <strong>Manage → Share</strong>.</p>
    </div>
    <div class="wizard-foot"><a class="btn primary" id="rd-open" href="${escapeHtml(m.links.admin)}" style="flex:1">Skip for now, open the map</a></div>`;

  app.querySelector<HTMLAnchorElement>('#rd-home')!.onclick = (e) => { e.preventDefault(); host.home(); };
  app.querySelector<HTMLAnchorElement>('#rd-sync')?.addEventListener('click', (e) => { e.preventDefault(); host.home(true); });
  const dl = app.querySelector<HTMLButtonElement>('#dl-not-added');
  if (dl && m.report) dl.onclick = () => downloadText(errorsToCSV(m.report!.notAdded), 'rows-not-added.csv', 'text/csv');

  const who = app.querySelector<HTMLInputElement>('#who')!;
  const btn = app.querySelector<HTMLButtonElement>('#invite')!;
  const invited = app.querySelector<HTMLElement>('#invited')!;
  const slot = app.querySelector<HTMLElement>('#invite-link')!;
  btn.onclick = async () => {
    const label = who.value.trim();
    if (!label) { who.focus(); return; }
    btn.disabled = true;
    try {
      const res = await apiJson<{ link: string; label: string }>(`/collections/${m.id}/tokens`, m.admin, { method: 'POST', body: JSON.stringify({ permission: 'edit', label }) });
      slot.innerHTML = shareItemHtml('invite', `${res.label}'s link`, res.link, 'Send it to them now: for safety only its name is kept, so it is shown just this once.');
      wireShareItems(slot, `Help collect: ${m.name}`);
      invited.insertAdjacentHTML('beforeend', `<span class="chip">${escapeHtml(res.label)} · link made</span>`);
      who.value = '';
      app.querySelector<HTMLAnchorElement>('#rd-open')!.textContent = 'Done, open the map';
    } catch (e) {
      slot.innerHTML = `<p class="warn">${escapeHtml((e as Error).message)}</p>`;
    }
    btn.disabled = false;
  };
}
