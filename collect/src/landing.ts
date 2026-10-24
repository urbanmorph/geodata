// The home screen: your maps, "Make a new map" (the guided flow in
// create/wizard.ts) and "Your maps on all your devices" (passkey sync).
import { apiJson } from './api';
import { escapeHtml } from './util';
import { myMaps, openLink, type SavedMap, type MapRole } from './maps-store';
import { startCreate } from './create/wizard';
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

// The landing: a list of your maps + a "start collecting" CTA into the guided
// create flow. focusSync brings the sync section into view (from "Set up sync").
function home(focusSync = false) {
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
  app.querySelector<HTMLButtonElement>('#start')!.onclick = () => startCreate({ app, home });
  void fillMasthead();
  void renderQueueNote();
  renderSync();
  if (focusSync) app.querySelector('#sync')?.scrollIntoView({ block: 'start' });
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
