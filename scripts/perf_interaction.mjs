/**
 * Does it FEEL fast? Interaction latency, measured end to end.
 *
 * The startup probe answers "when can I touch it". This one answers the other
 * half of the brief -- "open the map, interact immediately, move around
 * smoothly, click a building, details appear quickly" -- by timing the things
 * a user actually waits for, on a scene that has fully settled:
 *
 *   1. click -> the detail panel shows that building's ULPIN
 *   2. click -> the same, warm (the document is now client-cached)
 *   3. hover -> the tooltip appears
 *   4. drag  -> input responsiveness DURING a camera orbit
 *   5. layer toggle -> the scene reflects it
 *
 * WHY NOT FPS. Headless Chrome software-rasterises; its floor is ~90 ms/frame
 * with nothing drawn at all, so a frame-rate number here says more about the
 * rasteriser than about the application. What IS portable is how long the main
 * thread is blocked, because a blocked main thread is what makes a page feel
 * stuck on any GPU. So "smoothness" is reported as the longest main-thread task
 * observed during a drag, plus how long the page took to acknowledge input --
 * the same quantity the INP metric is built on.
 *
 * Run against a settled production build:
 *   NEXT_PUBLIC_ULPIN_PROBE=1 npm run build && npm start
 *   node scripts/perf_interaction.mjs               # siripuram
 *   ULPIN_SLUG=hyderabad-banjara node scripts/perf_interaction.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ORIGIN = process.env.ULPIN_ORIGIN ?? 'http://localhost:3000';
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const URL = process.env.ULPIN_URL ?? `${ORIGIN}/p/${SLUG}`;
const SETTLE = Number(process.env.ULPIN_SETTLE ?? 25000);

const argv = process.argv.slice(2);
let outDir = path.join(process.cwd(), 'docs', 'perf');
let label = `interaction-${SLUG}`;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
  else if (argv[i] === '--label') label = argv[++i];
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding'],
  defaultViewport: { width: 1680, height: 950 },
  protocolTimeout: 240000,
});
const page = await browser.newPage();

// Long tasks are collected for the whole session and sliced by window below,
// so each interaction can report the blocking that happened during IT.
await page.evaluateOnNewDocument(() => {
  window.__tasks = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__tasks.push({ start: e.startTime, dur: e.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => Boolean(document.querySelector('canvas')),
  { timeout: 90000, polling: 50 });
// Settle fully: this probe is about a warm, finished scene, not about boot.
await sleep(SETTLE);

const hasSeam = await page.evaluate(() => Boolean(window.__ulpinViewer));
if (!hasSeam) {
  console.error('no viewer seam: rebuild with NEXT_PUBLIC_ULPIN_PROBE=1');
  await browser.close();
  process.exit(1);
}

/** Long-task stats inside a [from, to] window of performance.now(). */
async function blockingIn(from, to) {
  return page.evaluate(([a, b]) => {
    const inWin = window.__tasks.filter((t) => t.start >= a && t.start <= b);
    return {
      count: inWin.length,
      longestMs: Math.round(inWin.reduce((m, t) => Math.max(m, t.dur), 0)),
      totalBlockingMs: Math.round(
        inWin.reduce((s, t) => s + Math.max(0, t.dur - 50), 0),
      ),
    };
  }, [from, to]);
}

const now = () => page.evaluate(() => performance.now());

/**
 * Canvas coordinates of a building footprint that is on screen, plus its id.
 * Asking the scene beats guessing a pixel: a miss would time a click on ground.
 */
async function pickTarget(skipIds = []) {
  return page.evaluate((skip) => {
    const v = window.__ulpinViewer;
    const t = v.clock.currentTime;
    const tagOf = (o) => {
      if (!o || typeof o !== 'object') return null;
      const id = o.id;
      const e = (id && typeof id === 'object') ? id : o;
      return e.tag ?? null;
    };

    // VERIFY, do not assume. A footprint's projected centroid is only a
    // reliable click target when the building is large on screen. Framed on a
    // 2,213-building ward the footprints are a few pixels across, the centroid
    // can land between rendered fragments or behind terrain, and the click
    // silently hits nothing -- which shows up as a 30 s timeout on an
    // assertion that is really about the probe, not the application.
    //
    // So each candidate is confirmed with a real scene.pick before it is
    // returned, and enough candidates are tried to find one that lands.
    let tried = 0;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (!ds.name.startsWith('buildings')) continue;
      for (const e of ds.entities.values) {
        if (e.tag?.kind !== 'building') continue;
        if (skip.includes(e.tag.id)) continue;
        const h = e.polygon?.hierarchy?.getValue(t);
        const pos = h?.positions ?? [];
        if (!pos.length) continue;
        let sx = 0; let sy = 0; let n = 0;
        for (const p of pos) {
          const w = v.scene.cartesianToCanvasCoordinates(p);
          if (!w || !Number.isFinite(w.x)) continue;
          sx += w.x; sy += w.y; n += 1;
        }
        if (!n) continue;
        const x = Math.round(sx / n); const y = Math.round(sy / n);
        if (x < 460 || x > 1220 || y < 160 || y > 760) continue;
        if (tried++ > 400) return null;   // bound the work, not the search
        const tag = tagOf(v.scene.pick({ x, y }));
        if (tag && tag.kind === 'building' && !skip.includes(tag.id)) {
          return { x, y, id: tag.id };
        }
      }
    }
    return null;
  }, skipIds);
}

