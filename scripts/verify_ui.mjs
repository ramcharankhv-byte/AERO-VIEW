/**
 * End-to-end UI verification.
 *
 * Drives the real app in a real Chrome via CDP and walks the five view states:
 * city -> building -> floor -> unit -> underground, screenshotting each and
 * asserting the DOM actually changed. Uses puppeteer-core against the installed
 * Chrome rather than downloading a Chromium.
 *
 * Usage: node scripts/verify_ui.mjs [outDir]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'docs', 'shots');
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/';
const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

mkdirSync(OUT, { recursive: true });

// The status bar only reports a count once /api/buildings has resolved and
// the scene is live, so it doubles as the readiness signal. Read the count
// from the same snapshot the API serves when the DB is down, so the assertion
// stays correct after a rebuild rather than depending on a hard-coded total.
const snapshotFC = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'api', 'buildings.json'), 'utf-8'),
);
const BUILDING_COUNT = snapshotFC.features.length;

const errors = [];
const shot = async (page, name) => {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`  shot -> ${name}.png`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whole-page text. Robust to layout changes in a way a class selector is not. */
const panelText = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

const statusText = panelText;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--window-size=1680,950',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-sandbox',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('requestfailed', (r) =>
    errors.push(`REQFAIL ${r.url().slice(0, 120)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });

  // The status bar only reports the real count once /api/buildings has
  // resolved and the scene is live, so it doubles as the readiness signal.
  // We wait for the EXACT count (not just any number) so we don't proceed
  // while the status bar is still in its "0 3D buildings" initial state.
  // Headless Chrome with software WebGL can take several minutes to bring
  // the Cesium globe up; the timeout is generous on purpose.
  await page.waitForFunction(
    (expected) => new RegExp(`${expected} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 },
    BUILDING_COUNT,
  );
  await sleep(8000); // let terrain sampling + the first frames settle

  // ---------------------------------------------------------------- CITY
  console.log('\n[1] CITY');
  const status = await statusText(page);
  check(
    'status bar reports buildings',
    new RegExp(`${BUILDING_COUNT} 3D buildings`).test(status),
    status.slice(0, 90),
  );
  check('AOI named', /Siripuram/.test(status));
  await shot(page, '1-city');

  // -------------------------------------------------------------- BUILDING
  // Select through the search box: a canvas pick would depend on where a
  // footprint happens to land, which makes the test flaky for no benefit.
  console.log('\n[2] BUILDING');
  await page.click('input[placeholder*="Search"]');
  await page.type('input[placeholder*="Search"]', 'AP-VSP-3D26-0001');
  await sleep(900);
  const gotHit = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /AP-VSP-3D26-0001/.test(b.innerText),
    );
    if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return Boolean(btn);
  });
  check('search returned a result', gotHit);
  await sleep(4500); // 1.5 s flight + fade
  let panel = await panelText(page);
  // The ULPIN card splits the identifier into labelled segments, so innerText
  // shows "AP VSP 3D26 0001 001"; the parent-parcel row carries the plain form.
  check('detail panel shows building ULPIN',
    /AP-VSP-3D26-0001/.test(panel) && /parcel 1 . building 1/.test(panel));
  check('provenance line present', /Provenance/i.test(panel));
  check('ULPIN disclaimer present', /Not an official government identifier/i.test(panel));
  await shot(page, '2-building');

  // ------------------------------------------------------------- EXPLODE
  console.log('\n[3] EXPLODE');
  const moved = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type=range]')];
    if (inputs.length === 0) return false;
    const el = inputs[0];
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '70');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  check('explode slider moved', moved);
  await sleep(1600);
  await shot(page, '3-explode');

  // --------------------------------------------------------------- FLOOR
  console.log('\n[4] FLOOR');
  const rung = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) =>
      /^(G|[0-9]{1,2}|B[0-9])$/.test(b.innerText.trim()),
    );
    const g = btns.find((b) => b.innerText.trim() === '2') ?? btns[0];
    if (g) g.click();
    return g ? g.innerText.trim() : null;
  });
  check('floor ladder rung clicked', rung !== null, `rung ${rung}`);
  await sleep(3200);
  panel = await panelText(page);
  check('panel switched to floor', /Level|Floor level|Basement level/i.test(panel));
  await shot(page, '4-floor');

  // ---------------------------------------------------------------- UNIT
  // Units only exist once a floor is isolated; pick one via a canvas click at
  // the centre of the viewport, where the isolated slab now sits.
  console.log('\n[5] UNIT');
  const candidates = [
    [840, 440], [840, 500], [760, 470], [920, 470], [840, 400],
    [700, 500], [980, 500], [840, 560],
  ];
  let unitOk = false;
  let hitAt = null;
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y);
    await sleep(1400);
    panel = await panelText(page);
    if (/Titled unit|Carpet area/i.test(panel)) {
      unitOk = true;
      hitAt = `${x},${y}`;
      break;
    }
  }
  check('unit selected by canvas pick', unitOk, unitOk ? `at ${hitAt}` : 'no unit hit');
  if (unitOk) {
    check('tenure shown', /Tenure/i.test(panel));
    check('encumbrance shown', /Encumbrance/i.test(panel));
    check('z extent shown', /Z extent/i.test(panel));
  }
  await shot(page, '5-unit');

  // --------------------------------------------------------- UNDERGROUND
  console.log('\n[6] UNDERGROUND');
  const ug = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.innerText.trim() === 'Underground',
    );
    if (b) b.click();
    return Boolean(b);
  });
  check('underground toggled', ug);
  await sleep(4500);
  const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  check('conflict banner names a conflict', /utility\/basement conflict/i.test(body));
  check('conflict count is real', /1[0-9] utility\/basement conflict|[1-9] utility\/basement conflict/.test(body));
  check('utility legend shown', /Utility corridors/i.test(body));
  check('ST_3DIntersects credited', /ST_3DIntersects/i.test(body));
  await shot(page, '6-underground');

  // -------------------------------------------------------- disabled controls
  console.log('\n[7] DISABLED CONTROLS');
  const disabled = await page.evaluate(() =>
    [...document.querySelectorAll('button[disabled]')].map((b) => b.innerText.trim()),
  );
  for (const label of ['Measurements', 'Share', 'Split', 'Slice']) {
    check(`${label} rendered disabled`, disabled.includes(label), disabled.join(','));
  }

  // ------------------------------------------------------------- console
  console.log('\n[8] CONSOLE');
  const real = errors.filter(
    // Third-party tile hosts are excluded: a transient 4xx/timeout from a
    // basemap CDN is a network condition, not an app error, and the imagery
    // registry already falls back to CARTO when one is genuinely down.
    (e) =>
      !/favicon|ERR_INTERNET_DISCONNECTED|tile\.openstreetmap|openstreetmap\.org/i.test(e)
      && !/arcgisonline\.com|maptiles\.arcgis\.com|cartocdn\.com|api\.mapbox\.com/i.test(e),
  );
  check('no runtime errors', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
