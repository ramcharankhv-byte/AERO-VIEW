/**
 * Basemap acceptance check.
 *
 * Verifies the imagery layer end to end in a real Chrome: that Esri loads and
 * neither Bing nor Google is touched, that switching provider preserves the
 * camera, that gisDark is the default and is measurably darker than natural,
 * that killing the Esri endpoint falls back to CARTO with a warning, and that
 * the attribution container is actually on screen.
 *
 * Companion to check_ion.mjs, which does the same job for terrain.
 *
 * Usage: node scripts/check_basemap.mjs [outDir]
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

const snapshotFC = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'), 'utf-8'),
);
const BUILDING_COUNT = snapshotFC.features.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** The scene is live once the status bar reports the real building count. */
async function waitForScene(page) {
  await page.waitForFunction(
    (expected) => new RegExp(`${expected} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 },
    BUILDING_COUNT,
  );
  await sleep(8000); // terrain sampling + first tiles
}

/**
 * Mean luminance of the lower-left quadrant of a screenshot.
 *
 * That region is ground rather than sky, which is what the treatment acts on.
 * Read straight off a raw RGBA capture so no PNG decoder is needed.
 */
async function groundLuma(page) {
  const { width, height } = page.viewport();
  const buf = await page.screenshot({
    clip: { x: 0, y: Math.round(height * 0.55), width: Math.round(width * 0.5),
            height: Math.round(height * 0.3) },
    captureBeyondViewport: false,
  });
  // Decode via the page itself; it already has a canvas and an image decoder.
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4);
  }, buf.toString('base64'));
}

/**
 * Poll until `fn()` is truthy. Fixed sleeps are not good enough here: under
 * swiftshader the main thread stalls for seconds at a time, so a swap that
 * normally lands in one second can take fifteen.
 */
async function waitFor(fn, timeoutMs = 45000, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}

/** Wait for tile streaming to stop changing the frame, then return its luma. */
async function settle(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let prev = await groundLuma(page);
  for (;;) {
    await sleep(2500);
    const now = await groundLuma(page);
    if (Math.abs(now - prev) < 0.3 || Date.now() > deadline) return now;
    prev = now;
  }
}

/** Drive the imagery <select> the way a user would. */
async function pickProvider(page, value) {
  await page.evaluate((v) => {
    const sel = [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'esri'),
    );
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // Cesium under swiftshader blocks the main thread for long stretches while
  // terrain and the first tiles come in, which outlives the 180 s default and
  // fails CDP calls that are actually fine.
  protocolTimeout: 900000,
  args: [
    '--window-size=1680,950', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-sandbox',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  const hosts = new Map();
  const warnings = [];
  page.on('request', (r) => {
    try {
      const h = new global.URL(r.url()).host;
      hosts.set(h, (hosts.get(h) ?? 0) + 1);
    } catch { /* data: and blob: URLs */ }
  });
  // Puppeteer reports console.warn as type "warn", not "warning".
  page.on('console', (m) => {
    if (/^(warn|warning|error)$/.test(m.type())) warnings.push(m.text());
  });

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await waitForScene(page);

  // ------------------------------------------------------ [1] PROVIDER
  console.log('\n[1] ESRI, NO BING, NO GOOGLE');
  const hostList = [...hosts.keys()];
  check(
    'Esri World Imagery requested',
    hostList.some((h) => /arcgisonline\.com/i.test(h)),
    hostList.filter((h) => /arcgis/i.test(h)).join(', '),
  );
  const banned = hostList.filter((h) =>
    /virtualearth|bing\.com|google|googleapis|gstatic/i.test(h));
  check('no Bing or Google imagery hosts', banned.length === 0, banned.join(', '));

  // ------------------------------------------------------ [2] TONE
  console.log('\n[2] TONE');
  // Settle first: a screenshot taken while tiles are still streaming is a
  // picture of the loading state, not of the treatment.
  const darkLuma = await settle(page);
  await page.screenshot({ path: path.join(OUT, 'basemap-1-esri-gisdark.png') });
  // Scoped to the Tone group. The LayerPanel has more than one radiogroup now
  // (Buildings style is another), so an unscoped button[role="radio"] query
  // would report whichever happens to come first in the DOM.
  const readTone = () => page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Tone"]');
    const btn = [...group.querySelectorAll('button[role="radio"]')]
      .find((b) => b.getAttribute('aria-checked') === 'true');
    return btn ? btn.innerText.trim() : null;
  });
  check('gisDark is the default', (await readTone()) === 'GIS dark');

  await page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Tone"]');
    [...group.querySelectorAll('button[role="radio"]')]
      .find((b) => /Natural/.test(b.innerText))
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(3000);
  const naturalLuma = await settle(page);
  await page.screenshot({ path: path.join(OUT, 'basemap-2-esri-natural.png') });
  check(
    'gisDark is darker than natural',
    darkLuma < naturalLuma,
    `gisDark ${darkLuma.toFixed(1)} vs natural ${naturalLuma.toFixed(1)}`,
  );

  // back to the default before the camera test
  await page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Tone"]');
    [...group.querySelectorAll('button[role="radio"]')]
      .find((b) => /GIS dark/.test(b.innerText))
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(1500);

  // ------------------------------------------------------ [3] CAMERA
  // The camera lives in Cesium, not in the DOM, and the app exposes no handle
  // to it -- so assert on the rendered frame instead. Going esri -> carto ->
  // esri must land on a pixel-identical frame: same provider, same tone, and
  // the same camera only if nothing moved it. Any pan, zoom or re-frame during
  // the swaps would show up as a diff.
  console.log('\n[3] PROVIDER SWITCH PRESERVES CAMERA');
  const frameA = await settle(page);
  const shotA = await page.screenshot({ encoding: 'base64' });

  await pickProvider(page, 'carto');
  const gotCarto = await waitFor(
    async () => [...hosts.keys()].some((h) => /cartocdn\.com/i.test(h)));
  check('carto tiles requested after swap', gotCarto);
  const cartoLuma = await settle(page);
  await page.screenshot({ path: path.join(OUT, 'basemap-3-carto.png') });
  check('swapping actually changed the basemap', Math.abs(cartoLuma - frameA) > 0.5,
    `esri ${frameA.toFixed(1)} vs carto ${cartoLuma.toFixed(1)}`);

  await pickProvider(page, 'esri');
  await settle(page);
  const shotB = await page.screenshot({ encoding: 'base64' });
  const diff = await page.evaluate(async (a, b) => {
    const load = async (s) => {
      const img = new Image();
      img.src = `data:image/png;base64,${s}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    };
    const [x, y] = [await load(a), await load(b)];
    let sum = 0;
    for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i] - y[i]);
    return sum / (x.length / 4);
  }, shotA.toString('base64'), shotB.toString('base64'));
  // Slack for tile streaming and LOD churn, which move the number by single
  // digits. An actual camera move -- a stray flyTo or re-frame on swap, the
  // regression this guards against -- reorders the whole frame and lands an
  // order of magnitude above this.
  check('camera unchanged after round-trip swap', diff < 12,
    `mean per-pixel diff ${diff.toFixed(2)}`);

  // ------------------------------------------------------ [4] FALLBACK
  console.log('\n[4] ESRI DOWN -> CARTO FALLBACK');
  // Without this the MapServer metadata comes straight from Chrome's cache,
  // fromUrl resolves happily, and "the endpoint is dead" is never tested.
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.isInterceptResolutionHandled()) return;
    // Wrapped: this listener outlives the interception window, and resolving a
    // request once interception is off throws.
    try {
      if (/arcgisonline\.com/i.test(r.url())) r.abort();
      else r.continue();
    } catch { /* interception already torn down */ }
  });
  // [3] left the selection on esri, and re-picking the current value is a
  // no-op. Step off it first so the swap effect genuinely re-runs.
  await pickProvider(page, 'none');
  await sleep(2000);
  warnings.length = 0;
  await pickProvider(page, 'esri');
  const warned = await waitFor(
    async () => warnings.some((w) => /\[imagery\].*falling back to carto/i.test(w)));
  check('fallback warning logged', warned, warnings.slice(0, 2).join(' | '));
  check(
    'StatusBar reports the fallback',
    await waitFor(async () => page.evaluate(() => /\(fallback\)/.test(document.body.innerText))),
  );
  const stillUp = await page.evaluate(() => document.body.innerText.length > 200);
  check('app still usable after the endpoint dies', stillUp);
  await page.screenshot({ path: path.join(OUT, 'basemap-4-fallback.png') });
  // Interception stays on for the rest of the run. Turning it off here while
  // the handler above is still attached makes the next request throw.

  // ------------------------------------------------------ [5] CREDITS
  console.log('\n[5] ATTRIBUTION');
  const credit = await page.evaluate(() => {
    const el = document.querySelector('.cesium-viewer-bottom');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      display: cs.display, visible: r.width > 0 && r.height > 0,
      left: r.left, bottom: window.innerHeight - r.bottom,
      text: el.innerText.trim().slice(0, 120),
    };
  });
  check('credit container exists and is displayed',
    Boolean(credit) && credit.display !== 'none' && credit.visible,
    JSON.stringify(credit));
  check('credits sit bottom-left',
    Boolean(credit) && credit.left < 400 && credit.bottom < 200,
    credit ? `left ${credit.left.toFixed(0)} bottom ${credit.bottom.toFixed(0)}` : '');

  // Cesium collapses per-source attribution behind a "Data attribution" link.
  // Expand it: the licence obligation is that the Esri/CARTO/OSM names are
  // actually reachable, not merely that a credit box exists.
  const expanded = await page.evaluate(() => {
    const link = [...document.querySelectorAll('.cesium-widget-credits a, .cesium-credit-expand-link')]
      .find((a) => /attribution/i.test(a.textContent ?? ''));
    if (link) link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.body.innerText;
  });
  check('source attribution reachable',
    /Esri|Maxar|CARTO|OpenStreetMap/i.test(expanded),
    (expanded.match(/(Esri|Maxar|CARTO|OpenStreetMap)[^\n]{0,40}/i) ?? [''])[0]);
  await page.screenshot({ path: path.join(OUT, 'basemap-5-credits.png') });

  console.log(
    `\n${failures === 0 ? 'ALL BASEMAP CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  );
  console.log(`shots -> ${OUT}`);
} finally {
  await browser.close();
}

process.exit(failures === 0 ? 0 : 1);