/**
 * Click a building and time until the panel names THAT building.
 *
 * The wait is on a full ULPIN code that was not on the page before the click.
 * Matching the bare word "ULPIN" would have been satisfied instantly and
 * always -- the application is titled "3D ULPIN Vertical Property Mapper", so
 * the string is in the DOM before anything is selected. This asks for a
 * newly-appeared identifier of the form AP-VSP-3D26-0002-001, which only the
 * detail panel produces.
 */
// Character classes, not \d: this pattern lives in a single-quoted JS string
// and is handed to `new RegExp` inside the page, where '\d' would have been
// collapsed by the string literal to a plain 'd' and matched nothing. Costs
// nothing to spell out and cannot silently rot.
const ULPIN_RE = '[A-Z]{2}-[A-Z]{3}-[A-Z0-9]{4}-[0-9]{4}-[0-9]{3}';

async function ulpinsOnPage() {
  return page.evaluate((re) => {
    const found = document.body.innerText.match(new RegExp(re, 'g')) ?? [];
    return [...new Set(found)];
  }, ULPIN_RE);
}

/**
 * `skipIds` rather than a fixed point, because the target has to be located
 * AFTER the camera has returned to the city view. "Back to city" does not
 * restore the exact opening pose, so screen coordinates captured before a
 * selection no longer sit on the same footprint afterwards -- clicking them
 * lands on bare ground and nothing is selected.
 */
async function timeSelection(skipIds = []) {
  await resetToCity();
  const target = await pickTarget(skipIds);
  if (!target) return { ok: false, ms: null, window: [0, 0], target: null };
  const t0 = await now();
  await page.mouse.click(target.x, target.y);
  // The panel is empty of identifiers after the reset above, so "a full ULPIN
  // is on the page" is exactly "this building's details have rendered".
  const ok = await page
    .waitForFunction((re) => new RegExp(re).test(document.body.innerText),
      { timeout: 30000, polling: 20 }, ULPIN_RE)
    .then(() => true)
    .catch(() => false);
  const t1 = await now();
  return { ok, ms: Math.round(t1 - t0), window: [t0, t1], target };
}

const results = {};

/**
 * Back to the city view.
 *
 * The button is labelled "Reset view" -- the same one scripts/verify_ui.mjs
 * uses. Getting this wrong does not fail loudly, it just leaves the scene in
 * building mode, where the tooltip does not render at all; that is what made
 * an earlier version of this probe report a working tooltip as missing.
 */
async function resetToCity() {
  // The control is labelled "Back to city" in the full layout and "Reset view"
  // elsewhere; accept either. Getting this wrong does not fail loudly, it
  // leaves the previous building selected -- which made an earlier version of
  // this probe wait 30 s for a ULPIN that was already on the page.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /^(Back to city|Reset view)$/.test(x.innerText.trim()));
    if (b) b.click();
  });
  // Wait for the panel to actually let go of the selection rather than for a
  // fixed delay: that is the state the measurement below assumes.
  await page
    .waitForFunction((re) => !new RegExp(re).test(document.body.innerText),
      { timeout: 8000, polling: 50 }, ULPIN_RE)
    .catch(() => {});
  await sleep(1200);
}

// ---- 1 + 2: selection latency, cold then warm ---------------------------
const cold = await timeSelection();
if (!cold.target) {
  console.error('no footprint on screen to click');
  await browser.close();
  process.exit(1);
}
results.selectColdMs = cold.ms;
results.selectColdBlocking = await blockingIn(...cold.window);

// The SAME building again: its document is now in the client LRU, so this
// isolates the cache from the network.
await sleep(1200);
const warm = await timeSelection();
results.selectWarmMs = warm.ms;
results.selectWarmBlocking = await blockingIn(...warm.window);

