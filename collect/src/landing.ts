// Create-a-map landing. Phase 1 uses a fixed 2-field schema (the schema builder
// is Phase 2); the author picks name / purpose / geometry / licence.
import { apiJson } from './api';
import { turnstileToken } from './turnstile';
import { mountSchemaBuilder } from './schema-builder';
import { escapeHtml, downloadText } from './util';
import { type RefLayer } from './geo/catalog';
import { mountLayerPicker } from './geo/layer-picker';
import { detectFormat, parseImport, type Parsed } from './import/parse';
import { inferSchema } from './import/infer';
import { autoMapping, buildRecords, errorsToCSV, type Mapping } from './import/build';
import { summarizeErrors } from './import/check';
import { importReport, importReportHtml, importInChunks, type ImportReply, type ImportReport } from './import/report';
import type { Field } from './schema/validate-record';
import type { BuilderField } from './schema-builder';
import { myMaps, saveOwnedMap, openLink, type SavedMap, type MapRole } from './maps-store';
import { CATEGORIES, OPEN_LICENCES } from './options';
import { linksMailtoHref, linksText } from './share';
import { shareItemHtml, wireShareItems, toggleQr } from './share-ui';
import { mountInstallButton } from '../../web/src/install-button';
import { syncSecretFrom } from './keyring';
import { syncState, syncDevice, setUpSync, joinSync, turnOffSync, startAutoSync, unlockWithPasskey, SyncGone } from './syncing';
import { passkeysAvailable } from './passkey';
import { queuedFor, sendWhenOnline, OUTBOX_CHANGED } from './send-queue';
import './register-sw';

const app = document.getElementById('app')!;

// "Install app": one element, mounted once, re-inserted each time home() redraws,
// so a captured install prompt survives trips to the create form and back.
const installBtn = document.createElement('button');
installBtn.type = 'button';
installBtn.className = 'install-app';
installBtn.hidden = true;
installBtn.textContent = 'Install app';
mountInstallButton(installBtn, { appName: 'collect' });

// Public masthead counter (like the atlas's download counts): points collected
// so far, best-effort. Hidden until there's something to show.
async function fillMasthead(): Promise<void> {
  try {
    const s = await apiJson<{ points: number; contributors: number; states: number }>('/stats', '');
    const el = document.getElementById('masthead-stat');
    if (!el || !s.points) return;
    const n = (x: number): string => x.toLocaleString('en-IN');
    const parts = [`<strong>${n(s.points)}</strong> point${s.points === 1 ? '' : 's'} collected`];
    if (s.contributors > 1) parts.push(`by ${n(s.contributors)} people`);
    if (s.states > 1) parts.push(`across ${n(s.states)} states`);
    el.innerHTML = parts.join(' · ');
  } catch { /* best-effort */ }
}

const ROLE_PILL: Record<MapRole, string> = { owner: 'Owner', collect: 'Collect', view: 'View' };

function mapsSection(): string {
  const maps = myMaps();
  return `<label>Your maps <span class="hint">(saved on this device)</span></label>
    ${maps.length
      ? maps.map((m) => `<div class="link-box">
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.name || 'Untitled map')} <span class="pill pill--${m.role}">${ROLE_PILL[m.role]}</span></span>
          <a class="btn" href="${openLink(m) || '#'}">Open</a>
          ${m.links.admin ? `<a class="btn" href="${m.links.admin}">Manage</a>` : ''}
        </div>${recordsList(m)}`).join('')
      : '<p class="empty">No maps yet. Make one above, or open a link someone shared, and it will appear here to reopen anytime.</p>'}`;
}

// Records you added to a map, each with its own edit link (edit / delete /
// remove your name). Collapsed so a long list doesn't push the maps apart.
function recordsList(m: SavedMap): string {
  const recs = m.records ?? [];
  if (!recs.length) return '';
  return `<details class="my-records"><summary class="hint">Your additions (${recs.length})</summary>
    ${recs.map((r) => `<a class="my-record" href="${escapeHtml(r.link)}">${escapeHtml(r.label || 'Your point')}</a>`).join('')}
  </details>`;
}

