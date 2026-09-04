/**
 * Which layer costs the frame?
 *
 * Loads the scene, then measures frame times during an identical scripted
 * orbit drag with each data source hidden in turn. `ds.show = false` skips the
 * layer's rendering and its per-frame property evaluation without changing
 * anything else, so the difference between "all on" and "one off" is that
 * layer's real cost -- measured, not reasoned about.
 *
 * Needs the viewer seam: build with NEXT_PUBLIC_ULPIN_PROBE=1.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// `/` is the project GALLERY on this branch; the scene lives at /p/<slug>.
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const URL = process.env.ULPIN_URL ?? `http://localhost:3000/p/${SLUG}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-background-timer-throttling'],
  defaultViewport: { width: 1680, height: 950 },
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(Number(process.env.ULPIN_SETTLE ?? 14000));

const has = await page.evaluate(() => Boolean(window.__ulpinViewer));
if (!has) {
  console.error('no viewer seam: rebuild with NEXT_PUBLIC_ULPIN_PROBE=1');
  await browser.close();
  process.exit(1);
}

const names = await page.evaluate(() => {
  const v = window.__ulpinViewer;
  const out = [];
  for (let i = 0; i < v.dataSources.length; i++) {
    out.push({ name: v.dataSources.get(i).name, n: v.dataSources.get(i).entities.values.length });
  }
  return out;
});

async function drag() {
  await page.evaluate(() => {
    window.__f = [];
    window.__stop = false;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      window.__f.push(now - last);
      last = now;
      if (!window.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(840, 475);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(840 + i * 7, 475 + Math.sin(i / 4) * 35);
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(300);
  return page.evaluate(() => {
    window.__stop = true;
    const f = window.__f.filter((x) => x > 0 && x < 2000).sort((a, b) => a - b);
    if (!f.length) return null;
    return {
      medianMs: Number(f[f.length >> 1].toFixed(1)),
      fps: Number((1000 / f[f.length >> 1]).toFixed(1)),
    };
  });
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
  await sleep(700);
}

const rows = [];
rows.push(['all layers on', await drag()]);

for (const { name, n } of names) {
  await setShow(name, false);
  rows.push([`${name} hidden (${n} entities)`, await drag()]);
  await setShow(name, true);
}

await setShow('*', false);
rows.push(['all data sources hidden (globe + imagery only)', await drag()]);
await setShow('*', true);

// Globe off as well: what is left is Cesium's fixed per-frame cost.
await page.evaluate(() => {
  const v = window.__ulpinViewer;
  for (let i = 0; i < v.dataSources.length; i++) v.dataSources.get(i).show = false;
  v.scene.globe.show = false;
  v.scene.requestRender();
});
await sleep(700);
rows.push(['everything hidden', await drag()]);

console.log('\nlayer'.padEnd(52), 'median ms', ' fps');
for (const [label, r] of rows) {
  console.log(label.padEnd(52), String(r?.medianMs ?? '-').padStart(9), String(r?.fps ?? '-').padStart(5));
}
await browser.close();