// A DIFFERENT building, so the cold path is shown to be repeatable rather than
// a property of whichever one the hot-building warmer had already loaded.
await sleep(1200);
const other = await timeSelection(cold.target ? [cold.target.id] : []);
results.selectOtherMs = other.ms;

// ---- 3: hover -> tooltip -------------------------------------------------
// The tooltip is a CITY-VIEW surface, so the scene has to be back in city mode
// first -- and a footprint's screen position is not fixed, so candidate points
// are swept the way scripts/verify_ui.mjs sweeps them rather than assuming one
// pixel lands on a building.
await resetToCity();
const hoverPoints = [
  [840, 470], [760, 430], [920, 510], [700, 470], [980, 430],
  [840, 380], [640, 520], [1040, 470],
];
await page.mouse.move(10, 10);
await sleep(300);
for (const [x, y] of hoverPoints) {
  const h0 = await now();
  await page.mouse.move(x, y);
  const shown = await page
    .waitForFunction(() => /storeys ·/.test(document.body.innerText),
      { timeout: 2500, polling: 20 })
    .then(() => true)
    .catch(() => false);
  if (shown) {
    results.hoverTooltipMs = Math.round((await now()) - h0);
    break;
  }
  await page.mouse.move(10, 10);
  await sleep(200);
}
if (results.hoverTooltipMs === undefined) results.hoverTooltipMs = null;

// ---- 4: responsiveness DURING a drag ------------------------------------
const d0 = await now();
await page.mouse.move(840, 470);
await page.mouse.down();
for (let i = 0; i < 45; i++) {
  await page.mouse.move(840 + i * 6, 470 + Math.sin(i / 5) * 40);
  await sleep(16);
}
await page.mouse.up();
await sleep(500);
const d1 = await now();
results.dragBlocking = await blockingIn(d0, d1);
results.dragDurationMs = Math.round(d1 - d0);

// ---- 5: layer toggle -> scene follows ------------------------------------
const t0 = await now();
const toggled = await page.evaluate(() => {
  // The handler sits on the <span> inside the <label>, not on the label: a
  // click on the label element itself bubbles upward and toggles nothing.
  const el = [...document.querySelectorAll('label span')]
    .find((x) => x.textContent.trim() === 'Surface parcels');
  if (!el) return false;
  el.click();
  return true;
});
let toggleMs = null;
if (toggled) {
  const applied = await page
    .waitForFunction(() => {
      const v = window.__ulpinViewer;
      for (let i = 0; i < v.dataSources.length; i++) {
        const ds = v.dataSources.get(i);
        if (ds.name.startsWith('parcels') && ds.show === false) return true;
      }
      return false;
    }, { timeout: 8000, polling: 20 })
    .then(() => true)
    .catch(() => false);
  const t1 = await now();
  toggleMs = applied ? Math.round(t1 - t0) : null;
}
results.layerToggleMs = toggleMs;

// ---- scene size, for context --------------------------------------------
results.scene = await page.evaluate(() => {
  const v = window.__ulpinViewer;
  let entities = 0;
  let sources = 0;
  for (let i = 0; i < v.dataSources.length; i++) {
    entities += v.dataSources.get(i).entities.values.length;
    sources += 1;
  }
  return { entities, dataSources: sources };
});

const report = { label, slug: SLUG, url: URL, at: new Date().toISOString(), ...results };
writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(report, null, 2));

const row = (k, v) => console.log(`  ${String(k).padEnd(34)} ${v}`);
console.log(`\ninteraction latency — ${SLUG} (${results.scene.entities} entities)`);
row('click -> details (cold)', `${results.selectColdMs} ms`);
row('click -> details (warm cache)', `${results.selectWarmMs} ms`);
if (results.selectOtherMs != null) row('click -> details (another building)', `${results.selectOtherMs} ms`);
row('hover -> tooltip', results.hoverTooltipMs == null ? 'not shown' : `${results.hoverTooltipMs} ms`);
row('layer toggle -> scene', results.layerToggleMs == null ? 'n/a' : `${results.layerToggleMs} ms`);
console.log('\nmain-thread blocking during a 45-step orbit drag');
row('drag duration', `${results.dragDurationMs} ms`);
row('long tasks during drag', results.dragBlocking.count);
row('longest task during drag', `${results.dragBlocking.longestMs} ms`);
row('total blocking during drag', `${results.dragBlocking.totalBlockingMs} ms`);
console.log(`\nwritten: ${path.join(outDir, `${label}.json`)}`);

await browser.close();
