'use client';

/**
 * The scene's lighting rig: the parts of it nothing else already owns.
 *
 * WHAT THIS FILE DOES NOT OWN, deliberately, because three other modules got
 * there first and their reasoning is recorded where they live:
 *
 *   - `globe.enableLighting`, `viewer.shadows` and the shadow map belong to
 *     lib/cesium/sun.ts. It is driven by the Sun slider, it has to be able to
 *     turn all of that back OFF at the slider's null position, and it is the
 *     one place allowed to re-enable lighting after applyGisDarkScene() pins
 *     it off. A second writer here would fight it on every slider move.
 *   - FXAA and MSAA belong to lib/cesium/perf.ts, which spends a strong GPU's
 *     headroom on 4x multisampling and falls back to FXAA only on a weak one.
 *     Forcing FXAA on unconditionally would make the better machine look
 *     worse, which is the opposite of the intent.
 *   - The imagery exposure, the globe base colour and the fog DENSITY belong
 *     to applyGisDarkScene() in lib/cesium/imagery.ts, which is where the
 *     ground's treatment is decided as a whole.
 *
 * What is left, and what this file is for, is ambient occlusion: the one piece
 * of the "lit city" that was genuinely missing. A low sun already tells you a
 * building is tall by the shadow it throws across the ground. AO is what tells
 * you a street is narrow -- it darkens the contact between a wall and the
 * ground and the gap between two blocks, at a scale the shadow map is far too
 * coarse to resolve.
 *
 * Run once, from CesiumRoot's mount effect, after configureScene().
 */
import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { AMBIENT_OCCLUSION } from './materials';

/**
 * Why the scene light is not replaced.
 *
 * `new Cesium.SunLight()` is a real constructor in 1.126.0 and assigning it to
 * `scene.light` is exactly what the Cesium docs show -- but it is also already
 * what a Scene constructs for itself, so the assignment is a no-op dressed as
 * a change. The tunable that is NOT a no-op is the existing light's intensity,
 * so that is what this exposes.
 *
 * 1.0 is Cesium's own default and what this ships with. It is stated here
 * rather than left implicit because the next person to want a brighter scene
 * will reach for `scene.light = new SunLight()` first, find nothing happens,
 * and need this comment.
 */
const SUN_INTENSITY = 1.0;

/** What the rig managed to turn on, for the StatusBar to report. */
export interface LightingState {
  /** HBAO is running. False means unsupported or deliberately skipped. */
  ambientOcclusion: boolean;
  /** Why it is off, when it is off. Null when it is on. */
  reason: 'unsupported' | 'low-end' | null;
}

/**
 * Apply the rig.
 *
 * `lowEnd` is the same profile flag lib/cesium/perf.ts computes from
 * WEBGL_debug_renderer_info; AO is skipped on those machines rather than
 * degraded, because a full-screen horizon-based ray march is precisely the
 * kind of per-fragment cost the low-end profile exists to avoid. That is a
 * choice, not a limitation, and it is reported as `low-end` rather than as
 * `unsupported` so the StatusBar can tell the two apart.
 */
export function applyLighting(viewer: Cesium.Viewer, lowEnd: boolean): LightingState {
  const scene = viewer.scene;

  // See SUN_INTENSITY above for why this is the knob and the constructor is not.
  scene.light.intensity = SUN_INTENSITY;

  const supported = Cesium.PostProcessStageLibrary.isAmbientOcclusionSupported(scene);
  if (!supported || lowEnd) {
    // Leave the stage alone rather than assigning `enabled = false`: an
    // unsupported composite is not guaranteed to have usable uniforms, and the
    // default is off in any case.
    scene.requestRender();
    return { ambientOcclusion: false, reason: !supported ? 'unsupported' : 'low-end' };
  }

  const ao = scene.postProcessStages.ambientOcclusion;
  ao.enabled = true;
  ao.uniforms.intensity = AMBIENT_OCCLUSION.INTENSITY;
  ao.uniforms.lengthCap = AMBIENT_OCCLUSION.LENGTH_CAP_M;
  // `randomTexture` is documented as a uniform that "needs to be set", which
  // reads as a caller obligation and is not one: PostProcessStageCollection
  // creates and owns a 255x255 random texture the first time the AO composite
  // is enabled, and destroys it when it is disabled. Setting one here would
  // leak it. Verified against the installed 1.126.0 build, not assumed.

  // requestRenderMode is on: nothing above repaints on its own.
  scene.requestRender();
  return { ambientOcclusion: true, reason: null };
}