// The landing: a list of your maps + a "start collecting" CTA into the create form.
function home() {
  app.innerHTML = `
    <div class="topbar"><span>collect</span><a class="brand" href="https://bharatlas.com">bhar<span class="brand-accent">atlas</span></a></div>
    <div class="pad">
      <h1>Make a map, collect together</h1>
      <p class="hint">Here you <strong>design</strong> a small form and share a link. <strong>Anyone with the link</strong> can <strong>add points</strong> on the map, no accounts. Download the data, or publish it to the bharatlas catalog when it's ready.</p>
      <p id="masthead-stat" class="masthead-stat"></p>
      <span id="install-slot"></span>
      <button class="primary" id="start">＋ Make a new map</button>
      <div style="height:18px"></div>
      <p class="hint" id="outbox-note"></p>
      <div id="mymaps">${mapsSection()}</div>
      <div id="sync"></div>
      <footer class="foot-note">
        <span>Part of <a href="https://bharatlas.com">bharatlas</a>, built for the field and optimised for mobile.</span>
        <span><a href="https://bharatlas.com/about">About</a> · <a href="https://bharatlas.com/terms">Terms</a></span>
      </footer>
    </div>`;
  app.querySelector('#install-slot')!.replaceWith(installBtn);
  app.querySelector<HTMLButtonElement>('#start')!.onclick = createForm;
  void fillMasthead();
  void renderQueueNote();
  renderSync();
}

// "Your maps on all your devices": one way, a passkey. The notice is the
// consent: what's stored, that bharatlas can't read it, how long it's kept, and
// how to delete it. (Older sync links still open, see bootSync; collect no
// longer offers them, nor the backup file: one thing, made to work.)
const SYNC_NOTICE = `Keeps an <strong>encrypted copy</strong> of your map links on bharatlas, opened with your passkey. bharatlas can't read it. It's deleted after <strong>12 months</strong> without use, or when you turn sync off.`;
// An app on an iPhone/iPad home screen keeps its own list, apart from Safari's.
const homeScreenApp = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

function renderSync(note = ''): void {
  const box = app.querySelector<HTMLElement>('#sync');
  if (!box) return;
  const st = syncState();
  const warn = note ? `<p class="warn">${escapeHtml(note)}</p>` : '';
  if (!passkeysAvailable()) {
    box.innerHTML = `<label>Your maps on all your devices</label>
      <p class="hint">This browser can't use passkeys. Open collect in Safari or Chrome to see your maps on your phone, tablet and computer.</p>`;
    return;
  }
  if (st?.passkey) {
    const when = st.synced_at ? new Date(st.synced_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet';
    box.innerHTML = `<label>Your maps on all your devices</label>
      <p class="ok">✓ On, synced ${escapeHtml(when)}</p>
      ${warn}
      <p class="hint">Adding a device? Open collect there and tap <strong>I've set this up already</strong>.</p>
      <button type="button" class="linklike" id="sync-off">Turn off sync</button>`;
    let armed = false;
    box.querySelector<HTMLButtonElement>('#sync-off')!.onclick = async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (!armed) { armed = true; b.textContent = 'Tap again: stops sync on all your devices and deletes the copy (your maps stay on each device)'; return; }
      b.disabled = true;
      try { await turnOffSync(); renderSync(); } catch (ex) { renderSync((ex as Error).message); }
    };
    return;
  }
  // Not set up here (or an older copy with no passkey): one question.
  box.innerHTML = `<label>Your maps on all your devices</label>
    <p class="hint">Use a passkey (Face ID, fingerprint or screen lock) to see your maps on your phone, tablet and computer.${homeScreenApp() ? ' This app keeps its own list, so set it up here too.' : ''}</p>
    ${warn}
    <button class="wide primary" id="sync-setup">Set up on this device</button>
    <button class="wide" id="sync-join" style="margin-top:8px">I've set this up already</button>
    <p class="hint">Already using collect on another device? Choose <strong>I've set this up already</strong>, so all your devices share one list.</p>
    <p class="hint">${SYNC_NOTICE}</p>`;
  const act = (id: string, run: () => Promise<void>): void => {
    const b = box.querySelector<HTMLButtonElement>(id)!;
    b.onclick = async () => {
      b.disabled = true;
      try { await run(); home(); } catch (ex) { renderSync(passkeyError(ex)); }
    };
  };
  act('#sync-setup', setUpSync);
  act('#sync-join', unlockWithPasskey);
}

