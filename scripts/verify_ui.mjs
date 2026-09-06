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
import {
  PROTOCOL_TIMEOUT_MS, applySession, chromeArgs, reportBackend,
} from './_chrome.mjs';
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

/**
 * Poll until `fn` returns truthy, or give up.
 *
 * The underground layers are LAZY on purpose -- a stratum is not built
 * until it is asked for, and the ground field it is hung off is a terrain
 * batch that has to arrive first. A fixed sleep therefore measures the
 * network rather than the app, and was the difference between this walk
 * passing and failing between runs.
 */
async function waitFor(page, fn, { timeout = 20000, every = 500 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() > until) return false;
    await sleep(every);
  }
}

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
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  args: chromeArgs({ window: '1680,950' }),
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  await reportBackend(page);
  await applySession(page, URL);
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  /**
   * A failed request, with the reason.
   *
   * ERR_ABORTED is excluded, and only that one. An aborted request is the
   * BROWSER cancelling work it decided it no longer needs -- in practice a
   * Next.js router prefetch (`?_rsc=`) that is dropped when the walk clicks
   * something before it lands. Nothing in the application failed, nothing the
   * user would see changed, and counting it made the walk report an error
   * whose message was a URL with no reason attached. Every other failure
   * reason still fails the check, and now says what it was.
   */
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? 'unknown';
    if (why === 'net::ERR_ABORTED') return;
    errors.push(`REQFAIL ${why} ${r.url().slice(0, 120)}`);
  });
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
      && !/arcgisonline\.com|maptiles\.arcgis\.com|cartocdn\.com|api\.mapbox\.com|nrsc\.gov\.in/i.test(e),
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
  // Siripuram no longer carries the two planted utility/basement conflicts, so
  // the banner must be ABSENT rather than empty -- a callout with nothing to
  // call out is worse than no callout. The conflict machinery itself is
  // unchanged and still exercised: hyderabad-banjara has 80 of them.
  const conflictCount = await page.evaluate(async () => {
    const rows = await fetch('/api/p/siripuram/conflicts').then((r) => r.json());
    return Array.isArray(rows) ? rows.length : -1;
  });
  check('the project reports no conflicts', conflictCount === 0, String(conflictCount));
  check('and no conflict banner is shown',
    !/utility\/basement conflict/i.test(body));
  check('underground panel shown', /Underground infrastructure/i.test(body));
  check('depth section shown', /Depth section/i.test(body));
  // The credit lives in the conflict banner, because it attributes the test
  // that FOUND those conflicts. With none to attribute there is nothing to
  // credit, so this is asserted only where it means something -- which keeps
  // it a real check for hyderabad-banjara and for a re-seeded siripuram,
  // rather than a string that has to stay on screen for its own sake.
  if (conflictCount > 0) {
    check('ST_3DIntersects credited', /ST_3DIntersects/i.test(body));
  } else {
    console.log('  SKIP  ST_3DIntersects credited — no conflicts to attribute');
  }
  check('utility provenance disclosed',
    /not as-built utility records|No utility survey was consulted/i.test(body));

  // The redesign's point: the strata are individually switchable, and only the
  // ones asked for are BUILT. Water is the only default, so before touching
  // anything there must be exactly one category data source in the scene --
  // once the terrain batch it hangs off has arrived.
  const built = await waitFor(page, () => {
    const v = window.__ulpinViewer;
    if (!v) return false;
    for (let i = 0; i < v.dataSources.length; i++) {
      if ((v.dataSources.get(i).name || '').startsWith('utilities:')) return true;
    }
    return false;
  });
  check('the default stratum builds once underground is on', built);

  const strata = await page.evaluate(() => {
    const v = window.__ulpinViewer;
    if (!v) return { seam: false, names: [] };
    const names = [];
    for (let i = 0; i < v.dataSources.length; i++) {
      const n = v.dataSources.get(i).name || '';
      if (n.startsWith('utilities:')) names.push(n.split('#')[0]);
    }
    return { seam: true, names: [...new Set(names)] };
  });
  check('viewer seam present', strata.seam);
  check('only the default stratum is built', strata.names.length === 1
    && strata.names[0] === 'utilities:water', strata.names.join(','));

  // Switching a second category on builds it; nothing else is rebuilt.
  const toggled = await page.evaluate(() => {
    const el = [...document.querySelectorAll('label')]
      .find((x) => x.getAttribute('aria-label') === 'Sewerage');
    if (el) el.click();
    return Boolean(el);
  });
  check('a second stratum can be switched on', toggled);
  await sleep(2500);
  const after = await page.evaluate(() => {
    const v = window.__ulpinViewer;
    const names = new Set();
    let tubes = 0;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      const n = ds.name || '';
      if (!n.startsWith('utilities:')) continue;
      names.add(n.split('#')[0]);
      if (n.startsWith('utilities:sewer')) {
        for (const e of ds.entities.values) if (e.polylineVolume) tubes++;
      }
    }
    return { names: [...names], tubes };
  });
  check('the second stratum was built on demand',
    after.names.includes('utilities:sewer'), after.names.join(','));
  check('it carries geometry', after.tubes > 0, `${after.tubes} tubes`);

  // Every network must FOLLOW the ground rather than cut through it.
  //
  // This is the regression the layout redesign exists to fix. The generator
  // bakes one AOI-wide mean ground elevation into every vertex, so over
  // Siripuram's 63 m of relief a "1 m deep" run was 12 m under the hill at one
  // end and 19 m above the hollow at the other -- 48 % of it drawn in mid-air,
  // through buildings.
  //
  // MEASURED NEAR THE CAMERA, and that restriction is not a convenience. The
  // layer hangs its geometry off terrain sampled at a fixed tile level for the
  // whole project; globe.getHeight() answers from whichever tile is currently
  // loaded, which for a close underground view is high detail nearby and very
  // coarse far away. Comparing the two across the whole AOI therefore measures
  // the tile pyramid, not the layout -- it reported a 20 m spread on geometry
  // that a full-detail comparison puts at about 2 m. Inside the radius below
  // the two representations agree, so this is the region where the question
  // can actually be asked.
  //
  // The measure is SPREAD rather than a count of vertices above ground: depth
  // below local ground used to range over 31 m within a single class and now
  // ranges over a few, and no amount of tile-load luck turns one into the
  // other.
  const NEAR_M = 500;
  await waitFor(page, () => window.__ulpinViewer?.scene.globe.tilesLoaded === true,
    { timeout: 25000 });
  await sleep(1500);
  const buried = await page.evaluate((nearM) => {
    const v = window.__ulpinViewer;
    if (!v) return { skipped: 'no viewer seam' };
    const ell = v.scene.globe.ellipsoid;
    const now = v.clock.currentTime;
    const eye = ell.cartesianToCartographic(v.camera.positionWC);
    if (!eye) return { skipped: 'no camera position' };
    const mLat = 110574;
    const mLon = 111320 * Math.cos(eye.latitude);

    const per = new Map();
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      const name = ds.name || '';
      if (!name.startsWith('utilities:')) continue;
      const cat = name.split('#')[0].slice('utilities:'.length);
      if (!per.has(cat)) per.set(cat, []);
      const d = per.get(cat);
      for (const e of ds.entities.values) {
        const pv = e.polylineVolume;
        if (!pv) continue;
        const pts = pv.positions.getValue(now);
        if (!pts) continue;
        for (const pt of pts) {
          const c = ell.cartesianToCartographic(pt);
          if (!c) continue;
          const dx = (c.longitude - eye.longitude) * (180 / Math.PI) * mLon;
          const dy = (c.latitude - eye.latitude) * (180 / Math.PI) * mLat;
          if (Math.hypot(dx, dy) > nearM) continue;
          const g = v.scene.globe.getHeight(c);
          if (g !== undefined) d.push(c.height - g);
        }
      }
    }

    const rows = [];
    for (const [cat, d] of per) {
      if (d.length < 40) continue;
      d.sort((a, b) => a - b);
      const q = (f) => d[Math.floor(f * (d.length - 1))];
      rows.push({
        cat,
        n: d.length,
        median: Math.round(q(0.5) * 100) / 100,
        spread: Math.round((q(0.95) - q(0.05)) * 100) / 100,
      });
    }
    return { rows };
  }, NEAR_M);

  if (buried.skipped || !buried.rows || buried.rows.length === 0) {
    console.log('  SKIP  networks follow the ground — '
      + `${buried.skipped ?? `no run within ${NEAR_M} m of the camera`}`);
  } else {
    for (const r of buried.rows) {
      check(`${r.cat} follows the ground`,
        r.median < -0.4 && r.spread < 6,
        `median ${r.median} m, 5-95 spread ${r.spread} m over ${r.n} vertices`);
    }
  }

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
    // BOTH URL SHAPES. The application asks for the project-scoped
    // /api/p/<slug>/building/<id>; the unscoped /api/building/<id> alias is
    // what the other acceptance scripts drive. Matching only the alias meant
    // this throttle stopped applying to the app, the detail arrived at full
    // speed, and the skeleton was gone before it could be sampled -- a green
    // feature reported as red.
    if (/\/api\/(p\/[a-z0-9-]+\/)?building\/\d+/.test(req.url())) {
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
      && !/arcgisonline\.com|maptiles\.arcgis\.com|cartocdn\.com|api\.mapbox\.com|nrsc\.gov\.in/i.test(e),
  );
  check('no runtime errors', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
