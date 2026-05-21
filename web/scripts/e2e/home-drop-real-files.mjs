// E2E test with the user's actual files.
// Reads each file from disk, drops it on the home page, waits for /verify
// to populate its sidebar and map source.
import { chromium } from 'playwright';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const FILES = [
  '/Users/sathya/Downloads/lgd_states__karnataka.kml',
  '/Users/sathya/Downloads/LGD_Subdistricts.parquet',
];

const log = (...a) => console.log(...a);

async function testOne(filePath, browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleLines = [];
  const errors = [];
  page.on('console', (m) => {
    const txt = m.text();
    // drop noisy webgl + tile lines
    if (/WebGL|GL_|bindBuffer|bindTexture/.test(txt)) return;
    consoleLines.push(`[${m.type()}] ${txt}`);
  });
  page.on('pageerror', (e) => errors.push(`[page error] ${e.message}\n${e.stack}`));

  log(`\n=== ${basename(filePath)} (${(statSync(filePath).size / 1024).toFixed(1)} KB) ===`);

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  log('  home loaded');

  // Read the file as base64 on disk, hand it to the page to construct a real File
  const buf = readFileSync(filePath);
  const b64 = buf.toString('base64');
  const fileName = basename(filePath);

  const dispatched = await page.evaluate(
    async ({ b64, fileName }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileName, {
        type: fileName.endsWith('.kml')
          ? 'application/vnd.google-earth.kml+xml'
          : fileName.endsWith('.parquet')
            ? 'application/x-parquet'
            : 'application/octet-stream',
      });
      const dt = new DataTransfer();
      dt.items.add(file);
      // Some browsers require dragenter/dragover preventDefault for drop to work;
      // dispatch the full sequence so our handler's hasFiles check sees 'Files'.
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { name: file.name, size: file.size, type: file.type };
    },
    { b64, fileName },
  );
  log('  drop dispatched, file:', dispatched);

  // Wait for navigation
  try {
    await page.waitForURL('**/contribute', { timeout: 5000 });
    log('  navigated to', page.url());
  } catch (e) {
    log('  ⚠ did NOT navigate to /verify within 5s, current url:', page.url());
  }

  // Wait for verify to either populate the sidebar OR error
  await page.waitForTimeout(8000); // parquet needs DuckDB boot

  const state = await page.evaluate(() => ({
    url: location.href,
    sidebar: document.getElementById('sidebar')?.innerText?.slice(0, 400) ?? '(missing)',
    hasSource: !!document.querySelector('canvas.maplibregl-canvas'),
    sessionStorage: sessionStorage.getItem('geodata:handoff'),
    bodyClasses: document.body.className,
    mapLoaderPresent: !!document.querySelector('.map-loader'),
  }));
  log('  state:', state);

  if (errors.length) {
    log('  ── page errors ──');
    for (const e of errors) log(' ', e);
  }
  if (consoleLines.length) {
    log('  ── console (last 15) ──');
    for (const l of consoleLines.slice(-15)) log(' ', l);
  }

  await ctx.close();
}

const browser = await chromium.launch({ headless: true });
for (const f of FILES) {
  await testOne(f, browser);
}
await browser.close();
