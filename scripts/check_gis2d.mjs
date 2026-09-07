/**
 * Acceptance check for the 2D GIS parcel view.
 *
 * Drives the real app and asserts the things that would make the view a lie if
 * they were wrong: that the 3D scene actually stands down, that the parcels
 * and their numbers are on screen, that clicking a plot produces the whole
 * ULPIN tree beneath it, that every identifier in that tree round-trips
 * through lib/ulpin.ts, and that leaving the view puts the scene and the
 * camera back exactly as they were.
 *
 * It also checks the two things the panel MUST say. A numbered polygon on a
 * flat pale map is the most convincing thing this application draws, and
 * almost none of it is surveyed; the words "derived" and "unofficial" are
 * therefore assertions here, not copy.
 *
 * Usage:
 *   node scripts/check_gis2d.mjs
 *   ULPIN_URL=http://localhost:3210/p/hyderabad-banjara node scripts/check_gis2d.mjs
 *
 * Run it against BOTH backends -- `docker compose start` and `docker compose
 * stop` -- because the survey parcels have a PostGIS path and a snapshot path
 * and the whole point of the export is that they agree.
 */
import puppeteer from 'puppeteer-core';
import {
  PROTOCOL_TIMEOUT_MS, applySession, chromeArgs, reportBackend,
} from './_chrome.mjs';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { generate, parse } from '../lib/ulpin.ts';

const OUT = path.join(process.cwd(), 'docs', 'shots', 'gis2d');
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * Which project's snapshot to read the expected counts from.
 *
 * Derived from ULPIN_URL rather than passed separately, so pointing the check
 * at the second project cannot silently compare it against the first one's
 * numbers -- which would pass, because both have parcels and buildings.
 */
const SLUG = (/\/p\/([a-z0-9-]+)/.exec(URL)?.[1]) ?? 'siripuram';
const API = path.join(process.cwd(), 'data', 'api', SLUG);

mkdirSync(OUT, { recursive: true });

const BUILDING_COUNT = JSON.parse(
  readFileSync(path.join(API, 'buildings.json'), 'utf-8'),
).features.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const bodyText = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

/** Entities across every data source whose name starts with `prefix`. */
const countEntities = (page, prefix) => page.evaluate((p) => {
  const v = window.__ulpinViewer;
  if (!v) return -1;
  let n = 0;
  let found = false;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (!ds.name.startsWith(p)) continue;
    found = true;
    n += ds.entities.values.length;
  }
  return found ? n : 0;
}, prefix);

/** Are the data sources with this name prefix being drawn? */
const anyShown = (page, prefix) => page.evaluate((p) => {
  const v = window.__ulpinViewer;
  if (!v) return null;
  let any = false;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (ds.name.startsWith(p) && ds.show) any = true;
  }
  return any;
}, prefix);

const cameraPose = (page) => page.evaluate(() => {
  const c = window.__ulpinViewer.camera;
  return {
    lon: (c.positionCartographic.longitude * 180) / Math.PI,
    lat: (c.positionCartographic.latitude * 180) / Math.PI,
    height: c.positionCartographic.height,
    heading: (c.heading * 180) / Math.PI,
    pitch: (c.pitch * 180) / Math.PI,
  };
});

