import '@/lib/cesium/base-url';
import type * as Cesium from 'cesium';

/**
 * GPU capability detection and the performance profile that follows from it.
 *
 * The AOI scene is cheap by CAD standards but not by laptop-fan standards:
 * 384 textured extrusions, terrain, imagery and (in Photoreal) a streamed
 * Google mesh. The same defaults that look great on a gaming laptop stutter on
 * the integrated-GPU school lab machines this will actually be demoed on, so
 * the viewer asks the GPU what it is and configures the scene accordingly.
 *
 * Three ideas live here:
 *
 *   1. detectWeakGpu() — one throwaway WebGL context, read the renderer
 *      string. Software rasterisers (SwiftShader/llvmpipe) and pre-2014
 *      mobile GPUs are "weak"; everything else gets the full-quality path.
 *   2. applyPerformanceProfile() — the one place scene-quality knobs are set,
 *      so a tuning change does not have to be hunted across components.
 *   3. attachAdaptiveResolution() — a render-loop watchdog that lowers
 *      viewer.resolutionScale when sustained frame times are bad and raises
 *      it back when there is headroom. It samples only rendered frames, so an
 *      idle scene (requestRenderMode) never triggers it.
 *
 * Everything here is best-effort: any probe failure degrades to the weak
 * profile, which renders correctly everywhere.
 */

/** Renderers that indicate no real GPU acceleration is available. */
const SOFTWARE_PATTERNS =
  /swiftshader|llvmpipe|softpipe|software renderer|software webgl|basic render/i;

/** Below this max texture size the GPU predates the imagery we stream. */
const MIN_MAX_TEXTURE_SIZE = 4096;

/**
 * Probe the WebGL implementation. True when the scene should run the
 * reduced-quality profile: software rasterisers, ancient mobile GPUs, or any
 * context that fails to open at all.
 */
export function detectWeakGpu(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2')
      ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    // No WebGL: the viewer will fall back to software or fail outright.
    // Pretending to be strong here would only make the failure heavier.
    if (!gl) return true;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    if (SOFTWARE_PATTERNS.test(renderer)) return true;

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    return typeof maxTex === 'number' && maxTex < MIN_MAX_TEXTURE_SIZE;
  } catch {
    return true;
  }
}

export interface PerformanceProfile {
  lowEnd: boolean;
}

/**
 * Apply the quality profile to a freshly constructed viewer.
 *
 * Weak GPU: render at 1.0 CSS pixel per pixel (a DPR-3 phone canvas is 9x
 * the fragments of a DPR-1 one for the same view), accept slightly coarser
 * globe tiles (maximumScreenSpaceError 3.5 vs the 2 default), keep a smaller
 * tile cache, skip MSAA and lean on FXAA instead -- one cheap full-screen
 * pass rather than 4x multisampled geometry.
 *
 * Strong GPU: leave the sharp defaults in place and spend the headroom on
 * 4x MSAA (WebGL2 render-target multisampling -- the antialiasing that makes
 * the roof ridge lines and floor rims read cleanly) and a deeper tile cache
 * so panning around the AOI does not re-fetch tiles it just dropped.
 */
export function applyPerformanceProfile(
  viewer: Cesium.Viewer,
  profile: PerformanceProfile,
): void {
  const scene = viewer.scene;
  if (profile.lowEnd) {
    viewer.useBrowserRecommendedResolution = false;
    scene.globe.maximumScreenSpaceError = 3.5;
    scene.globe.tileCacheSize = 60;
    scene.postProcessStages.fxaa.enabled = true;
  } else {
    scene.globe.tileCacheSize = 200;
    scene.postProcessStages.fxaa.enabled = false;
  }
}

/**
 * Frame-time watchdog.
 *
 * Samples the interval between rendered frames; after a warm-up window of
 * real frames it steps viewer.resolutionScale down (to a floor of 0.5) while
 * the GPU cannot hold ~18 fps and back up toward 1.0 when it easily holds
 * ~40. Steps are rate-limited so a single stuttery camera flight cannot
 * oscillate the scale.
 *
 * Returns a disposer, like the postRender listener it owns.
 */
export function attachAdaptiveResolution(viewer: Cesium.Viewer): () => void {
  const MIN_SCALE = 0.5;
  const STEP = 0.15;
  const BAD_MS = 55;     // sustained average above this -> step down
  const GOOD_MS = 24;    // sustained average below this -> step back up
  const WARMUP_FRAMES = 60;
  const COOLDOWN_MS = 4000;

  let last = 0;
  let samples = 0;
  let total = 0;
  let lastStep = 0;

  const onFrame = () => {
    if (viewer.isDestroyed()) return;
    const now = performance.now();
    if (last > 0) {
      const dt = now - last;
      // Ignore absurd gaps (tab was hidden, debugger paused) rather than
      // letting one of them dominate the average.
      if (dt < 1000) {
        samples++;
        total += dt;
      }
      if (samples >= WARMUP_FRAMES && now - lastStep > COOLDOWN_MS) {
        const avg = total / samples;
        const scale = viewer.resolutionScale;
        if (avg > BAD_MS && scale > MIN_SCALE) {
          viewer.resolutionScale = Math.max(MIN_SCALE, scale - STEP);
          // A smaller backbuffer needs at least one re-render to matter.
          viewer.scene.requestRender();
          lastStep = now;
          samples = 0; total = 0;
        } else if (avg < GOOD_MS && scale < 1) {
          viewer.resolutionScale = Math.min(1, scale + STEP);
          viewer.scene.requestRender();
          lastStep = now;
          samples = 0; total = 0;
        }
      }
    }
    last = now;
  };

  viewer.scene.postRender.addEventListener(onFrame);
  return () => {
    if (!viewer.isDestroyed()) viewer.scene.postRender.removeEventListener(onFrame);
  };
}
