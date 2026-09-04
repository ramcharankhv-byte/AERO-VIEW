/**
 * Startup performance probe.
 *
 * Loads the app in a real Chrome, cold (no HTTP cache), and reports the numbers
 * a startup budget is actually written against:
 *
 *   - network: request count and transferred bytes, split by category
 *   - paint:   FCP, LCP, first canvas
 *   - CPU:     long tasks, total blocking time, the worst single task
 *   - boot:    the ulpin:* marks emitted by lib/boot-marks.ts
 *   - scene:   entity/primitive counts once the scene settles
 *   - motion:  frame times during a scripted orbit drag
 *   - memory:  JS heap after settle, and again after select/deselect cycles
 *
 * Run against a PRODUCTION build -- dev-mode module splitting invents hundreds
 * of requests no user ever sees:
 *
 *   NEXT_PUBLIC_ULPIN_PROBE=1 npm run build
 *   npm start
 *   node scripts/perf_probe.mjs --label before --out docs/perf
 *
 * The `scene` block needs the viewer seam, which is what the build flag opens;
 * without it every other block still reports.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// `/` is the project GALLERY on this branch; the scene lives at /p/<slug>.
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const URL = process.env.ULPIN_URL ?? `http://localhost:3000/p/${SLUG}`;

const argv = process.argv.slice(2);
let label = 'run';
let outDir = path.join(process.cwd(), 'docs', 'perf');
let settleMs = Number(process.env.ULPIN_SETTLE ?? 12000);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--label') label = argv[++i];
  else if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
  else if (argv[i] === '--settle') settleMs = Number(argv[++i]);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bucket a URL into the category a startup budget cares about. */
function categorise(url, type) {
  if (url.includes('/api/')) return 'app-api';
  if (url.includes('/cesium/Workers/') || url.includes('/cesium/ThirdParty/')) {
    return 'cesium-worker';
  }
  if (url.includes('/cesium/Assets/') || url.includes('/cesium/Widgets/')) {
    return 'cesium-asset';
  }
  if (url.includes('cesium.com') || url.includes('cesiumjs.org')) return 'ion';
  if (url.includes('arcgisonline') || url.includes('basemaps.cartocdn')
      || url.includes('tile.openstreetmap')) {
    return 'imagery-tiles';
  }
  if (type === 'Script' || url.endsWith('.js')) return 'app-js';
  if (type === 'Stylesheet' || url.endsWith('.css')) return 'css';
  if (type === 'Document') return 'document';
  return type ? String(type).toLowerCase() : 'other';
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--window-size=1680,950',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Network.enable');
await client.send('Network.setCacheDisabled', { cacheDisabled: true });
await client.send('Performance.enable');

/** requestId -> record, from CDP so redirects and failures are honest. */
const requests = new Map();
client.on('Network.requestWillBeSent', (e) => {
  requests.set(e.requestId, {
    url: e.request.url,
    type: e.type,
    startMs: e.timestamp * 1000,
    transferred: 0,
    status: null,
  });
});
client.on('Network.responseReceived', (e) => {
  const r = requests.get(e.requestId);
  if (r) {
    r.status = e.response.status;
    r.type = e.type ?? r.type;
  }
});
client.on('Network.loadingFinished', (e) => {
  const r = requests.get(e.requestId);
  if (r) r.transferred = e.encodedDataLength ?? 0;
});
client.on('Network.loadingFailed', (e) => {
  const r = requests.get(e.requestId);
  if (r) r.failed = true;
});

// Observers have to exist before the document's own scripts run.
await page.evaluateOnNewDocument(() => {
  window.__probe = { longTasks: [], lcp: 0, fcp: 0 };
  const observe = (type, fn) => {
    try {
      new PerformanceObserver((l) => l.getEntries().forEach(fn))
        .observe({ type, buffered: true });
    } catch {
      /* unsupported entry type; that block simply reports zero */
    }
  };
  observe('longtask', (e) => {
    window.__probe.longTasks.push({ start: e.startTime, dur: e.duration });
  });
  observe('largest-contentful-paint', (e) => { window.__probe.lcp = e.startTime; });
  observe('paint', (e) => {
    if (e.name === 'first-contentful-paint') window.__probe.fcp = e.startTime;
  });
});

const wallStart = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

/** Canvas present = a drag would do something. The user's "map is alive" moment. */
const canvasAt = await page
  .waitForFunction(
    () => (document.querySelector('canvas') ? performance.now() : false),
    { timeout: 60000, polling: 50 },
  )
  .then((h) => h.jsonValue())
  .catch(() => null);

await sleep(settleMs);

const marks = await page.evaluate(() => Object.fromEntries(
  performance.getEntriesByType('mark')
    .filter((m) => m.name.startsWith('ulpin:'))
    .map((m) => [m.name.slice(6), Math.round(m.startTime)]),
));

const probe = await page.evaluate(() => window.__probe);
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  return n
    ? { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd }
    : null;
});