// Plain words for a passkey that didn't work.
function passkeyError(ex: unknown): string {
  const e = ex as Error;
  if (e?.name === 'NotAllowedError') return 'Passkey cancelled.';
  if (/no synced copy/.test(e?.message ?? '')) return "That passkey doesn't open a synced list. On the device where you set it up, check that sync is on.";
  if (/sync link|can't (unlock|be used)/.test(e?.message ?? '')) return "This browser or passkey can't sync your maps. Try Safari or Chrome, with the passkey saved to iCloud Keychain or Google Password Manager.";
  return e?.message || 'Something went wrong.';
}

// On load: adopt a sync link opened on this device (then strip the secret from
// the address bar), or sync if this device already joined.
async function bootSync(): Promise<void> {
  const secret = syncSecretFrom(location.hash);
  try {
    if (secret) {
      history.replaceState(null, '', location.pathname + location.search);
      await joinSync(secret);
    } else if (syncState()) {
      await syncDevice();
    } else return;
    home();
  } catch (e) {
    renderSync(e instanceof SyncGone ? 'Sync was turned off on another device, so it is off here too.'
      : e instanceof TypeError ? "You're offline. Your maps will sync when you're back online."
      : `Couldn't sync: ${(e as Error).message}`);
  }
}

function createForm() {
  app.innerHTML = `
    <div class="topbar"><a href="#" id="tohome" aria-label="Back to your maps">←</a><span>New map</span><span class="muted" style="margin-left:auto">collect</span></div>
    <div class="pad">
      <label>Start from a file <span class="hint">(optional, we read the columns for you)</span></label>
      <label class="btn wide" style="cursor:pointer">⬆ Choose CSV, GeoJSON or KML<input id="seed-file" type="file" accept=".csv,.geojson,.json,.kml" hidden></label>
      <p id="seed-note" class="hint"></p>
      <label>Name your map</label>
      <input id="name" maxlength="120" placeholder="Bengaluru footpath survey" />
      <label>What's it for? <span class="hint">(shown to contributors)</span></label>
      <textarea id="purpose" maxlength="2000" placeholder="Mapping footpath condition across the ward"></textarea>
      <label>Category <span class="hint">(where it slots in the catalog when published)</span></label>
      <select id="category">${CATEGORIES.map(([id, l]) => `<option value="${id}">${l}</option>`).join('')}</select>
      <label>What contributors fill in <span class="hint">(the form for each point)</span></label>
      <div id="fields-builder"></div>
      <label>Contributors add <span class="hint">(pick one or more)</span></label>
      <div class="row" id="geom">
        <button type="button" class="chip on" data-g="point">Points</button>
        <button type="button" class="chip" data-g="line">Lines</button>
        <button type="button" class="chip" data-g="polygon">Areas</button>
      </div>
      <label>Reference layer <span class="hint">(optional, show a bharatlas layer for context)</span></label>
      <input id="ref-search" placeholder="Tap to browse all layers, or type to filter…" autocomplete="off" />
      <div id="ref-results" class="ref-results"></div>
      <div id="ref-chosen"></div>
      <label>Licence <span class="hint">(open licences only, the map publishes openly)</span></label>
      <select id="license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}">${l}</option>`).join('')}</select>
      <label>Data year <span class="hint">(optional)</span></label>
      <input id="year" inputmode="numeric" placeholder="2026" />
      <div id="seed-import" style="display:none">
        <label>Where's this data from? <span class="hint">(source, shown in the published credit)</span></label>
        <input id="seed-source" maxlength="200" placeholder="e.g. SOI Forest Atlas 2021, or a link" />
        <label class="chip" style="gap:8px;margin-top:8px;align-items:flex-start;border-radius:12px;padding:10px 12px"><input type="checkbox" id="seed-rights" style="width:auto;min-height:auto;margin-top:3px"><span style="white-space:normal;font-weight:400;font-size:13px">I have the right to publish this data under the map's licence, and to load it here.</span></label>
      </div>
      <div style="height:16px"></div>
      <p class="hint">Map <strong>public places and assets</strong>, not people or private details. You're responsible for what's collected and published. <a href="https://bharatlas.com/terms" target="_blank" rel="noopener">Terms</a>.</p>
      <div id="seed-summary" aria-live="polite"></div>
      <button class="primary" id="create">Create map</button>
      <p id="err" class="warn"></p>
    </div>`;

  app.querySelector<HTMLAnchorElement>('#tohome')!.onclick = (e) => { e.preventDefault(); home(); };

  let builder = mountSchemaBuilder(app.querySelector<HTMLElement>('#fields-builder')!, [
    { key: 'name', label: 'Name of the place', type: 'text', required: true },
  ]);

  const geom = new Set(['point']);
  const syncGeomChips = (): void => {
    app.querySelectorAll<HTMLButtonElement>('#geom .chip').forEach((c) => c.classList.toggle('on', geom.has(c.dataset.g!)));
  };
  app.querySelectorAll<HTMLButtonElement>('#geom .chip').forEach((c) => {
    c.onclick = () => {
      const g = c.dataset.g!;
      if (geom.has(g)) { if (geom.size > 1) { geom.delete(g); c.classList.remove('on'); } }
      else { geom.add(g); c.classList.add('on'); }
      renderSeedSummary();
    };
  });

  // "Start from a file": discover columns → seed the builder + geometry. The
  // builder checks every field against the file as it is edited, and the box
  // above Create says how many rows will be added (and why the rest won't).
  let seeded: { parsed: Parsed; format: string; columns: Record<string, string> } | null = null;
  const seedMapping = (fields: Field[]): Mapping => {
    const ll = autoMapping([], seeded!.parsed.columns);
    const cols: Record<string, string> = {};
    for (const f of fields) if (seeded!.columns[f.key]) cols[f.key] = seeded!.columns[f.key];
    return { fields: cols, lng: ll.lng, lat: ll.lat };
  };
  const planSeed = () => {
    const fields = builder.getFields() as unknown as Field[];
    return buildRecords(seeded!.parsed.features, seedMapping(fields), fields, [...geom]);
  };
  function renderSeedSummary(): void {
    const box = app.querySelector<HTMLElement>('#seed-summary');
    const btn = app.querySelector<HTMLButtonElement>('#create');
    if (!box || !btn || !seeded) return;
    const n = seeded.parsed.features.length;
    const plan = planSeed();
    const ok = plan.records.length;
    btn.textContent = ok === n ? `Create map & add all ${n} rows` : `Create map & add ${ok} of ${n} rows`;
    if (ok === n) { box.innerHTML = `<p class="ok">✓ All ${n} rows fit this form.</p>`; return; }
    const reasons = summarizeErrors(plan.errors);
    box.innerHTML = `<div class="notice"><div>
        <strong>${n - ok} of ${n} rows won't be added</strong> as the form stands. Change the fields above to fit them, or create the map without them.
        <ul class="reasons">${reasons.slice(0, 6).map((r) => `<li>${escapeHtml(r.reason)} (${r.count})</li>`).join('')}</ul>
      </div>
      <button type="button" id="dl-skip">⬇ Download the ${n - ok} rows that won't be added</button></div>`;
    box.querySelector<HTMLButtonElement>('#dl-skip')!.onclick = () => downloadText(errorsToCSV(plan.errors), 'rows-not-added.csv', 'text/csv');
  }
  // Each column's cells, read once per file (the builder asks for them on every check).
  const fileData = (): { noun: string; values: (f: BuilderField) => unknown[] } => {
    const byColumn = new Map<string, unknown[]>();
    const blank = seeded!.parsed.features.map(() => '');
    return {
      noun: 'row',
      values: (f) => {
        const col = seeded!.columns[f.key];
        if (!col) return blank;
        let v = byColumn.get(col);
        if (!v) byColumn.set(col, (v = seeded!.parsed.features.map((ft) => ft.props[col])));
        return v;
      },
    };
  };
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
      seeded = { parsed, format, columns: inf.mapping };
      builder = mountSchemaBuilder(app.querySelector<HTMLElement>('#fields-builder')!, inf.fields, { data: fileData(), onChange: renderSeedSummary });
      geom.clear(); inf.geometry.forEach((t) => geom.add(t)); syncGeomChips();
      app.querySelector<HTMLElement>('#seed-import')!.style.display = '';
      renderSeedSummary();
      note.innerHTML = `Read <strong>${parsed.features.length}</strong> row${parsed.features.length === 1 ? '' : 's'} and guessed <strong>${inf.fields.length}</strong> field${inf.fields.length === 1 ? '' : 's'}. Review them below, then create.`;
    } catch (err) {
      note.textContent = `Couldn't read the file: ${(err as Error).message}`;
    }
  };

  // Reference-layer picker: browse ALL curated bharatlas layers, choose at most one.
  let chosenRef: RefLayer | null = null;
  const refSearch = app.querySelector<HTMLInputElement>('#ref-search')!;
  const refResults = app.querySelector<HTMLElement>('#ref-results')!;
  const refChosen = app.querySelector<HTMLElement>('#ref-chosen')!;
  const renderChosen = (): void => {
    refChosen.innerHTML = chosenRef
      ? `<div class="link-box"><code>${escapeHtml(chosenRef.label)}${chosenRef.category ? ` · ${escapeHtml(chosenRef.category)}` : ''}</code><button type="button" id="ref-clear">Remove</button></div>`
      : '';
    const clr = app.querySelector<HTMLButtonElement>('#ref-clear');
    if (clr) clr.onclick = () => { chosenRef = null; renderChosen(); };
  };
  mountLayerPicker(refSearch, refResults, (l) => { chosenRef = l; refResults.innerHTML = ''; refSearch.value = ''; renderChosen(); });

  app.querySelector<HTMLButtonElement>('#create')!.onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const err = app.querySelector('#err')!;
    err.textContent = '';
    btn.disabled = true;
    // Why the map wasn't created, never out of sight: the message is scrolled
    // into view and the field to fix gets focus (an error below the fold on an
    // iPad looked like nothing happened).
    const stop = (msg: string, field?: string): void => {
      err.textContent = msg;
      btn.disabled = false;
      const el = field ? app.querySelector<HTMLElement>(field) : null;
      (el ?? err).scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    };
    const year = (app.querySelector<HTMLInputElement>('#year')!.value || '').trim();
    try {
      // Validate the required fields client-side so people aren't bounced by a
      // server rejection after submitting (name 3-120, purpose required).
      const name = app.querySelector<HTMLInputElement>('#name')!.value.trim();
      if (name.length < 3) { stop('Give your map a name (at least 3 characters).', '#name'); return; }
      const purpose = app.querySelector<HTMLTextAreaElement>('#purpose')!.value.trim();
      if (!purpose) { stop('Say what the map is for (it is shown to contributors).', '#purpose'); return; }
      const fields = builder.getFields();
      if (!fields.length) { stop('Add at least one field for contributors to fill in.', '#fields-builder'); return; }
      const dataYear = year ? Number(year) : undefined;
      if (dataYear !== undefined && !Number.isInteger(dataYear)) {
        stop('Data year must be a whole number like 2026.', '#year'); return;
      }

      // Seeded from a file: validate the disclaimers + build the rows up front.
      let seedImport: { source: string; plan: ReturnType<typeof planSeed> } | null = null;
      if (seeded) {
        const source = (app.querySelector('#seed-source') as HTMLInputElement).value.trim();
        const rights = (app.querySelector('#seed-rights') as HTMLInputElement).checked;
        if (!rights) { stop('Tick the box confirming you can publish this data under the licence.', '#seed-rights'); return; }
        if (!source) { stop('Name where this data comes from.', '#seed-source'); return; }
        seedImport = { source, plan: planSeed() };
      }

      const turnstile_token = await turnstileToken();
      const res = await apiJson<{ id: string; links: Record<string, string>; tokens: { admin: string } }>('/collections', '', {
        method: 'POST',
        body: JSON.stringify({
          name,
          purpose,
          license: app.querySelector<HTMLSelectElement>('#license')!.value,
          data_year: dataYear,
          schema_doc: {
            version: 1,
            geometry: [...geom],
            fields,
            category: app.querySelector<HTMLSelectElement>('#category')!.value,
            reference_layer: chosenRef ? { id: chosenRef.id, pmtiles_url: chosenRef.pmtiles_url } : undefined,
          },
          turnstile_token,
        }),
      });
      // The map exists now; whatever happens to the rows is reported, never dropped quietly.
      let report: ImportReport | undefined;
      if (seedImport && seeded) {
        const { plan } = seedImport;
        const source = seedImport.source;
        const reply = await importInChunks(plan.records, (records) => apiJson<ImportReply>(`/collections/${res.id}/import`, res.tokens.admin, {
          method: 'POST',
          body: JSON.stringify({ records, source, rights_confirmed: true, client_skipped: { count: plan.errors.length, reasons: summarizeErrors(plan.errors) } }),
        }));
        report = importReport(seeded.parsed.features, plan, reply);
      }
      saveOwnedMap(res.id, name, res.links);
      done(res.links, report);
    } catch (e) {
      stop((e as Error).message);
    }
  };
}

