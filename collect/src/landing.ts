// Create-a-map landing. Phase 1 uses a fixed 2-field schema (the schema builder
// is Phase 2); the author picks name / purpose / geometry / licence.
import { apiJson } from './api';
import { turnstileToken } from './turnstile';
import { mountSchemaBuilder } from './schema-builder';
import { escapeHtml } from './util';
import { BASEMAPS } from './basemap';
import { searchLayers, type RefLayer } from './geo/catalog';
import { detectFormat, parseImport, type Parsed } from './import/parse';
import { inferSchema } from './import/infer';
import { autoMapping, buildRecords } from './import/build';
import type { Field } from './schema/validate-record';
import { myMaps, saveOwnedMap, replaceMaps, openLink, type SavedMap, type MapRole } from './maps-store';
import { CATEGORIES, OPEN_LICENCES } from './options';
import { linksMailtoHref } from './share';
import { shareItemHtml, wireShareItems, toggleQr } from './share-ui';

const app = document.getElementById('app')!;

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
        </div>`).join('')
      : '<p class="empty">No maps yet. Make one above, or open a link someone shared, and it will appear here to reopen anytime.</p>'}`;
}

// The landing: a list of your maps + a "start collecting" CTA into the create form.
function home() {
  app.innerHTML = `
    <div class="topbar"><span>collect</span><a class="brand" href="https://bharatlas.com">bhar<span class="brand-accent">atlas</span></a></div>
    <div class="pad">
      <h1>Make a map, collect together</h1>
      <p class="hint">Here you <strong>design</strong> a small form and share a link. <strong>Anyone with the link</strong> can <strong>add points</strong> on the map, no accounts. Download the data, or publish it to the bharatlas catalog when it's ready.</p>
      <p id="masthead-stat" class="masthead-stat"></p>
      <button class="primary" id="start">＋ Make a new map</button>
      <div style="height:18px"></div>
      ${mapsSection()}
      <div style="height:14px"></div>
      <button id="export" class="wide">⬇ Save my map links</button>
      <label class="btn wide" style="cursor:pointer">⬆ Restore map links<input id="import" type="file" accept="application/json" hidden></label>
      <p class="hint">This file holds the <strong>links</strong> to your maps (your admin access), not the points people collect. With no accounts, it's how you reach your maps again from another device or browser.</p>
      <p id="imp-err" class="warn"></p>
      <footer class="foot-note">
        <span>Part of <a href="https://bharatlas.com">bharatlas</a>, built for the field and optimised for mobile.</span>
        <span><a href="https://bharatlas.com/about">About</a> · <a href="https://bharatlas.com/terms">Terms</a></span>
      </footer>
    </div>`;
  app.querySelector<HTMLButtonElement>('#start')!.onclick = createForm;
  void fillMasthead();

  app.querySelector<HTMLButtonElement>('#export')!.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(myMaps(), null, 2)], { type: 'application/json' }));
    a.download = 'collect-map-links.json';
    a.click();
  };
  app.querySelector<HTMLInputElement>('#import')!.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text()) as SavedMap[];
      if (!Array.isArray(incoming)) throw new Error('not a maps file');
      const seen = new Set<string>();
      const merged = [...incoming, ...myMaps()].filter((m) => {
        const key = m?.id || m?.links?.admin || m?.links?.edit || m?.links?.view || '';
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      replaceMaps(merged);
      home();
    } catch (ex) {
      app.querySelector('#imp-err')!.textContent = `Couldn't import: ${(ex as Error).message}`;
    }
  };
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
      <label>Map background</label>
      <select id="basemap">${BASEMAPS.map((b) => `<option value="${b.id}">${b.name}</option>`).join('')}</select>
      <label>Reference layer <span class="hint">(optional, show a bharatlas layer for context)</span></label>
      <input id="ref-search" placeholder="Search layers: forest, wards, hospitals…" autocomplete="off" />
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
    };
  });

  // "Start from a file": discover columns → seed the builder + geometry.
  let seeded: { parsed: Parsed; format: string } | null = null;
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
      seeded = { parsed, format };
      builder = mountSchemaBuilder(app.querySelector<HTMLElement>('#fields-builder')!, inf.fields);
      geom.clear(); inf.geometry.forEach((t) => geom.add(t)); syncGeomChips();
      app.querySelector<HTMLElement>('#seed-import')!.style.display = '';
      (app.querySelector('#create') as HTMLButtonElement).textContent = `Create map & import ${parsed.features.length} rows`;
      note.innerHTML = `Read <strong>${parsed.features.length}</strong> row${parsed.features.length === 1 ? '' : 's'} and guessed <strong>${inf.fields.length}</strong> field${inf.fields.length === 1 ? '' : 's'}. Review them below, then create.`;
    } catch (err) {
      note.textContent = `Couldn't read the file: ${(err as Error).message}`;
    }
  };

  // Reference-layer picker: search the bharatlas catalogue, choose at most one.
  let chosenRef: RefLayer | null = null;
  let lastResults: RefLayer[] = [];
  let refTimer: number | undefined;
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
  refSearch.oninput = () => {
    clearTimeout(refTimer);
    const q = refSearch.value.trim();
    if (!q) { refResults.innerHTML = ''; return; }
    refTimer = window.setTimeout(async () => {
      try {
        lastResults = await searchLayers(q);
        refResults.innerHTML = lastResults.length
          ? lastResults.slice(0, 8).map((l, i) => `<button type="button" class="ref-opt" data-i="${i}">${escapeHtml(l.label)}<span class="hint">${escapeHtml(l.category)}</span></button>`).join('')
          : '<p class="hint">No layers found.</p>';
        refResults.querySelectorAll<HTMLButtonElement>('.ref-opt').forEach((b) => {
          b.onclick = () => { chosenRef = lastResults[Number(b.dataset.i)]; refResults.innerHTML = ''; refSearch.value = ''; renderChosen(); };
        });
      } catch {
        refResults.innerHTML = '<p class="hint">Couldn\'t reach the catalogue, try again.</p>';
      }
    }, 300);
  };

  app.querySelector<HTMLButtonElement>('#create')!.onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const err = app.querySelector('#err')!;
    err.textContent = '';
    btn.disabled = true;
    const year = (app.querySelector<HTMLInputElement>('#year')!.value || '').trim();
    try {
      const name = app.querySelector<HTMLInputElement>('#name')!.value;
      const fields = builder.getFields();
      if (!fields.length) { err.textContent = 'Add at least one field for contributors to fill in.'; btn.disabled = false; return; }
      const dataYear = year ? Number(year) : undefined;
      if (dataYear !== undefined && !Number.isInteger(dataYear)) {
        err.textContent = 'Data year must be a whole number like 2026.'; btn.disabled = false; return;
      }

      // Seeded from a file: validate the disclaimers + build the rows up front.
      let seedImport: { source: string; records: unknown[] } | null = null;
      if (seeded) {
        const source = (app.querySelector('#seed-source') as HTMLInputElement).value.trim();
        const rights = (app.querySelector('#seed-rights') as HTMLInputElement).checked;
        if (!rights) { err.textContent = 'Tick the box confirming you can publish this data under the licence.'; btn.disabled = false; return; }
        if (!source) { err.textContent = 'Name where this data comes from.'; btn.disabled = false; return; }
        const f = fields as unknown as Field[];
        const built = buildRecords(seeded.parsed.features, autoMapping(f, seeded.parsed.columns), f, [...geom]);
        seedImport = { source, records: built.records };
      }

      const turnstile_token = await turnstileToken();
      const res = await apiJson<{ id: string; links: Record<string, string>; tokens: { admin: string } }>('/collections', '', {
        method: 'POST',
        body: JSON.stringify({
          name,
          purpose: app.querySelector<HTMLTextAreaElement>('#purpose')!.value,
          license: app.querySelector<HTMLSelectElement>('#license')!.value,
          data_year: dataYear,
          schema_doc: {
            version: 1,
            geometry: [...geom],
            fields,
            category: app.querySelector<HTMLSelectElement>('#category')!.value,
            basemap: app.querySelector<HTMLSelectElement>('#basemap')!.value,
            reference_layer: chosenRef ? { id: chosenRef.id, pmtiles_url: chosenRef.pmtiles_url } : undefined,
          },
          turnstile_token,
        }),
      });
      if (seedImport && seedImport.records.length) {
        await apiJson(`/collections/${res.id}/import`, res.tokens.admin, {
          method: 'POST',
          body: JSON.stringify({ records: seedImport.records, source: seedImport.source, rights_confirmed: true }),
        }).catch(() => { /* map is created; the rows can still be imported from Manage */ });
      }
      saveOwnedMap(res.id, name, res.links);
      done(res.links);
    } catch (e) {
      err.textContent = (e as Error).message;
      btn.disabled = false;
    }
  };
}

function done(links: Record<string, string>) {
  const mapLinks = { edit: links.edit, view: links.view, admin: links.admin };
  app.innerHTML = `
    <div class="topbar"><span>Your map is live</span><a class="brand" href="https://bharatlas.com">bhar<span class="brand-accent">atlas</span></a></div>
    <div class="pad">
      <h1>Your map is live 🎉</h1>
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
  (document.getElementById('email-links') as HTMLAnchorElement).href = linksMailtoHref(mapLinks);
  app.querySelector<HTMLAnchorElement>('#tohome-done')!.onclick = (e) => { e.preventDefault(); home(); };

  app.querySelector<HTMLButtonElement>('#dl')!.onclick = () => {
    const text = `collect.bharatlas.com links\n\nCollect (share): ${links.edit}\nView-only: ${links.view}\nAdmin (secret): ${links.admin}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'collect-links.txt';
    a.click();
  };

  // Pre-open the admin QR: the fastest path to "open this on my other device".
  const adminSlot = app.querySelector<HTMLElement>('.share-item[data-share="admin"] .qr-slot');
  if (adminSlot) void toggleQr(adminSlot, links.admin);
}

home();
