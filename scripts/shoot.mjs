/**
 * Screenshot the app at one or more viewports and audit what came back.
 *
 * Two jobs, because they want the same expensive page load:
 *
 *   1. Capture a shot per viewport, for eyeballing the responsive regimes.
 *   2. Audit HUE, which now has two halves because the rule does:
 *
 *      CHROME is monochrome. Top bar, dock, panels, dashboard -- black, white
 *      and grey, with `--danger` the only sanctioned hue. Checked against the
 *      COMPUTED STYLES of the chrome elements rather than the framebuffer:
 *      the panels float over a colour scene, so no rectangle of pixels
 *      belongs to the chrome alone any more.
 *
 *      The SCENE is colour, and that is a requirement too. A basemap
 *      treatment left at saturation 0, or a texture pass that drains the
 *      buildings, is exactly the regression this used to enforce, so the
 *      framebuffer check is inverted: the frame must carry real chroma.
 *
 * Inline-styled swatches are exempt from the chrome half. They are the legend
 * and provenance keys, and they are coloured on purpose -- they render the
 * scene's palette, they do not invent one.
 *
 * GALLERY MODE (--gallery) audits the project gallery at `/` instead of a
 * project's viewer. Two of the checks above do not apply to a page with no
 * canvas on it, and pretending otherwise would mean a permanently red run that
 * everyone learns to ignore:
 *
 *   - the SCENE colour check is skipped, because there is no scene. A gallery
 *     frame is monochrome by design, which is the exact opposite of what the
 *     framebuffer test asserts.
 *   - the ATTRIBUTION check is skipped, because Cesium's credit container only
 *     exists where a Cesium viewer does. The gallery renders no map data, so
 *     it incurs no attribution obligation; the moment it did -- a basemap
 *     thumbnail, say -- this exemption would have to go with it.
 *
 * Everything that DOES apply is kept, and it is the half the gallery is being
 * asked to pass: the computed-style monochrome audit over every element inside
 * a floating panel, the viewport-overflow and collision checks, and console
 * errors.
 *
 * Usage:
 *   node scripts/shoot.mjs                       # default desktop viewport
 *   node scripts/shoot.mjs 390x844 834x1112      # named sizes
 *   node scripts/shoot.mjs --out docs/shots/rwd  # output directory
 *   node scripts/shoot.mjs --gallery             # audit / instead of a viewer
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/**
 * The viewer, for the demo project.
 *
 * `/` is the project gallery now, so the default target is the demo project's
 * own page. Override with ULPIN_URL to point at another project or another
 * port; the unscoped /api/... endpoints this script fetches are aliases onto
 * the same project, so nothing else here had to change.
 */
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';

const argv = process.argv.slice(2);
let OUT = path.join(process.cwd(), 'docs', 'shots', 'rwd');
let GALLERY = false;
const sizes = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') { OUT = path.resolve(argv[++i]); continue; }
  if (argv[i] === '--gallery') { GALLERY = true; continue; }
  const m = /^(\d+)x(\d+)$/.exec(argv[i]);
  if (m) sizes.push({ width: +m[1], height: +m[2] });
}
if (GALLERY && OUT.endsWith('rwd')) OUT = path.join(path.dirname(OUT), 'rwd-gallery');
if (sizes.length === 0) sizes.push({ width: 1680, height: 950 });

mkdirSync(OUT, { recursive: true });

const BUILDING_COUNT = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'), 'utf-8'),
).features.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long to let the scene settle before the shot, ms. */
const SETTLE = Number(process.env.ULPIN_SETTLE ?? 7000);

/**
 * Chroma of an sRGB triple, 0-255. Uses max-minus-min rather than a proper
 * HSL saturation because it is the quantity that actually matters here: how
 * far the pixel is from r === g === b, which is the monochrome rule verbatim.
 */
const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

/** Is this the one sanctioned hue? #EF4444 and its blends toward the panel. */
function isDangerRed(r, g, b) {
  return r > g && r > b && Math.abs(g - b) <= 26 && r - Math.max(g, b) >= 12;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-sandbox',
  ],
});