function done(links: Record<string, string>, report?: ImportReport) {
  const mapLinks = { edit: links.edit, view: links.view, admin: links.admin };
  app.innerHTML = `
    <div class="topbar"><span>Your map is live</span><a class="brand" href="https://bharatlas.com">bhar<span class="brand-accent">atlas</span></a></div>
    <div class="pad">
      <h1>Your map is live 🎉</h1>
      ${report ? importReportHtml(report) : ''}
      <p class="hint">Share the collect link to gather points. To open this map on another device, Share a link to yourself or scan its QR. No accounts, so keep the admin link safe.</p>
      ${shareItemHtml('edit', '🔗 Collect link (share this)', links.edit, 'Anyone with this can add points. No login.')}
      ${shareItemHtml('view', '👁 View-only', links.view)}
      ${shareItemHtml('admin', '🔑 Admin link (keep secret)', links.admin, 'Full control: moderate, edit, publish. Shown once and cannot be recovered, so save it now.')}
      <button class="wide" id="dl">⬇ Download my links</button>
      <a class="btn wide" id="email-links" style="margin-top:8px">✉ Email these links to me</a>
      <div style="height:12px"></div>
      <a class="btn primary" href="${links.edit}">Open the map →</a>
      <div style="height:8px"></div>
      <a class="btn wide" href="#" id="tohome-done">← Your maps</a>
    </div>`;
  wireShareItems(app, 'bharatlas collect map');
  const dlNot = app.querySelector<HTMLButtonElement>('#dl-not-added');
  if (dlNot && report) dlNot.onclick = () => downloadText(errorsToCSV(report.notAdded), 'rows-not-added.csv', 'text/csv');
  (document.getElementById('email-links') as HTMLAnchorElement).href = linksMailtoHref(mapLinks);
  app.querySelector<HTMLAnchorElement>('#tohome-done')!.onclick = (e) => { e.preventDefault(); home(); };

  // the same block the email body uses, so the two never drift
  app.querySelector<HTMLButtonElement>('#dl')!.onclick = () => downloadText(linksText(mapLinks), 'collect-links.txt', 'text/plain');

  // Pre-open the admin QR: the fastest path to "open this on my other device".
  const adminItem = app.querySelector<HTMLElement>('.share-item[data-share="admin"]');
  const adminSlot = adminItem?.querySelector<HTMLElement>('.qr-slot');
  if (adminSlot) {
    void toggleQr(adminSlot, links.admin);
    adminItem?.querySelector('[data-act="qr"]')?.setAttribute('aria-expanded', 'true');
  }
}

// Points kept on this phone (offline capture). Once one is sent, its edit link
// joins "Your additions", so the maps list is redrawn too.
async function renderQueueNote(): Promise<void> {
  const note = app.querySelector('#outbox-note');
  if (!note) return;
  const queued = await queuedFor();
  const waiting = queued.filter((p) => !p.error).length;
  const refused = queued.length - waiting;
  note.textContent = [
    waiting ? `⏳ ${waiting} point${waiting === 1 ? '' : 's'} kept on this phone, sent as soon as there's signal.` : '',
    refused ? `${refused} couldn't be sent; open the map to see why.` : '',
  ].join(' ');
  const list = app.querySelector('#mymaps');
  if (list) list.innerHTML = mapsSection();
}
window.addEventListener(OUTBOX_CHANGED, () => void renderQueueNote());

home();
startAutoSync();
sendWhenOnline();
void bootSync();
// A sync link pasted into an already-open tab only changes the fragment.
window.addEventListener('hashchange', () => { if (syncSecretFrom(location.hash)) void bootSync(); });
