// E2E test for the home → drop file → /verify handoff flow.
// Captures console + network + DOM state so we can see exactly where it breaks.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const SAMPLE = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'test polygon', id: 1 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[77.0, 28.0], [77.5, 28.0], [77.5, 28.5], [77.0, 28.5], [77.0, 28.0]],
        ],
      },
    },
  ],
});
const tmpPath = '/tmp/test-poly.geojson';
writeFileSync(tmpPath, SAMPLE);

const log = (...a) => console.log(...a);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

page.on('console', (m) => log(`[browser ${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log(`[page error] ${e.message}`));
page.on('requestfailed', (r) => log(`[request fail] ${r.url()} ${r.failure()?.errorText}`));

log('--- step 1: open home ---');
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
log('  URL:', page.url());

log('--- step 2: programmatic file drop on body ---');
const result = await page.evaluate(async () => {
  // Read the test file as ArrayBuffer first, then synthesize a File and drop event.
  // We can't use playwright's setInputFiles since there's no input — only window-level drop.
  const fileContent = await fetch('data:application/geo+json;base64,' +
    btoa(JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'test' },
        geometry: { type: 'Polygon', coordinates: [[[77,28],[77.5,28],[77.5,28.5],[77,28.5],[77,28]]] },
      }],
    }))).then(r => r.arrayBuffer());
  const file = new File([fileContent], 'test.geojson', { type: 'application/geo+json' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  window.dispatchEvent(ev);
  return { dispatched: true, locationBefore: location.href };
});
log('  drop dispatched:', result);

// Give the async drop handler time to stash + navigate
await page.waitForTimeout(2000);

log('--- step 3: check current URL + storage state ---');
const after = await page.evaluate(() => {
  return {
    url: location.href,
    sessionStorage: sessionStorage.getItem('geodata:handoff'),
    cookies: document.cookie,
  };
});
log('  state:', after);

if (after.url.endsWith('/preview')) {
  log('--- step 4: on /verify, wait for handle() to fire ---');
  await page.waitForTimeout(3000);
  const verifyState = await page.evaluate(() => ({
    sidebarText: document.getElementById('sidebar')?.innerText?.slice(0, 200),
    mapHasSource: typeof window !== 'undefined',
    sessionStorage: sessionStorage.getItem('geodata:handoff'),
  }));
  log('  verify state:', verifyState);
} else {
  log('  ⚠ did not navigate to /verify');
}

await browser.close();
