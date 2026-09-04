/**
 * Buildings style acceptance check.
 *
 * Verifies the [Schematic | Photoreal] toggle end to end in a real Chrome:
 * that Schematic is the default and carries the repeating facade texture, that
 * Photoreal loads Google's tileset as a scene primitive and takes World
 * Terrain and the globe surface off while it is up, that the schematic
 * extrusions stay PICKABLE underneath it so the ULPIN panel and floor ladder
 * keep working, that switching back restores terrain and destroys the tileset,
 * and that the choice round-trips through the URL.
 *
 * Companion to check_basemap.mjs (imagery) and check_ion.mjs (terrain).
 *
 * Usage: node scripts/check_photoreal.mjs [outDir]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? path.join(process.cwd(), 'docs', 'shots');
// `/` is the project gallery now; the viewer lives at /p/<slug>.
const APP_URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';
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
  await page.waitForFunction(() => Boolean(window.__ulpinViewer), { timeout: 60000 });
  await sleep(8000); // terrain sampling + first tiles
}

/** Scene facts that have no DOM representation. */
const sceneState = (page) =>
  page.evaluate(() => {
    const v = window.__ulpinViewer;
    const prims = v.scene.primitives;
    let tilesets = 0;
    for (let i = 0; i < prims.length; i++) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === 'Cesium3DTileset') tilesets++;
    }
    return {
      tilesets,
      globeShow: v.scene.globe.show,
      terrain: v.terrainProvider.constructor.name,
      // The building extrusions live on the 'buildings' data source; read the
      // alpha the material callback is actually producing this frame.
      buildingAlpha: (() => {
        for (let i = 0; i < v.dataSources.length; i++) {
          const ds = v.dataSources.get(i);
          if (ds.name !== 'buildings') continue;
          const e = ds.entities.values[0];
          if (!e) return null;
          const c = e.polygon.material.color.getValue(v.clock.currentTime);
          return Math.round(c.alpha * 1000) / 1000;
        }
        return null;
      })(),
      // Proves the facade texture is on, and repeats once per storey.
      repeat: (() => {
        for (let i = 0; i < v.dataSources.length; i++) {
          const ds = v.dataSources.get(i);
          if (ds.name !== 'buildings') continue;
          const e = ds.entities.values[0];
          const r = e?.polygon?.material?.repeat?.getValue(v.clock.currentTime);
          return r ? { x: r.x, y: r.y } : null;
        }
        return null;
      })(),
    };
  });

/**
 * The live address bar. puppeteer's page.url() tracks navigations and lags a
 * history.replaceState by an unpredictable amount, so read location directly.
 */
const href = (page) => page.evaluate(() => window.location.href);

/** Click a segmented-toggle button by its visible label. */
async function clickButton(page, label) {
  const ok = await page.evaluate((text) => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === text);
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!ok) throw new Error(`button "${label}" not found`);
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
  ],
  defaultViewport: { width: 1680, height: 950 },
});

const page = await browser.newPage();

const googleRequests = [];
page.on('request', (r) => {
  const u = r.url();
  if (/googleapis|google\.com\/maps|tile\.googleapis/.test(u)) googleRequests.push(u);
});
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

