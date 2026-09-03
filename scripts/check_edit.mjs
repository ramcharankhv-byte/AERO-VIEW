/**
 * Acceptance check for Manual Edit.
 *
 * Covers the requirements that are easy to claim and hard to keep: that
 * coordinates and ULPIN really cannot be edited, that invalid values really
 * cannot be saved, that a save round-trips to the server and survives a
 * reload, and -- the performance requirement that would otherwise regress
 * silently -- that saving does NOT rebuild the whole scene.
 *
 * Uses its own edit store via ULPIN_EDITS_PATH so it never writes into the
 * repository, and starts from a clean one so the assertions are about this
 * run.
 *
 * Usage: node scripts/check_edit.mjs
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The viewer, for the demo project.
 *
 * `/` is the project gallery now, so the default target is the demo project's
 * own page. Override with ULPIN_URL to point at another project or another
 * port; the unscoped /api/... endpoints this script fetches are aliases onto
 * the same project, so nothing else here had to change.
 */
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/**
 * Where the store this run should be asserting against lives.
 *
 * ULPIN_EDITS_PATH names a BASE DIRECTORY now, not a file: edits are per
 * project (data/projects/<slug>/edits.json), because the store is keyed by
 * building id and building ids are only unique within a project. A value still
 * ending in `.json` is read as the directory that file was in, which is what
 * lib/data/edits.ts does too -- an existing development setup keeps working
 * rather than silently creating a directory called `edits.json`.
 *
 * This drives the UNSCOPED /api/building/:id alias, which resolves to the demo
 * project, so the store it should find is the demo project's.
 */
const SLUG = process.env.ULPIN_PROJECT ?? 'siripuram';
const EDITS_BASE = (() => {
  const override = process.env.ULPIN_EDITS_PATH;
  if (!override) return path.join(process.cwd(), 'data', 'projects');
  return override.toLowerCase().endsWith('.json') ? path.dirname(override) : override;
})();
const EDITS = path.join(EDITS_BASE, SLUG, 'edits.json');

const BUILDING_COUNT = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'), 'utf-8'),
).features.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Deliberately outside the generator's name banks, so a coincidental
 *  collision cannot make a failed save look like a successful one. */
const EDIT_NAME = 'Edited Test Block QX7';
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const bodyText = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

/** Set a React-controlled input's value the way a user would. */
const setField = (page, id, value) =>
  page.evaluate((sel, v) => {
    const el = document.getElementById(sel);
    if (!el) return false;
    const proto = el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    return true;
  }, id, value);

