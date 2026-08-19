// Create-a-map landing. Phase 1 uses a fixed 2-field schema (the schema builder
// is Phase 2); the author picks name / purpose / geometry / licence.
import { apiJson } from './api';
import { turnstileToken } from './turnstile';
import { mountSchemaBuilder } from './schema-builder';
import { escapeHtml } from './util';

const OPEN_LICENCES: [string, string][] = [
  ['CC-BY-4.0', 'CC BY 4.0 (credit required)'],
  ['CC0-1.0', 'CC0 (public domain)'],
  ['CC-BY-SA-4.0', 'CC BY-SA 4.0'],
  ['ODbL-1.0', 'ODbL 1.0'],
  ['ODC-PDDL-1.0', 'PDDL 1.0'],
  ['GODL-India', 'GODL India'],
  ['CDLA-Permissive-2.0', 'CDLA Permissive 2.0'],
];

const app = document.getElementById('app')!;

interface SavedMap { name: string; links: Record<string, string>; at: string; }

function myMaps(): SavedMap[] {
  try { return JSON.parse(localStorage.getItem('collect:maps') || '[]'); } catch { return []; }
}
function saveMap(name: string, links: Record<string, string>): void {
  try {
    const store = myMaps();
    store.unshift({ name: name || 'Untitled map', links, at: new Date().toISOString() });
    localStorage.setItem('collect:maps', JSON.stringify(store.slice(0, 50)));
  } catch { /* per-device convenience only */ }
}

function mapsSection(): string {
  const maps = myMaps();
  return `<label>Your maps <span class="hint">(saved on this device)</span></label>
    ${maps.length
      ? maps.map((m) => `<div class="link-box">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.name || 'Untitled map')}</span>
          <a class="btn" href="${m.links.edit}">Open</a>
          <a class="btn" href="${m.links.admin}">Admin</a>
        </div>`).join('')
      : '<p class="hint">Your created maps will appear here.</p>'}`;
}

// The landing: a list of your maps + a "start collecting" CTA into the create form.
function home() {
  app.innerHTML = `
    <div class="topbar"><span>collect</span><span class="muted" style="margin-left:auto">bharatlas</span></div>
    <div class="pad">
      <h1>Make a map, collect together</h1>
      <p class="hint">Here you <strong>design</strong> a small form. Share the collect link and anyone <strong>adds points</strong> on the map, no accounts. Publish to the bharatlas atlas when it's ready.</p>
      <button class="primary" id="start">＋ Make a new map</button>
      <div style="height:18px"></div>
      ${mapsSection()}
      <div style="height:14px"></div>
      <button id="export" class="wide">⬇ Back up my maps to a file</button>
      <label class="btn wide" style="cursor:pointer">⬆ Restore maps from a backup<input id="import" type="file" accept="application/json" hidden></label>
      <p class="hint">There are no accounts, so a backup file is the only way to keep your admin links if you change device or browser.</p>
      <p id="imp-err" class="warn"></p>
    </div>`;
  app.querySelector<HTMLButtonElement>('#start')!.onclick = createForm;

  app.querySelector<HTMLButtonElement>('#export')!.onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(myMaps(), null, 2)], { type: 'application/json' }));
    a.download = 'collect-maps.json';
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
        const key = m?.links?.admin || m?.links?.edit || '';
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      localStorage.setItem('collect:maps', JSON.stringify(merged.slice(0, 100)));
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
      <label>Name your map</label>
      <input id="name" maxlength="120" placeholder="Bengaluru footpath survey" />
      <label>What's it for? <span class="hint">(shown to contributors)</span></label>
      <textarea id="purpose" maxlength="2000" placeholder="Mapping footpath condition across the ward"></textarea>
      <label>What contributors fill in <span class="hint">(the form for each point)</span></label>
      <div id="fields-builder"></div>
      <label>Contributors add <span class="hint">(pick one or more)</span></label>
      <div class="row" id="geom">
        <button type="button" class="chip on" data-g="point">Points</button>
        <button type="button" class="chip" data-g="line">Lines</button>
        <button type="button" class="chip" data-g="polygon">Areas</button>
      </div>
      <label>Licence <span class="hint">(open licences only, the map publishes openly)</span></label>
      <select id="license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}">${l}</option>`).join('')}</select>
      <label>Data year <span class="hint">(optional)</span></label>
      <input id="year" inputmode="numeric" placeholder="2026" />
      <div style="height:16px"></div>
      <button class="primary" id="create">Create map</button>
      <p id="err" class="warn"></p>
    </div>`;

  app.querySelector<HTMLAnchorElement>('#tohome')!.onclick = (e) => { e.preventDefault(); home(); };

  const builder = mountSchemaBuilder(app.querySelector<HTMLElement>('#fields-builder')!, [
    { key: 'name', label: 'Name of the place', type: 'text', required: true },
  ]);

  const geom = new Set(['point']);
  app.querySelectorAll<HTMLButtonElement>('#geom .chip').forEach((c) => {
    c.onclick = () => {
      const g = c.dataset.g!;
      if (geom.has(g)) { if (geom.size > 1) { geom.delete(g); c.classList.remove('on'); } }
      else { geom.add(g); c.classList.add('on'); }
    };
  });

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
      const turnstile_token = await turnstileToken();
      const links = (await apiJson<{ id: string; links: Record<string, string> }>('/collections', '', {
        method: 'POST',
        body: JSON.stringify({
          name,
          purpose: app.querySelector<HTMLTextAreaElement>('#purpose')!.value,
          license: app.querySelector<HTMLSelectElement>('#license')!.value,
          data_year: dataYear,
          schema_doc: { version: 1, geometry: [...geom], fields },
          turnstile_token,
        }),
      })).links;
      saveMap(name, links);
      done(links);
    } catch (e) {
      err.textContent = (e as Error).message;
      btn.disabled = false;
    }
  };
}

function linkRow(label: string, url: string): string {
  return `<label>${label}</label><div class="link-box"><code>${url}</code><button data-copy="${encodeURIComponent(url)}">Copy</button></div>`;
}

function done(links: Record<string, string>) {
  app.innerHTML = `
    <div class="topbar"><span>Your map is live</span></div>
    <div class="pad">
      ${linkRow('🔗 Collect link, share this', links.edit)}
      <p class="hint">Anyone with this can add points. No login.</p>
      ${linkRow('👁 View-only', links.view)}
      ${linkRow('🔑 Admin, keep secret', links.admin)}
      <p class="warn">⚠ The <strong>admin</strong> link is shown once and can't be recovered, so save it. Fresh collect / view links can always be minted from the admin screen.</p>
      <button id="dl">⬇ Download my links</button>
      <div style="height:10px"></div>
      <a class="btn primary" href="${links.edit}">Open the map →</a>
      <div style="height:8px"></div>
      <a class="btn" href="#" id="tohome-done">← Your maps</a>
    </div>`;
  app.querySelector<HTMLAnchorElement>('#tohome-done')!.onclick = (e) => { e.preventDefault(); home(); };

  app.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => {
    b.onclick = () => { navigator.clipboard?.writeText(decodeURIComponent(b.dataset.copy!)); b.textContent = '✓'; };
  });
  app.querySelector<HTMLButtonElement>('#dl')!.onclick = () => {
    const text = `collect.bharatlas.com links\n\nCollect (share): ${links.edit}\nView-only: ${links.view}\nAdmin (secret): ${links.admin}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'collect-links.txt';
    a.click();
  };
}

home();
