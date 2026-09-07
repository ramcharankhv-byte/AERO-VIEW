/**
 * The headless Chrome the acceptance scripts drive, and the GPU it renders on.
 *
 * WHY THIS FILE EXISTS. Nine scripts each carried their own copy of the same
 * launch arguments, and every copy pinned `--use-angle=swiftshader`: Chrome's
 * SOFTWARE rasteriser. That was a reasonable default when the only thing the
 * frame had to prove was that a polygon existed, and it is the wrong default
 * now, for two separate reasons:
 *
 *   1. It cannot render what is being checked. Shadow maps, ambient occlusion
 *      and MSAA are GPU features; under swiftshader they are either absent or
 *      so slow the frame never settles. A screenshot taken there says nothing
 *      about how the scene looks on the machine a reviewer is using.
 *   2. It is why `verify:ui` was flaky. docs/perf/decisions-log.md records the
 *      walk being abandoned to a "Puppeteer/headless-Cesium protocol timeout"
 *      while the page itself served fine -- a software rasteriser holding the
 *      main thread long enough that `page.evaluate` never resolves.
 *
 * THE DEFAULT IS NOW THE GPU. `--use-angle=d3d11` binds ANGLE to the real
 * adapter on Windows; `gl` is the equivalent on Linux/macOS. Chrome still falls
 * back to swiftshader on its own if no adapter can be acquired, which is why
 * `--enable-unsafe-swiftshader` stays in the list -- it is the fallback's
 * permission slip, not the request.
 *
 * ULPIN_GPU=0 restores the previous software arguments verbatim, for a CI box
 * with no adapter or for reproducing a result recorded under the old backend.
 * Nothing here changes what any check ASSERTS; it changes what the assertions
 * get to look at.
 */

/**
 * How long a single CDP call may take before puppeteer gives up.
 *
 * Puppeteer's default is 180 s, and several checks ask page.waitForFunction to
 * wait 240-300 s for Cesium to report its building count. Those two numbers
 * disagree: the transport abandons the call at 180 s and the script reports
 * "Waiting failed / Runtime.callFunctionOn timed out" long before its own
 * deadline. check_basemap.mjs already carried a local workaround; this is that
 * workaround, stated once, so a script's stated patience is the patience it
 * actually gets.
 *
 * It is a ceiling, not a delay. A run that is healthy never reaches it.
 */
export const PROTOCOL_TIMEOUT_MS = 900000;

/** Windows binds ANGLE to D3D11; everything else to desktop GL. */
const GPU_BACKEND = process.platform === 'win32' ? 'd3d11' : 'gl';

/** Explicitly opted out of the GPU. */
export const softwareOnly = process.env.ULPIN_GPU === '0';

/**
 * Launch arguments for an acceptance run.
 *
 * `window` is the `--window-size` value; omit it for the scripts that size the
 * viewport per-shot instead (shoot.mjs walks four viewports in one browser).
 */
export function chromeArgs({ window = null, hideScrollbars = true, noSandbox = true } = {}) {
  const args = ['--use-gl=angle'];

  if (softwareOnly) {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  } else {
    args.push(
      `--use-angle=${GPU_BACKEND}`,
      // Headless Chrome disables the GPU by default; this is the flag that
      // actually gets an adapter, and without it the backend above is ignored.
      '--enable-gpu',
      // Kept for the fallback path only: if no adapter can be acquired Chrome
      // drops to swiftshader, and refuses to do so unmarked.
      '--enable-unsafe-swiftshader',
    );
  }

  if (window) args.unshift(`--window-size=${window}`);
  if (hideScrollbars) args.push('--hide-scrollbars');
  if (noSandbox) args.push('--no-sandbox');
  return args;
}

/**
 * Print the backend that actually bound.
 *
 * A run should not have to be trusted about which rasteriser it used. This
 * reads WEBGL_debug_renderer_info off a throwaway context -- the same string
 * lib/cesium/perf.ts pattern-matches to decide the low-end profile -- and says
 * so once, before the first assertion.
 *
 * Never throws: a script's job is to check the app, not to check this file.
 */
export async function reportBackend(page) {
  const renderer = await page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return null;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    } catch {
      return null;
    }
  }).catch(() => null);

  const software = renderer !== null && /swiftshader|llvmpipe|software/i.test(renderer);
  const asked = softwareOnly ? 'software (ULPIN_GPU=0)' : `gpu (${GPU_BACKEND})`;
  console.log(`  renderer             : ${renderer ?? 'no WebGL context'}  [asked for ${asked}]`);
  // Only worth a warning when the GPU was requested and not obtained -- the
  // run still proceeds, it just cannot speak to shadows or AO.
  if (!softwareOnly && software) {
    console.log('  NOTE: fell back to software rendering; lighting-dependent frames are not representative');
  }
  return { renderer, software };
}

/**
 * Hand the page a signed session, if the run was given one.
 *
 * The viewer and the gallery redirect an anonymous browser to /login, and this
 * harness has no login step, so an acceptance run passes a real cookie:
 *
 *   ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
 *
 * verify_ui and shoot already did this privately. check_roads, check_edit,
 * check_photoreal, check_ion and check_basemap did not -- so against a server
 * with auth enforced they navigated to the viewer, were redirected to /login,
 * and then waited out their full readiness timeout for a status bar that was
 * never going to render. The failure surfaced as "Waiting failed: 300000ms
 * exceeded" pointing at the wait, which is the symptom and not the cause.
 * Sharing one implementation is what stops the next script forgetting.
 *
 * Unset, the page loads anonymously exactly as before.
 */
export async function applySession(page, url) {
  const value = process.env.ULPIN_SESSION_COOKIE;
  if (!value) return;
  const u = new globalThis.URL(url);
  await page.setCookie({
    name: 'ulpin_session', value, domain: u.hostname, path: '/',
    httpOnly: true, sameSite: 'Lax',
  });
}
