/**
 * How much MAIN-THREAD JAVASCRIPT does one rendered frame cost, per layer?
 *
 * Frame RATE in a headless browser is meaningless -- it software-rasterises,
 * so the floor is ~90 ms/frame regardless of what is drawn. Main-thread script
 * time is not: it is the same work on any GPU, and it is what competes with
 * React, with input handling and with the compositor. It is also exactly what
 * a CallbackProperty costs, because a non-constant material property is
 * re-evaluated by Cesium's geometry batch on every rendered frame.
 *
 * Method: force a fixed number of renders with `scene.requestRender()` and read
 * CDP's `ScriptDuration` counter either side. Repeat with each data source
 * hidden -- a hidden collection is dropped from the geometry batches, so its
 * properties stop being evaluated.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// `/` is the project GALLERY on this branch; the scene lives at /p/<slug>.
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const URL = process.env.ULPIN_URL ?? `http://localhost:3000/p/${SLUG}`;
const FRAMES = 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1680, height: 950 },
});
const page = await browser.newPage();
const client = await page.createCDPSession();
await client.send('Performance.enable');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(Number(process.env.ULPIN_SETTLE ?? 14000));

if (!(await page.evaluate(() => Boolean(window.__ulpinViewer)))) {
  console.error('no viewer seam: rebuild with NEXT_PUBLIC_ULPIN_PROBE=1');
  await browser.close();
  process.exit(1);
}

const layers = await page.evaluate(() => {
  const v = window.__ulpinViewer;
  const out = [];
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    const group = ds.name.split('#')[0];
    const row = out.find((r) => r.name === group);
    if (row) row.n += ds.entities.values.length;
    else out.push({ name: group, n: ds.entities.values.length });
  }
  return out;
});

const script = async () => (await client.send('Performance.getMetrics')).metrics
  .find((m) => m.name === 'ScriptDuration').value;

/**
 * Nudge the camera a hair between frames so requestRenderMode cannot decide
 * nothing changed; without it the scene renders once and the rest are skipped.
 */
async function renderFrames() {
  await page.evaluate(async (n) => {
    const v = window.__ulpinViewer;
    for (let i = 0; i < n; i++) {
      v.camera.rotateRight(0.00002);
      v.scene.requestRender();
      await new Promise((r) => requestAnimationFrame(r));
    }
  }, FRAMES);
}

async function measure(label) {
  await renderFrames();               // warm
  const a = await script();
  await renderFrames();
  const b = await script();
  return { label, msPerFrame: Number((((b - a) * 1000) / FRAMES).toFixed(2)) };
}

async function setShow(name, show) {
  await page.evaluate(([n, s]) => {
    const v = window.__ulpinViewer;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (n === '*' || ds.name === n || ds.name.split('#')[0] === n) {
        ds.show = s;
      }
    }
    v.scene.requestRender();
  }, [name, show]);
  await sleep(600);
}

const rows = [await measure('overview: all layers on')];
for (const { name, n } of layers) {
  await setShow(name, false);
  rows.push(await measure(`overview: ${name} hidden (${n})`));
  await setShow(name, true);
}
await setShow('*', false);
rows.push(await measure('overview: all data sources hidden'));
await setShow('*', true);

/**
 * The same measurement from street level.
 *
 * This is the view a user actually works in, and it is where a layer batched
 * into ONE primitive spanning the whole AOI costs the most: everything outside
 * the frustum is still submitted, because the primitive as a whole is inside
 * it. Splitting a layer into a grid of data sources is what lets the renderer
 * reject those, so this row is the one that shows whether it worked.
 */
await page.evaluate(() => {
  const v = window.__ulpinViewer;
  const c = v.camera.positionCartographic;
  v.camera.setView({
    destination: window.__ulpinViewer.scene.globe.ellipsoid.cartographicToCartesian(
      new (Object.getPrototypeOf(c).constructor)(c.longitude, c.latitude, 260),
    ),
    orientation: { heading: 0.6, pitch: -0.5, roll: 0 },
  });
  v.scene.requestRender();
});
await sleep(3000);
rows.push(await measure('street level (260 m): all layers on'));
await setShow('*', false);
rows.push(await measure('street level: all data sources hidden'));

const base = rows[0].msPerFrame;
console.log('\nconfiguration'.padEnd(46), 'JS ms/frame', '  delta vs overview all-on');
for (const r of rows) {
  const d = (r.msPerFrame - base).toFixed(2);
  console.log(r.label.padEnd(46), String(r.msPerFrame).padStart(11), String(d).padStart(24));
}
await browser.close();