const scene = await page.evaluate(() => {
  const v = window.__ulpinViewer;
  if (!v) return null;
  let entities = 0;
  const byName = {};
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    // Bucketed layers report as one row: buildings#3 counts as buildings.
    const group = ds.name.split('#')[0];
    byName[group] = (byName[group] ?? 0) + ds.entities.values.length;
    entities += ds.entities.values.length;
  }
  return {
    entities,
    byDataSource: byName,
    primitives: v.scene.primitives.length,
    imageryLayers: v.scene.imageryLayers.length,
  };
});

/** Frame times during a scripted orbit drag: the "does it feel smooth" number. */
async function measureMotion() {
  await page.evaluate(() => {
    window.__frames = [];
    window.__stopFrames = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      window.__frames.push(now - last);
      last = now;
      if (!window.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const ox = 840;
  const oy = 475;
  await page.mouse.move(ox, oy);
  await page.mouse.down();
  for (let i = 0; i < 40; i++) {
    await page.mouse.move(ox + i * 6, oy + Math.sin(i / 5) * 40);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(400);
  return page.evaluate(() => {
    window.__stopFrames = true;
    const f = window.__frames.filter((x) => x > 0 && x < 1000).sort((a, b) => a - b);
    if (f.length === 0) return null;
    const at = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    return {
      frames: f.length,
      medianMs: Number(at(0.5).toFixed(1)),
      p95Ms: Number(at(0.95).toFixed(1)),
      worstMs: Number(f[f.length - 1].toFixed(1)),
      fpsMedian: Number((1000 / at(0.5)).toFixed(1)),
    };
  });
}
const motion = await measureMotion();

const settleMetrics = await client.send('Performance.getMetrics');
const heapAfterSettle =
  settleMetrics.metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;

/**
 * Select and deselect five times, then re-read the heap. A number that climbs
 * every cycle is the signature of layer teardown leaking.
 */
async function selectCycles() {
  const before = requests.size;
  for (let i = 0; i < 5; i++) {
    await page.mouse.click(760 + i * 14, 520);
    await sleep(900);
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  await sleep(1500);
  const m = (await client.send('Performance.getMetrics')).metrics;
  const get = (n) => m.find((x) => x.name === n)?.value ?? 0;
  return {
    requestsAdded: requests.size - before,
    heapBytes: get('JSHeapUsedSize'),
    scriptSeconds: get('ScriptDuration'),
    taskSeconds: get('TaskDuration'),
  };
}
const cycle = await selectCycles();

// ---- aggregate the network log -------------------------------------------
const startupWindow = marks['context-ready'] ?? 20000;
const cats = new Map();
const seen = new Map();
let totalN = 0;
let totalBytes = 0;
for (const r of requests.values()) {
  const c = categorise(r.url, r.type);
  const e = cats.get(c) ?? { n: 0, bytes: 0 };
  e.n += 1;
  e.bytes += r.transferred;
  cats.set(c, e);
  totalN += 1;
  totalBytes += r.transferred;
  seen.set(r.url, (seen.get(r.url) ?? 0) + 1);
}
const duplicated = [...seen.entries()]
  .filter(([, n]) => n > 1)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([url, n]) => ({ n, url: url.slice(0, 120) }));

const startupRequests = [...requests.values()]
  .filter((r) => r.startMs > 0).length;

const longTasks = probe.longTasks ?? [];
const tbt = longTasks.reduce((a, t) => a + Math.max(0, t.dur - 50), 0);

const report = {
  label,
  at: new Date().toISOString(),
  url: URL,
  paint: {
    fcpMs: Math.round(probe.fcp),
    lcpMs: Math.round(probe.lcp),
    domContentLoadedMs: nav ? Math.round(nav.domContentLoaded) : null,
    canvasPresentMs: canvasAt ? Math.round(canvasAt) : null,
  },
  boot: marks,
  cpu: {
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTasks.reduce((a, t) => a + t.dur, 0)),
    worstLongTaskMs: Math.round(longTasks.reduce((a, t) => Math.max(a, t.dur), 0)),
    totalBlockingTimeMs: Math.round(tbt),
    longTasksBeforeReady: longTasks.filter((t) => t.start <= startupWindow).length,
    top5: longTasks.slice().sort((a, b) => b.dur - a.dur).slice(0, 5)
      .map((t) => ({ atMs: Math.round(t.start), durMs: Math.round(t.dur) })),
    scriptSeconds: Number(cycle.scriptSeconds.toFixed(2)),
    taskSeconds: Number(cycle.taskSeconds.toFixed(2)),
  },
  network: {
    totalRequests: totalN,
    startupRequests,
    totalTransferredMB: Number((totalBytes / 1e6).toFixed(2)),
    byCategory: Object.fromEntries([...cats.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, { n: v.n, kb: Math.round(v.bytes / 1024) }])),
    duplicatedUrls: duplicated,
  },
  scene,
  motion,
  memory: {
    afterSettleMB: Number((heapAfterSettle / 1e6).toFixed(1)),
    afterSelectCyclesMB: Number((cycle.heapBytes / 1e6).toFixed(1)),
    growthMB: Number(((cycle.heapBytes - heapAfterSettle) / 1e6).toFixed(1)),
    requestsAddedByCycles: cycle.requestsAdded,
  },
  wallClockMs: Date.now() - wallStart,
};

const file = path.join(outDir, `${label}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nwritten: ${file}`);

await browser.close();