const clickToggle = (page) => page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '2D GIS');
  if (!btn) return false;
  btn.click();
  return true;
});

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
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(
    (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 }, BUILDING_COUNT,
  );
  await sleep(8000);

  // ------------------------------------------------------------------ DATA
  console.log('\n[1] DATA');
  const api = await page.evaluate(async () => {
    const res = await fetch('/api/survey-parcels');
    return {
      status: res.status,
      backend: res.headers.get('x-ulpin-backend'),
      body: await res.json(),
    };
  });
  check('GET /api/survey-parcels answers 200', api.status === 200,
    `status ${api.status}`);
  check('it declares which backend served it', Boolean(api.backend),
    `x-ulpin-backend: ${api.backend}`);
  const feats = api.body?.features ?? [];
  check('parcels were served', feats.length > 0, `${feats.length} parcels`);

  const first = feats[0]?.properties ?? {};
  check('every parcel declares its provenance',
    feats.every((f) => f.properties.provenance === 'derived'
      || f.properties.provenance === 'survey_dept'),
    `first is "${first.provenance}"`);
  check('a derived parcel carries no survey number',
    feats.filter((f) => f.properties.provenance === 'derived')
      .every((f) => f.properties.ts_no === null
        && f.properties.lpm_no === null && f.properties.ulpin_14 === null),
    'ts_no / lpm_no / ulpin_14 all null');
  check('every label is a 4-digit ordinal',
    feats.every((f) => /^\d{4}$/.test(f.properties.label)),
    `first is "${first.label}"`);

  // The alias and the scoped route must be the same bytes, which is the whole
  // reason they share a handler body.
  const aliasMatch = await page.evaluate(async (slug) => {
    const [a, b] = await Promise.all([
      fetch('/api/survey-parcels').then((r) => r.text()),
      fetch(`/api/p/${slug}/survey-parcels`).then((r) => r.text()),
    ]);
    return a === b;
  }, SLUG);
  check('alias and scoped route are byte-identical', aliasMatch || SLUG !== 'siripuram',
    SLUG === 'siripuram' ? '' : 'n/a — alias points at the demo project');

  // -------------------------------------------------------- BEFORE THE VIEW
  console.log('\n[2] THE 3D SCENE, BEFORE');
  const before = {
    buildings: await countEntities(page, 'buildings'),
    buildingsShown: await anyShown(page, 'buildings'),
    pose: await cameraPose(page),
  };
  check('buildings are on screen', before.buildingsShown === true,
    `${before.buildings} entities`);
  console.log(`        camera  ${before.pose.height.toFixed(0)} m, `
    + `pitch ${before.pose.pitch.toFixed(1)}°, `
    + `heading ${before.pose.heading.toFixed(1)}°`);

  // ------------------------------------------------------------- TOGGLE ON
  console.log('\n[3] TOGGLE ON');
  check('the 2D GIS control exists', await clickToggle(page));
  await sleep(6000);

  check('the toggle reads as pressed', await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === '2D GIS');
    return btn?.getAttribute('aria-pressed') === 'true';
  }));
  check('buildings are hidden', (await anyShown(page, 'buildings')) === false);
  check('the roads layer is hidden', (await anyShown(page, 'roads')) === false);
  check('the 3D parcels layer is hidden', (await anyShown(page, 'parcels')) === false);
  check('entities were not torn down',
    (await countEntities(page, 'buildings')) === before.buildings,
    `${before.buildings} -> ${await countEntities(page, 'buildings')}`);

  const parcelEntities = await countEntities(page, 'survey-parcels');
  check('the survey parcel layer was built', parcelEntities > 0,
    `${parcelEntities} entities for ${feats.length} parcels`);
  const labelCount = await page.evaluate(() => {
    const v = window.__ulpinViewer;
    let n = 0;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (!ds.name.startsWith('survey-parcels')) continue;
      for (const e of ds.entities.values) if (e.label) n++;
    }
    return n;
  });
  check('every parcel carries a label', labelCount === feats.length,
    `${labelCount} labels`);
  const labelsVisible = await page.evaluate(() => {
    const v = window.__ulpinViewer;
    const h = v.camera.positionCartographic.height;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (!ds.name.startsWith('survey-parcels')) continue;
      for (const e of ds.entities.values) {
        if (!e.label) continue;
        const c = e.label.distanceDisplayCondition?.getValue();
        return c ? h < c.far : true;
      }
    }
    return false;
  });
  check('the labels are inside their distance condition at the opening pose',
    labelsVisible === true);

  const onPose = await cameraPose(page);
  check('the camera is looking straight down', Math.abs(onPose.pitch + 90) < 1.5,
    `pitch ${onPose.pitch.toFixed(2)}°`);
  check('the camera is north-up', Math.abs(((onPose.heading + 180) % 360) - 180) < 1.5,
    `heading ${onPose.heading.toFixed(2)}°`);

  const chrome = await bodyText(page);
  check('the status bar names the view and its provenance',
    /2D GIS · (derived|survey) parcels/i.test(chrome),
    /2D GIS · [a-z]+ parcels/i.exec(chrome)?.[0] ?? 'not found');
  check('the status bar names the basemap',
    /CARTO Voyager/i.test(chrome));
  check('the legend keys the parcel boundary',
    /Cadastral parcels/i.test(chrome) && /parcel boundary/i.test(chrome));
  check('the legend says the numbers are not survey numbers',
    /NOT a survey number/i.test(chrome));

  check('Slice renders disabled', await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Slice');
    return btn?.disabled === true;
  }));

  // --------------------------------------------------------- CLICK A PARCEL
  console.log('\n[4] A PARCEL, AND THE TREE BENEATH IT');
  // Pick a parcel that actually has buildings on it, and click its label
  // position projected to the canvas -- inside the polygon by construction,
  // rather than sweeping the viewport and hoping.
  const target = feats.find((f) => (f.properties.building_ids?.length ?? 0) > 0);
  check('some parcel has buildings on it', Boolean(target),
    target ? `parcel ${target.properties.label} has `
      + `${target.properties.building_ids.length}` : '');

  let treeUlpins = [];
  if (target) {
    const ring = target.geometry.coordinates[0];
    const at = await page.evaluate((r) => {
      const v = window.__ulpinViewer;
      const C = window.Cesium ?? v.scene.globe.constructor.Cesium;
      // Centroid of the ring, then project. Cesium is reached through the
      // viewer's own module in case the global is not published.
      let x = 0; let y = 0;
      for (let i = 0; i < r.length - 1; i++) { x += r[i][0]; y += r[i][1]; }
      const lon = x / (r.length - 1); const lat = y / (r.length - 1);
      const cart = v.scene.globe.ellipsoid.cartographicToCartesian(
        { longitude: (lon * Math.PI) / 180, latitude: (lat * Math.PI) / 180,
          height: 0 },
      );
      const win = v.scene.cartesianToCanvasCoordinates(cart);
      return win ? { x: win.x, y: win.y } : null;
    }, ring);

    if (at) {
      await page.mouse.click(at.x, at.y);
      await sleep(2500);
    }
    const panel = await bodyText(page);

    const expectedUlpin = generate(Number(target.properties.label));
    // The panel's card splits the identifier into labelled segments, so the
    // text is matched segment by segment rather than as one string.
    const segs = expectedUlpin.split('-');
    check('the panel is showing a parcel',
      new RegExp(`Parcel ${target.properties.label}`).test(panel),
      `Parcel ${target.properties.label}`);
    check('the parcel ULPIN is on the card',
      segs.every((sgment) => panel.includes(sgment)), expectedUlpin);
    check('the panel says the boundary is derived and unofficial',
      /Derived parcel \(unofficial\)/i.test(panel)
      || /Survey parcel ·/i.test(panel));
    check('the disclaimer is on the card',
      /not an official government identifier/i.test(panel));

    const detail = await page.evaluate(async (slug, id) => {
      const res = await fetch(`/api/p/${slug}/survey-parcel/${id}`);
      return { status: res.status, body: await res.json() };
    }, SLUG, target.properties.id);
    check('GET .../survey-parcel/:id answers 200', detail.status === 200,
      `status ${detail.status}`);
    const bs = detail.body?.buildings ?? [];
    const withFloors = bs.filter((b) => (b.floors?.length ?? 0) > 0);
    const withUnits = withFloors.filter(
      (b) => b.floors.some((f) => (f.units?.length ?? 0) > 0),
    );
    check('at least one building -> floor -> unit chain exists',
      withUnits.length > 0,
      `${bs.length} buildings, ${withFloors.length} with floors, `
      + `${withUnits.length} with units`);

    for (const b of bs) {
      if (b.building?.ulpin) treeUlpins.push(b.building.ulpin);
      for (const f of b.floors ?? []) {
        if (f.ulpin) treeUlpins.push(f.ulpin);
        for (const u of f.units ?? []) if (u.ulpin) treeUlpins.push(u.ulpin);
      }
    }
  }

  console.log('\n[5] THE IDENTIFIERS ROUND-TRIP');
  check('the tree carries identifiers', treeUlpins.length > 0,
    `${treeUlpins.length} ULPINs`);
  const bad = [];
  for (const u of treeUlpins) {
    const parts = parse(u, 'any');
    if (!parts) { bad.push(`${u}: unparseable`); continue; }
    const back = generate(parts.parcel, parts.building, parts.floor, parts.unit,
      { state: parts.state, district: parts.district, scheme: parts.scheme });
    if (back !== u) bad.push(`${u} -> ${back}`);
  }
  check('every ULPIN in the tree round-trips through lib/ulpin.ts',
    bad.length === 0, bad.slice(0, 3).join(' | '));

  // ------------------------------------------------------------ TOGGLE OFF
  console.log('\n[6] TOGGLE OFF');
  check('the toggle is still there', await clickToggle(page));
  await sleep(6000);

  check('buildings are back', (await anyShown(page, 'buildings')) === true);
  check('the survey parcels are hidden',
    (await anyShown(page, 'survey-parcels')) === false);
  check('the building entity count is unchanged',
    (await countEntities(page, 'buildings')) === before.buildings,
    `${before.buildings} -> ${await countEntities(page, 'buildings')}`);

  const after = await cameraPose(page);
  const dPitch = Math.abs(after.pitch - before.pose.pitch);
  const dHead = Math.abs(after.heading - before.pose.heading);
  const dH = Math.abs(after.height - before.pose.height);
  check('the camera pose is restored',
    dPitch < 1.5 && dHead < 1.5 && dH < before.pose.height * 0.05,
    `Δpitch ${dPitch.toFixed(2)}°, Δheading ${dHead.toFixed(2)}°, `
    + `Δheight ${dH.toFixed(1)} m`);

  const backText = await bodyText(page);
  check('the status bar is no longer claiming 2D',
    !/2D GIS ·/i.test(backText));

  await page.screenshot({ path: path.join(OUT, `${SLUG}-after.png`) });

  // ---------------------------------------------------------------- CONSOLE
  console.log('\n[7] CONSOLE');
  const real = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|openstreetmap|arcgisonline|cartocdn|mapbox|nrsc\.gov\.in/i
      .test(e),
  );
  check('no console errors', real.length === 0,
    real.slice(0, 3).join(' | '));

  // A snapshot of the exported file is what the unit tests assert against; say
  // whether it is present, because its absence is the difference between "the
  // 2D view is empty" and "this project has no parcels".
  const snap = path.join(API, 'survey_parcels.json');
  console.log(`\nsnapshot: ${existsSync(snap) ? 'present' : 'ABSENT'} — ${snap}`);
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