let failures = 0;
try {
  for (const size of sizes) {
    const label = `${size.width}x${size.height}`;
    console.log(`\n=== ${label}${GALLERY ? ' (gallery)' : ''} ===`);
    const page = await browser.newPage();
    await page.setViewport({ ...size, deviceScaleFactor: 1 });

    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`PAGEERROR ${String(e)}`));

    // Origin of URL, plus '/'. Built with a regex rather than `new URL`
    // because the module-level `URL` const shadows the global constructor.
    const target = GALLERY ? URL.replace(/^(https?:\/\/[^/]+).*$/, '$1/') : URL;
    await page.goto(target, { waitUntil: 'networkidle2', timeout: 120000 });
    if (GALLERY) {
      // The gallery is server-rendered and has no async readiness signal; the
      // heading is present in the first response. Wait for it anyway so a 500
      // is a timeout here rather than an audit of an error page.
      await page
        .waitForFunction(() => /Projects/.test(document.body.innerText),
          { timeout: 60000 })
        .catch(() => console.log('  ! gallery never rendered'));
      await sleep(500);
    } else {
      // The status bar reports the real count only once /api/buildings has
      // resolved and the scene is live, so it doubles as the readiness signal.
      await page
        .waitForFunction(
          (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
          { timeout: 240000 },
          BUILDING_COUNT,
        )
        .catch(() => console.log('  ! never reached the ready state'));
      // Terrain sampling + the first imagery LODs. Raise it with ULPIN_SETTLE
      // when the network is slow: a frame captured mid-load shows the globe's
      // base colour, which reads as a scene that lost its imagery.
      await sleep(SETTLE);
    }

    // The Cesium ion logo is the one thing on screen we are not allowed to
    // restyle -- it is part of the attribution. Its bounding box is measured
    // here and excluded from the pixel audit so the logo's own colour is never
    // counted as the scene's.
    const creditBox = await page.evaluate(() => {
      const c = document.querySelector('.cesium-viewer-bottom');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        x0: Math.max(0, Math.floor(r.left) - 2),
        y0: Math.max(0, Math.floor(r.top) - 2),
        x1: Math.ceil(r.right) + 2,
        y1: Math.ceil(r.bottom) + 2,
      };
    });

    const file = path.join(OUT, `${label}.png`);
    await page.screenshot({ path: file });
    console.log(`  shot -> ${path.relative(process.cwd(), file)}`);

    // ---- chrome audit ----------------------------------------------------
    // The rule the chrome still has to obey, read off computed styles. An
    // element is in scope when it sits inside a floating panel; the swatches
    // that carry the scene's palette set their colour inline and are skipped.
    const chrome = await page.evaluate(() => {
      const parse = (css) => {
        const m = /rgba?\(([^)]+)\)/.exec(css || '');
        if (!m) return null;
        const n = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
        if (n.length < 3 || n.some(Number.isNaN)) return null;
        return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
      };
      // #EF4444 / #FCA5A5 / #DC2626 / #991B1B and their blends: red-dominant
      // with the other two channels level. Same shape as the pixel test below.
      const sanctioned = (c) =>
        c.r > c.g && c.r > c.b && Math.abs(c.g - c.b) <= 26
        && c.r - Math.max(c.g, c.b) >= 12;

      const roots = [...document.querySelectorAll('.glass, .glass-soft')];
      const seen = new Set();
      const bad = [];
      for (const root of roots) {
        for (const el of [root, ...root.querySelectorAll('*')]) {
          if (seen.has(el)) continue;
          seen.add(el);
          // Inline colour = a data swatch. Exempt by design, see the header.
          const inline = el.getAttribute('style') || '';
          if (/color|background|fill|stroke/i.test(inline)) continue;
          const cs = getComputedStyle(el);
          for (const prop of ['color', 'backgroundColor', 'borderTopColor',
            'borderRightColor', 'borderBottomColor', 'borderLeftColor',
            'outlineColor', 'fill', 'stroke']) {
            const c = parse(cs[prop]);
            if (!c || c.a === 0) continue;
            if (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 6) continue;
            if (sanctioned(c)) continue;
            bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString()
              .split(/\s+/)[0]} ${prop}=${cs[prop]}`);
            break;
          }
        }
      }
      return { scanned: seen.size, bad: bad.slice(0, 8), count: bad.length };
    });
    console.log(`  chrome elements      : ${chrome.scanned}`);
    if (chrome.count) {
      console.log(`  FAIL: ${chrome.count} chrome element(s) carry an unsanctioned hue`);
      console.log(`        ${chrome.bad.join('\n        ')}`);
      failures++;
    } else console.log('  PASS: chrome is monochrome');

    // ---- scene colour audit ----------------------------------------------
    // Read from the PNG, not from the live canvas: Cesium runs with
    // preserveDrawingBuffer false, so the WebGL backbuffer reads back empty.
    // The screenshot is the composited frame, which is what a reviewer sees.
    //
    // Skipped in gallery mode: there is no scene, and a page that is
    // monochrome by design is exactly what this check exists to fail.
    if (GALLERY) {
      console.log('  scene colour audit   : n/a (no canvas on this page)');
    } else {
    const px = decodePng(readFileSync(file));
    {
      const hues = new Map();
      let total = 0, chromatic = 0, danger = 0, credit = 0;
      for (let y = 0; y < px.height; y++) {
        for (let x = 0; x < px.width; x++) {
          const i = (y * px.width + x) * 4;
          const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
          total++;
          if (creditBox && x >= creditBox.x0 && x < creditBox.x1
              && y >= creditBox.y0 && y < creditBox.y1) { credit++; continue; }
          if (chroma(r, g, b) <= 8) continue;        // codec noise floor
          chromatic++;
          if (isDangerRed(r, g, b)) danger++;
          const key = g >= r && g >= b ? 'green'
            : b >= r && b >= g ? 'blue'
            : isDangerRed(r, g, b) ? 'red' : 'warm';
          hues.set(key, (hues.get(key) ?? 0) + 1);
        }
      }
      const pct = total ? (chromatic / total) * 100 : 0;
      const greenPct = total ? ((hues.get('green') ?? 0) / total) * 100 : 0;
      console.log(`  pixels sampled       : ${total}`);
      console.log(`  attribution logo     : ${credit} (excluded, licence-protected)`);
      console.log(`  conflict red         : ${danger}`);
      console.log(`  coloured pixels      : ${chromatic} (${pct.toFixed(2)}%)`
        + `  green ${greenPct.toFixed(2)}%`);
      // A drained basemap or a desaturated scene lands near zero; a live frame
      // over the AOI is tens of percent. The floor is set low enough that a
      // night-time sun hour or a heavy zoom does not trip it.
      const FLOOR = 3;
      if (pct < FLOOR) {
        console.log(`  FAIL: scene has lost its colour (floor ${FLOOR}%)`);
        failures++;
      } else console.log('  PASS: scene is in colour');
    }
    }

    const real = errors.filter(
      (e) => !/favicon|ERR_INTERNET_DISCONNECTED|openstreetmap|arcgisonline|cartocdn|mapbox/i.test(e),
    );
    if (real.length) { console.log(`  FAIL: ${real.length} console error(s): ${real.slice(0, 3).join(' | ')}`); failures++; }
    else console.log('  PASS: no console errors');

    // ---- layout audit ----------------------------------------------------
    // Both checks below work on the CLIPPED rect, not the raw bounding box.
    // A panel inside a scrolling column legitimately extends past its
    // container; what matters is the part that is actually painted. Comparing
    // raw rects reports the scroll extent as an overflow and as a collision
    // with whatever is below the column -- two false failures that would train
    // everyone to ignore this check.
    const layout = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;

      /** Rect intersected with every clipping ancestor, or null if fully clipped. */
      const visibleRect = (el) => {
        let r = el.getBoundingClientRect();
        let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (let p = el.parentElement; p; p = p.parentElement) {
          const cs = getComputedStyle(p);
          const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
          if (!clips) continue;
          const pr = p.getBoundingClientRect();
          box.left = Math.max(box.left, pr.left);
          box.top = Math.max(box.top, pr.top);
          box.right = Math.min(box.right, pr.right);
          box.bottom = Math.min(box.bottom, pr.bottom);
        }
        if (box.right - box.left <= 1 || box.bottom - box.top <= 1) return null;
        return box;
      };

      const boxes = [];
      for (const el of document.querySelectorAll('.glass, .glass-soft')) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const box = visibleRect(el);
        if (!box) continue;
        boxes.push({
          name: el.getAttribute('data-panel')
            ?? el.closest('[data-panel]')?.getAttribute('data-panel')
            ?? 'panel',
          box,
          el,
        });
      }

      const overflow = boxes
        .filter((b) => b.box.left < -1 || b.box.top < -1
          || b.box.right > vw + 1 || b.box.bottom > vh + 1)
        .map((b) => `${b.name}@${Math.round(b.box.left)},${Math.round(b.box.top)} `
          + `${Math.round(b.box.right - b.box.left)}x${Math.round(b.box.bottom - b.box.top)}`);

      // Nested panels are cards, not collisions.
      const outer = boxes.filter((b) => !boxes.some((o) => o !== b && o.el.contains(b.el)));
      const collisions = [];
      for (let i = 0; i < outer.length; i++) {
        for (let j = i + 1; j < outer.length; j++) {
          const a = outer[i].box, c = outer[j].box;
          const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left);
          const oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
          if (ox > 2 && oy > 2) {
            collisions.push(`${outer[i].name} x ${outer[j].name} (${Math.round(ox)}x${Math.round(oy)}px)`);
          }
        }
      }

      // The attribution container is a licence obligation and may never be
      // covered by chrome. Checked by hit-testing its own centre.
      const credit = document.querySelector('.cesium-viewer-bottom');
      let creditCovered = null;
      if (credit) {
        const r = credit.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit && !credit.contains(hit) && hit !== credit) {
            creditCovered = hit.getAttribute('data-panel')
              ?? hit.closest('[data-panel]')?.getAttribute('data-panel')
              ?? hit.tagName.toLowerCase();
          }
        }
      }
      return { overflow, collisions, creditCovered, panels: boxes.length };
    });

    console.log(`  panels visible       : ${layout.panels}`);
    if (layout.overflow.length) { console.log(`  FAIL: ${layout.overflow.length} panel(s) outside the viewport: ${layout.overflow.join(' | ')}`); failures++; }
    else console.log('  PASS: all panels within the viewport');
    if (layout.collisions.length) { console.log(`  FAIL: ${layout.collisions.length} panel collision(s): ${layout.collisions.join(' | ')}`); failures++; }
    else console.log('  PASS: no panel collisions');
    if (GALLERY) {
      // Cesium's credit container only exists where a Cesium viewer does. The
      // gallery renders no map data and so incurs no attribution obligation;
      // if that ever changes -- a basemap thumbnail on a card -- this
      // exemption has to change with it.
      console.log('  attribution          : n/a (no map data on this page)');
    } else if (layout.creditCovered) {
      console.log(`  FAIL: attribution covered by "${layout.creditCovered}"`);
      failures++;
    } else console.log('  PASS: attribution visible');

    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;

/**
 * Decode the 8-bit non-interlaced RGB/RGBA PNGs Chrome produces.
 *
 * Deliberately not a general decoder: supporting only what the screenshot
 * path emits keeps this to forty lines and no dependency. Throws loudly on
 * anything else rather than returning a plausible-but-wrong buffer, because a
 * silently-empty audit is exactly the bug this replaced.
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(line, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { width, height, data: out };
}
