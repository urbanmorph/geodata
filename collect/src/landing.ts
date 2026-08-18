// Create-a-map landing. Phase 1 uses a fixed 2-field schema (the schema builder
// is Phase 2); the author picks name / purpose / geometry / licence.
import { apiJson } from './api';

const OPEN_LICENCES: [string, string][] = [
  ['CC-BY-4.0', 'CC BY 4.0 (credit required)'],
  ['CC0-1.0', 'CC0 (public domain)'],
  ['CC-BY-SA-4.0', 'CC BY-SA 4.0'],
  ['ODbL-1.0', 'ODbL 1.0'],
  ['ODC-PDDL-1.0', 'PDDL 1.0'],
  ['GODL-India', 'GODL India'],
  ['CDLA-Permissive-2.0', 'CDLA Permissive 2.0'],
];

const defaultSchema = (geometry: string[]) => ({
  version: 1,
  geometry,
  fields: [
    { key: 'name', label: 'Name of the place', type: 'text', required: true },
    { key: 'notes', label: 'Notes', type: 'paragraph' },
  ],
});

const app = document.getElementById('app')!;

function render() {
  app.innerHTML = `
    <div class="topbar"><span>New map</span><span class="muted" style="margin-left:auto">collect · bharatlas</span></div>
    <div class="pad">
      <label>Name your map</label>
      <input id="name" maxlength="120" placeholder="Bengaluru footpath survey" />
      <label>What's it for? <span class="hint">(shown to contributors)</span></label>
      <textarea id="purpose" maxlength="2000" placeholder="Mapping footpath condition across the ward"></textarea>
      <label>Contributors add</label>
      <div class="row" id="geom">
        <button type="button" class="chip on" data-g="point">Points</button>
        <button type="button" class="chip" data-g="line">Lines</button>
        <button type="button" class="chip" data-g="polygon">Areas</button>
      </div>
      <label>Licence <span class="hint">(open licences only — the map publishes openly)</span></label>
      <select id="license">${OPEN_LICENCES.map(([id, l]) => `<option value="${id}">${l}</option>`).join('')}</select>
      <label>Data year <span class="hint">(optional)</span></label>
      <input id="year" inputmode="numeric" placeholder="2026" />
      <div style="height:16px"></div>
      <button class="primary" id="create">Create map</button>
      <p id="err" class="warn"></p>
    </div>`;

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
      const links = (await apiJson<{ id: string; links: Record<string, string> }>('/collections', '', {
        method: 'POST',
        body: JSON.stringify({
          name: app.querySelector<HTMLInputElement>('#name')!.value,
          purpose: app.querySelector<HTMLTextAreaElement>('#purpose')!.value,
          license: app.querySelector<HTMLSelectElement>('#license')!.value,
          data_year: year ? Number(year) : undefined,
          schema_doc: defaultSchema([...geom]),
        }),
      })).links;
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
  try {
    const store = JSON.parse(localStorage.getItem('collect:maps') || '[]');
    store.unshift({ links, at: new Date().toISOString() });
    localStorage.setItem('collect:maps', JSON.stringify(store.slice(0, 50)));
  } catch { /* per-device convenience only */ }

  app.innerHTML = `
    <div class="topbar"><span>Your map is live</span></div>
    <div class="pad">
      ${linkRow('🔗 Collect link — share this', links.edit)}
      <p class="hint">Anyone with this can add points. No login.</p>
      ${linkRow('👁 View-only', links.view)}
      ${linkRow('🔑 Admin — keep secret', links.admin)}
      <p class="warn">⚠ Shown once. Lose the admin link, lose the map.</p>
      <button id="dl">⬇ Download my links</button>
      <div style="height:10px"></div>
      <a class="btn primary" href="${links.edit}">Open the map →</a>
    </div>`;

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

render();