try {
  // ---- 1. Schematic is the default -------------------------------------
  console.log('\n[1] Schematic default');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await waitForScene(page);

  const style0 = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((b) => ['Schematic', 'Photoreal'].includes(b.textContent.trim()))
      .map((b) => ({ label: b.textContent.trim(), on: b.getAttribute('aria-checked') })));
  check('toggle renders both styles', style0.length === 2, JSON.stringify(style0));
  check(
    'Schematic is selected by default',
    style0.find((s) => s.label === 'Schematic')?.on === 'true',
  );

  const s0 = await sceneState(page);
  check('no tileset in the scene', s0.tilesets === 0, `tilesets=${s0.tilesets}`);
  check('globe surface is drawn', s0.globeShow === true);
  check(
    'World Terrain is active',
    s0.terrain !== 'EllipsoidTerrainProvider',
    s0.terrain,
  );
  check(
    'facade texture repeats once per storey',
    s0.repeat !== null && s0.repeat.x === 1 && s0.repeat.y >= 1,
    JSON.stringify(s0.repeat),
  );
  check(
    'schematic extrusions are visible',
    s0.buildingAlpha !== null && s0.buildingAlpha > 0.5,
    `alpha=${s0.buildingAlpha}`,
  );
  const url0 = await href(page);
  check(
    'clean URL carries no style param',
    !new URL(url0).searchParams.has('style'),
    url0,
  );
  await page.screenshot({ path: path.join(OUT, 'style-1-schematic.png') });

  // ---- 2. Switch to Photoreal ------------------------------------------
  console.log('\n[2] Photoreal');
  await clickButton(page, 'Photoreal');
  // URL writes are coalesced to one per animation frame, so the address bar
  // lags the click by a frame by design.
  await sleep(500);
  const url1 = await href(page);
  check(
    'URL records the choice',
    new URL(url1).searchParams.get('style') === 'photoreal',
    url1,
  );

  // Either the tileset loads, or the app falls back and says so. Both are
  // acceptable outcomes for this check; only silence is not.
  await page.waitForFunction(
    () => {
      const v = window.__ulpinViewer;
      for (let i = 0; i < v.scene.primitives.length; i++) {
        const p = v.scene.primitives.get(i);
        if (p && p.constructor && p.constructor.name === 'Cesium3DTileset') return true;
      }
      return /Photoreal unavailable/.test(document.body.innerText);
    },
    { timeout: 120000 },
  );
  await sleep(10000); // let tiles stream in

  const fellBack = await page.evaluate(() =>
    /Photoreal unavailable/.test(document.body.innerText));

  if (fellBack) {
    // The fallback path is a valid result — assert it is a real fallback and
    // not a broken scene, then skip the tiles-specific assertions.
    console.log('  NOTE  Google tiles did not load; verifying the fallback path.');
    const sf = await sceneState(page);
    check('fell back to Schematic', (await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Schematic')
        ?.getAttribute('aria-checked'))) === 'true');
    check('no orphan tileset left behind', sf.tilesets === 0);
    check('terrain restored on fallback', sf.terrain !== 'EllipsoidTerrainProvider', sf.terrain);
    check('globe redrawn on fallback', sf.globeShow === true);
    check('buildings visible again', sf.buildingAlpha > 0.5, `alpha=${sf.buildingAlpha}`);
    await page.screenshot({ path: path.join(OUT, 'style-2-fallback.png') });
  } else {
    const s1 = await sceneState(page);
    check('Google tileset added to scene.primitives', s1.tilesets === 1, `tilesets=${s1.tilesets}`);
    check('Google tiles were actually requested', googleRequests.length > 0,
      `${googleRequests.length} requests`);
    check('World Terrain disabled', s1.terrain === 'EllipsoidTerrainProvider', s1.terrain);
    check('globe surface hidden under the tiles', s1.globeShow === false);
    check(
      'schematic extrusion ghosted to ~0.01, not hidden',
      s1.buildingAlpha !== null && s1.buildingAlpha > 0 && s1.buildingAlpha <= 0.02,
      `alpha=${s1.buildingAlpha}`,
    );
    await page.screenshot({ path: path.join(OUT, 'style-2-photoreal.png') });

    // ---- 3. Picking still works through the tiles ----------------------
    console.log('\n[3] Picking through the tiles');
    // Drive the store the way a click would, then confirm the ghosted
    // geometry is genuinely what a ray hits: drillPick must find a tagged
    // building entity even though Google's mesh is in front of it.
    // scene.drillPick only reads .x/.y off its argument, so a plain object
    // stands in for a Cartesian2 without needing Cesium in page scope.
    const drill = await page.evaluate(() => {
      const v = window.__ulpinViewer;
      const canvas = v.scene.canvas;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      let tiles = 0;
      let tagged = 0;
      let taggedBehindTiles = 0;
      // Sweep a grid; the AOI does not fill every pixel of the view.
      for (let dx = -260; dx <= 260; dx += 40) {
        for (let dy = -160; dy <= 160; dy += 40) {
          const list = v.scene.drillPick({ x: cx + dx, y: cy + dy }, 4);
          if (list.length === 0) continue;
          const kinds = list.map((p) => {
            const id = p && p.id;
            const ent = id && typeof id === 'object' ? id : p;
            return ent && ent.tag ? ent.tag.kind : 'untagged';
          });
          if (kinds[0] === 'untagged') tiles++;
          const at = kinds.indexOf('building');
          if (at >= 0) {
            tagged++;
            if (at > 0) taggedBehindTiles++;
          }
        }
      }
      return { tiles, tagged, taggedBehindTiles };
    });
    check(
      'drillPick reaches a tagged building through the mesh',
      drill.tagged > 0,
      JSON.stringify(drill),
    );
    // Only meaningful once Google's mesh has actually streamed in far enough
    // to be the front-most hit somewhere. Under software rasterisation tile
    // loading is slow and patchy, and asserting occlusion that has not
    // happened yet tests the harness, not the app.
    if (drill.tiles >= 20) {
      check(
        'ghosted extrusions sit behind the tiles and are still hit',
        drill.taggedBehindTiles > 0,
        JSON.stringify(drill),
      );
    } else {
      console.log(
        `  SKIP  occlusion check — only ${drill.tiles} tile hits, mesh not streamed in`,
      );
    }

    // The real gesture: click one of those hits and confirm the downstream UI
    // (the ULPIN card) comes up while photoreal tiles are on screen.
    const clicked = await page.evaluate(() => {
      const v = window.__ulpinViewer;
      const canvas = v.scene.canvas;
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      for (let dx = -260; dx <= 260; dx += 40) {
        for (let dy = -160; dy <= 160; dy += 40) {
          const list = v.scene.drillPick({ x: cx + dx, y: cy + dy }, 4);
          for (const p of list) {
            const id = p && p.id;
            const ent = id && typeof id === 'object' ? id : p;
            if (ent && ent.tag && ent.tag.kind === 'building') {
              return { x: Math.round(cx + dx), y: Math.round(cy + dy) };
            }
          }
        }
      }
      return null;
    });
    if (clicked) {
      await page.mouse.click(clicked.x, clicked.y);
      await sleep(3500);
    }
    const panel = await page.evaluate(() => document.body.innerText);
    check(
      'ULPIN panel opens from a pick under photoreal',
      /ULPIN/i.test(panel),
      clicked ? `clicked ${clicked.x},${clicked.y}` : 'no pickable building found',
    );
    check(
      'floor ladder / storey data reachable under photoreal',
      /Storeys|Floor/i.test(panel),
    );
    await page.screenshot({ path: path.join(OUT, 'style-2b-photoreal-pick.png') });
  }

  // ---- 4. Back to Schematic --------------------------------------------
  console.log('\n[4] Back to Schematic');
  await clickButton(page, 'Schematic');
  // Step 3 left a building selected, which fades every OTHER building down to
  // the transparency slider. Clear it, or the alpha read below is measuring
  // the fade rather than the return from the photoreal ghost.
  await clickButton(page, 'Reset view');
  await sleep(4000);
  const s2 = await sceneState(page);
  check('tileset removed from the scene', s2.tilesets === 0, `tilesets=${s2.tilesets}`);
  check('World Terrain restored', s2.terrain !== 'EllipsoidTerrainProvider', s2.terrain);
  check('globe surface redrawn', s2.globeShow === true);
  check(
    'extrusions opaque again',
    s2.buildingAlpha !== null && s2.buildingAlpha > 0.5,
    `alpha=${s2.buildingAlpha}`,
  );
  const url2 = await href(page);
  check(
    'style param dropped from a default URL',
    !new URL(url2).searchParams.has('style'),
    url2,
  );
  await page.screenshot({ path: path.join(OUT, 'style-3-back.png') });

  // ---- 5. URL round-trip ------------------------------------------------
  console.log('\n[5] URL round-trip');
  await page.goto(`${APP_URL}?style=photoreal&x=40&t=55&layers=pbfm`, {
    waitUntil: 'domcontentloaded',
  });
  await waitForScene(page);
  const hydrated = await page.evaluate(() => {
    const on = (t) => [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === t)?.getAttribute('aria-checked');
    const checks = [...document.querySelectorAll('label')]
      .map((l) => l.textContent.trim());
    return {
      photoreal: on('Photoreal'),
      schematic: on('Schematic'),
      text: document.body.innerText,
      labels: checks,
    };
  });
  check(
    'style=photoreal hydrates the toggle',
    hydrated.photoreal === 'true' || /Photoreal unavailable/.test(hydrated.text),
    `photoreal=${hydrated.photoreal}`,
  );
  check(
    'explode/transparency hydrate from the URL',
    /40%/.test(hydrated.text) && /55%/.test(hydrated.text),
  );
  await page.screenshot({ path: path.join(OUT, 'style-4-url.png') });

  // ---- 6. No console errors --------------------------------------------
  const realErrors = consoleErrors.filter(
    (e) => !/favicon|Download the React DevTools|sourcemap/i.test(e),
  );
  check(
    'no unexpected console errors',
    realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '),
  );
} catch (err) {
  check(`harness completed`, false, String(err));
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