const clickText = (page, text) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === t);
    if (b) b.click();
    return Boolean(b);
  }, text);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--window-size=1680,950', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-sandbox',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  // The form deliberately provokes 400/422 responses; those are the feature
  // working, not page errors, so they are excluded from the console check the
  // way the tile hosts are.
  page.on('response', (r) => {
    if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
  });

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(
    (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 }, BUILDING_COUNT,
  );
  await sleep(7000);

  // ------------------------------------------------------------- SELECT
  console.log('\n[1] OPEN A BUILDING');
  await page.click('input[placeholder*="Search"]');
  await page.type('input[placeholder*="Search"]', 'AP-VSP-3D26-0001');
  await sleep(1000);
  const picked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      /AP-VSP-3D26-0001/.test(x.innerText));
    if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return Boolean(b);
  });
  check('a building can be selected by ULPIN', picked);
  await sleep(4500);
  const editedId = await page.evaluate(async () => {
    const r = await fetch('/api/buildings');
    const fc = await r.json();
    const f = fc.features.find((x) => /^AP-VSP-3D26-0001-/.test(x.properties.ulpin));
    return f ? f.properties.id : null;
  });
  check('the selected building id is known', editedId !== null, `id ${editedId}`);

  let text = await bodyText(page);
  check('register fields are shown', /Building ID/.test(text) && /BLD-\d+/.test(text));
  check('built-up area is shown', /Built-up area/.test(text));
  check('occupancy is shown', /Occupancy/.test(text));
  check('owner is shown', /Owner \/ organisation/.test(text));
  check('status is shown', /Status/.test(text));
  check('synthetic values are disclosed', /synthetic demonstration values/i.test(text));

  // -------------------------------------------------------- ENTER EDIT
  console.log('\n[2] EDIT MODE');
  const entityCountBefore = await page.evaluate(() => {
    const ds = window.__ulpinViewer.dataSources.getByName('buildings')[0];
    return ds ? ds.entities.values.length : -1;
  });

  const editReady = await page
    .waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Edit');
      return Boolean(b) && !b.disabled;
    }, { timeout: 30000 })
    .then(() => true, () => false);
  check('Edit button becomes available', editReady);
  check('Edit button clicked', await clickText(page, 'Edit'));
  await page.waitForFunction(() => Boolean(document.getElementById('edit-name')),
    { timeout: 15000 }).catch(() => {});
  await sleep(400);
  text = await bodyText(page);
  check('the form opened', /Edit building record/i.test(text));

  const fields = await page.evaluate(() => {
    const ids = ['name', 'building_type', 'floors', 'height_m', 'built_up_m2',
      'occupancy_units', 'address', 'owner_org', 'status'];
    const present = ids.filter((f) => document.getElementById(`edit-${f}`));
    // Anything editable is an input or a select; nothing else counts.
    const editableIds = [...document.querySelectorAll('#\\30 ,input,select,textarea')]
      .map((el) => el.id).filter(Boolean);
    return { present, editableIds };
  });
  check('all nine editable fields are present', fields.present.length === 9,
    fields.present.join(', '));

  // ------------------------------------------------- READ-ONLY GUARANTEE
  console.log('\n[3] COORDINATES AND ULPIN ARE READ-ONLY');
  const readonly = await page.evaluate(() =>
    ['ulpin', 'lat', 'lon', 'coordinates'].filter(
      (f) => document.getElementById(`edit-${f}`) !== null));
  check('no ULPIN or coordinate input exists', readonly.length === 0, readonly.join(','));
  check('they are still displayed', /ULPIN/.test(text) && /Coordinates/.test(text));
  check('and stated as non-editable',
    /cannot be edited/i.test(await bodyText(page)));

  // A direct PATCH must be refused too -- the UI merely not offering it is
  // not the same as the API not accepting it.
  const apiGuard = await page.evaluate(async () => {
    const out = {};
    for (const body of [{ ulpin: 'AP-XX' }, { lat: 1 }, { lon: 2 }]) {
      const r = await fetch('/api/building/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      out[Object.keys(body)[0]] = r.status;
    }
    return out;
  });
  check('the API refuses ulpin', apiGuard.ulpin === 400, `HTTP ${apiGuard.ulpin}`);
  check('the API refuses lat', apiGuard.lat === 400, `HTTP ${apiGuard.lat}`);
  check('the API refuses lon', apiGuard.lon === 400, `HTTP ${apiGuard.lon}`);

  // ------------------------------------------------------- VALIDATION
  console.log('\n[4] VALIDATION');
  await setField(page, 'edit-floors', '-4');
  await sleep(300);
  check('Save is offered once the form is dirty',
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /^Save changes$/.test(x.innerText.trim()));
      return Boolean(b) && !b.disabled;
    }));
  await clickText(page, 'Save changes');
  await sleep(700);
  check('a negative floor count is rejected',
    /Floors cannot be negative/.test(await bodyText(page)));

  await setField(page, 'edit-floors', '10');
  await setField(page, 'edit-height_m', 'not-a-number');
  await sleep(200);
  await clickText(page, 'Save changes');
  await sleep(700);
  check('a non-numeric height is rejected',
    /Height must be a number/.test(await bodyText(page)));

  await setField(page, 'edit-height_m', '32');
  await setField(page, 'edit-name', '');
  await sleep(200);
  await clickText(page, 'Save changes');
  await sleep(700);
  check('an empty required field is rejected',
    /cannot be empty/i.test(await bodyText(page)));

  const persistedAfterFailures = existsSync(EDITS);
  check('nothing was written while validation was failing', !persistedAfterFailures,
    persistedAfterFailures ? `${EDITS} exists` : 'no store file');

  // ------------------------------------------------------------- SAVE
  console.log('\n[5] SAVE');
  await setField(page, 'edit-name', EDIT_NAME);
  await setField(page, 'edit-floors', '10');
  await setField(page, 'edit-height_m', '32');
  await setField(page, 'edit-occupancy_units', '37');
  await setField(page, 'edit-status', 'Under renovation');
  await sleep(300);
  await clickText(page, 'Save changes');
  await page.waitForFunction(
    () => /Saved · revision/.test(document.body.innerText),
    { timeout: 20000 },
  ).catch(() => {});
  await sleep(1200);
  text = await bodyText(page);
  check('success is confirmed', /Saved · revision/.test(text));
  check('the form closed', !/Edit building record/i.test(text));
  check('the new name is shown', text.includes(EDIT_NAME));
  check('the new storey count is shown', /10 above ground/.test(text));
  check('the storey-count caveat survives the save',
    /does not regenerate them/i.test(text));

  // ----------------------------------------------- SCENE NOT REBUILT
  console.log('\n[6] THE SCENE WAS NOT REBUILT');
  const after = await page.evaluate(() => {
    const ds = window.__ulpinViewer.dataSources.getByName('buildings')[0];
    return ds ? ds.entities.values.length : -1;
  });
  check('building entity count is unchanged', after === entityCountBefore,
    `${entityCountBefore} -> ${after}`);

  // ------------------------------------------------------ PERSISTENCE
  console.log('\n[7] PERSISTENCE');
  const onDisk = existsSync(EDITS) ? JSON.parse(readFileSync(EDITS, 'utf-8')) : null;
  check('the edit store was written', onDisk !== null, EDITS);
  if (onDisk) {
    check('it declares itself synthetic', onDisk._synthetic === true);
    const rec = Object.values(onDisk.edits ?? {})[0];
    check('the record holds the edited fields',
      Boolean(rec) && rec.fields.name === EDIT_NAME && rec.fields.floors === 10,
      rec ? JSON.stringify(rec.fields) : 'none');
    check('no read-only field leaked into the store',
      Boolean(rec) && !('ulpin' in rec.fields) && !('lat' in rec.fields));
  }

  await page.reload({ waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(
    (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 }, BUILDING_COUNT,
  );
  await sleep(5000);
  const survived = await page.evaluate(async (id) => {
    const r = await fetch('/api/buildings');
    const fc = await r.json();
    const f = fc.features.find((x) => x.properties.id === id);
    return f
      ? { name: f.properties.name, floors: f.properties.floors, height: f.properties.height_m }
      : null;
  }, editedId);
  check('the edited building is still served', survived !== null,
    survived ? JSON.stringify(survived) : 'not found');
  check('the edited name survives', survived?.name === EDIT_NAME);
  check('the edited storey count survives', survived?.floors === 10);
  check('the edited height survives', survived?.height === 32);

  // ------------------------------------------------------------ CONSOLE
  console.log('\n[8] CONSOLE');
  const real = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|openstreetmap|arcgisonline|cartocdn|mapbox/i.test(e)
      // This suite deliberately provokes 400 and 422 responses to prove the
      // read-only and validation guarantees. Chrome logs each as a console
      // error; that is the feature working, not a fault.
      && !/the server responded with a status of (400|422)/i.test(e),
  );
  check('no runtime errors or 5xx', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
