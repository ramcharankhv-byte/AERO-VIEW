/**
 * End-to-end UI verification.
 *
 * Drives the real app in a real Chrome via CDP and walks the view states:
 * city -> building -> floor -> unit -> sectioned floor -> underground,
 * screenshotting each and asserting the DOM actually changed. Uses
 * puppeteer-core against the installed Chrome rather than downloading a
 * Chromium.
 *
 * Usage: node scripts/verify_ui.mjs [outDir]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'docs', 'shots');
/**
 * The viewer, for the demo project.
 *
 * `/` is the project gallery now, so the default target is the demo project's
 * own page. Override with ULPIN_URL to point at another project or another
 * port; the unscoped /api/... endpoints this script fetches are aliases onto
 * the same project, so nothing else here had to change.
 */
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';
const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

mkdirSync(OUT, { recursive: true });

// The status bar only reports a count once /api/buildings has resolved and
// the scene is live, so it doubles as the readiness signal. Read the count
// from the same snapshot the API serves when the DB is down, so the assertion
// stays correct after a rebuild rather than depending on a hard-coded total.
const snapshotFC = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'), 'utf-8'),
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
  // Selected by label, not by index: the panel holds several range inputs and
  // an index would silently start driving a different one if the order changed.
  const moved = await page.evaluate(() => {
    const el = document.querySelector('input[type=range][aria-label="Explode"]');
    if (!el) return false;
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
  // The ladder only renders once /api/building/:id has resolved, which is a
  // network round trip after the flight the previous step waited out. Waiting
  // for a rung to exist rather than for a further fixed delay is what stops
  // this step from failing on a slow first compile.
  const ladderUp = await page
    .waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) =>
        /^(G|[0-9]{1,2}|B[0-9])$/.test(b.innerText.trim())),
      { timeout: 30000 },
    )
    .then(() => true, () => false);
  check('floor ladder rendered', ladderUp);
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

  // ------------------------------------------------- FLOOR + UNITS + SLICE
  // An isolated floor now shows its flats co-visibly with the level itself: a
  // thin plate, a translucent height shell, and one solid box per unit. This
  // block asserts the flats are really there, that a click on one resolves as
  // a UNIT rather than as the shell in front of it, and that sectioning the
  // level cuts the flats open rather than merging them into the plate.
  //
  // Unit centroids are read off the live scene through the dev-only
  // __ulpinViewer seam and projected to canvas coordinates, so the click lands
  // on a flat by construction instead of by sweeping the viewport and hoping.
  console.log('\n[6] FLOOR UNITS + SLICE');

  // Back out to the floor: the walk above ended with a unit selected.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.innerText.trim() === 'Back to floor',
    );
    if (b) b.click();
  });
  await sleep(2500);

  /** Unit entities in the live scene, with their centroids in canvas space. */
  const readUnits = () =>
    page.evaluate(() => {
      const v = window.__ulpinViewer;
      if (!v) return { seam: false, count: 0, area: 0, points: [] };
      const ds = v.dataSources.getByName('units')[0];
      if (!ds) return { seam: true, count: 0, area: 0, points: [] };
      const now = v.clock.currentTime;
      const points = [];
      let count = 0;
      let area = 0;
      for (const e of ds.entities.values) {
        if (e.tag?.kind !== 'unit') continue;
        count++;
        const shown = e.polygon?.show?.getValue(now);
        if (!shown || !e.position) continue;
        // Plan area of the visible flats, by Newell's method over the ring's
        // ECEF positions. The section is cut into the RINGS, so area is what
        // moves when the plane does -- and unlike a vertex count it can only
        // go one way, which makes it an assertion rather than a coincidence.
        const pos = e.polygon.hierarchy.getValue(now)?.positions ?? [];
        let nx = 0; let ny = 0; let nz = 0;
        for (let i = 0; i < pos.length; i++) {
          const a = pos[i];
          const b = pos[(i + 1) % pos.length];
          nx += a.y * b.z - a.z * b.y;
          ny += a.z * b.x - a.x * b.z;
          nz += a.x * b.y - a.y * b.x;
        }
        area += 0.5 * Math.hypot(nx, ny, nz);
        const win = v.scene.cartesianToCanvasCoordinates(e.position.getValue(now));
        if (win) points.push({ x: Math.round(win.x), y: Math.round(win.y) });
      }
      return { seam: true, count, area, points };
    });

  const units = await readUnits();
  check('dev viewer seam available', units.seam);
  check('unit entities built for the active building', units.count > 0,
    `${units.count} unit entit(ies)`);
  check('units on the isolated floor are on screen and projected',
    units.points.length > 0, `${units.points.length} visible`);

  let floorUnitOk = false;
  let floorUnitAt = null;
  for (const p of units.points) {
    if (p.x < 4 || p.y < 4 || p.x > 1676 || p.y > 946) continue;
    await page.mouse.click(p.x, p.y);
    await sleep(1400);
    panel = await panelText(page);
    if (/Titled unit/i.test(panel)) {
      floorUnitOk = true;
      floorUnitAt = `${p.x},${p.y}`;
      break;
    }
  }
  check('a unit centroid picks as a UNIT, not as the floor', floorUnitOk,
    floorUnitOk ? `at ${floorUnitAt}` : 'no unit resolved');
  if (floorUnitOk) {
    // The ULPIN card splits the identifier into labelled segments, so the
    // hyphenated form never reaches innerText; its gloss line does, and it only
    // reads "unit N" when all four levels parsed. That is the check that the
    // panel is showing a UNIT's ULPIN and not its parent floor's.
    check('detail panel carries a unit ULPIN',
      /parcel \d+ . building \d+ . level -?\d+ . unit \d+/.test(panel),
      (panel.match(/parcel \d+ . building[^A-Z]{0,60}/) ?? ['none'])[0]);
    check('provenance line present on the unit', /Provenance/i.test(panel));
  }
  await shot(page, '12-floor-units');

  // -- section cut ---------------------------------------------------------
  const sliceOn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.getAttribute('aria-label') === 'Slice',
    );
    if (b) b.click();
    return Boolean(b) && b.getAttribute('aria-checked') !== null;
  });
  check('slice toggle present and enabled in floor mode', sliceOn);
  await sleep(600);
  const sliceMoved = await page.evaluate(() => {
    const el = document.querySelector('input[type=range][aria-label="Slice position"]');
    if (!el || el.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '20');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  check('slice position slider is live once slice is on', sliceMoved);
  await sleep(1800);

  // The cut reaches the flats, not just the plate: the section leaves separate
  // unit boxes standing, and their RINGS have changed -- either a flat has been
  // taken away entirely or the surviving ones have been re-cut.
  const sliced = await readUnits();
  check('units survive the section and stay individually drawn',
    sliced.points.length > 0 && sliced.points.length <= units.count,
    `${sliced.points.length}/${units.count} flats in section`);
  check('the section cut the unit geometry, not only the plate',
    sliced.area < units.area * 0.999,
    `${units.points.length} flats/${units.area.toFixed(1)} m2 -> `
    + `${sliced.points.length}/${sliced.area.toFixed(1)} m2`);
  // Slice and explode are mutually exclusive, and the store is what enforces it.
  const explodeAfterSlice = await page.evaluate(() => {
    const el = document.querySelector('input[type=range][aria-label="Explode"]');
    return el ? el.value : null;
  });
  check('enabling slice switched explode off', explodeAfterSlice === '0',
    `explode=${explodeAfterSlice}`);
  check('floor stayed isolated under the cut',
    /Titled unit|Floor level|Basement level/i.test(await panelText(page)));
  await shot(page, '13-floor-sliced');

  const sliceErrors = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|tile\.openstreetmap|openstreetmap\.org/i.test(e)
      && !/arcgisonline\.com|maptiles\.arcgis\.com|cartocdn\.com|api\.mapbox\.com/i.test(e),
  );
  check('no console errors through the floor/slice walk', sliceErrors.length === 0,
    sliceErrors.slice(0, 3).join(' | '));

  // Explode and slice are mutually exclusive; leave the scene unsliced so the
  // sections below see the same scene they always did.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.getAttribute('aria-label') === 'Slice',
    );
    if (b && b.getAttribute('aria-checked') === 'true') b.click();
  });
  await sleep(1200);

  // --------------------------------------------------------- UNDERGROUND
  console.log('\n[7] UNDERGROUND');
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

  // ------------------------------------------------------------ POLISH PACK
  // The five surfaces added by the polish pack. Back to city view first: the
  // tooltip, the provenance key and the stats panel are all city-view things,
  // and the walk above finished underground with a unit selected.
  console.log('\n[8] POLISH PACK');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.innerText.trim() === 'Reset view',
    );
    if (b) b.click();
  });
  await sleep(4000);

  // -- provenance legend ---------------------------------------------------
  const cityText = await panelText(page);
  check('provenance key present', /Provenance key/i.test(cityText));
  check(
    'provenance key names its sources',
    /OSM tag \(mapped\)/i.test(cityText) && /Estimated/i.test(cityText),
  );
  await shot(page, '7-provenance-legend');

  // -- hover tooltip -------------------------------------------------------
  // A footprint's screen position is not fixed, so sweep candidates the way the
  // unit pick above does rather than assuming one point lands on a building.
  const hoverPoints = [
    [840, 470], [760, 430], [920, 510], [700, 470], [980, 430],
    [840, 380], [640, 520], [1040, 470],
  ];
  let tipOk = false;
  let tipText = '';
  for (const [x, y] of hoverPoints) {
    await page.mouse.move(x, y);
    await sleep(450);
    const t = await panelText(page);
    if (/storeys \u00b7/.test(t)) {
      tipOk = true;
      tipText = (t.match(/.{0,40}storeys \u00b7.{0,30}/) ?? [''])[0];
      break;
    }
  }
  check('hover tooltip appears', tipOk, tipOk ? tipText : 'no tooltip on any probe');
  await shot(page, '8-tooltip');

  // -- stats panel ---------------------------------------------------------
  const statsClicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.innerText.trim() === 'Stats',
    );
    if (b) b.click();
    return Boolean(b);
  });
  check('stats toggle present', statsClicked);
  await sleep(700);
  const statsText = await panelText(page);
  check('stats panel opens with all three charts',
    /Building heights \(m\)/i.test(statsText)
    && /Buildings by use type/i.test(statsText)
    && /Conflicts by authority/i.test(statsText));
  // The caption must carry real percentages, not a placeholder.
  check('chart caption reports computed provenance',
    /Heights: \d+% OSM-tagged, \d+% estimated, \d+% plan/i.test(statsText),
    (statsText.match(/Heights:[^.]*/) ?? ['none'])[0]);
  await shot(page, '9-stats');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => x.innerText.trim() === 'Stats',
    );
    if (b) b.click();
  });

  // -- sun slider ----------------------------------------------------------
  const sunMoved = await page.evaluate(() => {
    const el = document.querySelector('input[type=range][aria-label="Sun"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '8');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  check('sun slider exists and moves', sunMoved);
  await sleep(2500);
  const sunText = await panelText(page);
  // Untouched the read-out says "off"; once moved it reports a clock time, and
  // that is also the signal that shadows have been switched on.
  check('sun reports a time of day', /08:00/.test(sunText));
  await shot(page, '10-sun');

  // -- skeleton on a slow detail fetch -------------------------------------
  // Throttle only /api/building/:id so the in-flight window is long enough to
  // observe; everything else is left at full speed.
  const slowDetail = (req) => {
    if (/\/api\/building\/\d+/.test(req.url())) {
      setTimeout(() => req.continue(), 1500);
      return;
    }
    req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', slowDetail);

  await page.click('input[placeholder*="Search"]');
  await page.type('input[placeholder*="Search"]', 'AP-VSP-3D26-0002');
  await sleep(900);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /AP-VSP-3D26-0002/.test(b.innerText),
    );
    if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await sleep(700);
  const skeletonUp = await page.evaluate(
    () => document.querySelectorAll('.skeleton').length,
  );
  check('skeleton rows render while detail is in flight', skeletonUp > 0,
    `${skeletonUp} placeholder(s)`);
  await shot(page, '11-skeleton');

  await sleep(3000);
  const settled = await page.evaluate(() => ({
    skeletons: document.querySelectorAll('.skeleton').length,
    text: document.body.innerText.replace(/\s+/g, ' '),
  }));
  check('skeleton is replaced by real content',
    settled.skeletons === 0 && /Registered owner/.test(settled.text));

  page.off('request', slowDetail);
  await page.setRequestInterception(false);

  // -------------------------------------------------------- disabled controls
  console.log('\n[9] DISABLED CONTROLS');
  const disabled = await page.evaluate(() =>
    [...document.querySelectorAll('button[disabled]')].map((b) => b.innerText.trim()),
  );
  // Slice is implemented now and is asserted live in [6]; the rest are
  // still deliberately shown disabled rather than hidden.
  for (const label of ['Measure', 'Share', 'Split']) {
    check(`${label} rendered disabled`, disabled.includes(label), disabled.join(','));
  }

  // ------------------------------------------------------------- console
  console.log('\n[10] CONSOLE');
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
