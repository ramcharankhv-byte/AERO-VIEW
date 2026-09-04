/**
 * Boot timeline marks.
 *
 * Plain `performance.mark()` calls, so the boot sequence is legible in the
 * DevTools performance panel and readable by scripts/perf_probe.mjs without
 * either of them having to guess from DOM side effects. Marks cost a few
 * microseconds each and are left in production deliberately: a startup budget
 * that is only measurable in a special build is a budget nobody checks.
 *
 * The names are the contract. perf_probe.mjs reads them by name, so renaming
 * one is a breaking change to the harness.
 */

/** Every mark this module may emit, in the order boot produces them. */
export type BootMark =
  | 'boot-start'          // CesiumRoot mount effect entered
  | 'terrain-ready'       // terrain provider resolved (ion round-trip done)
  | 'viewer-created'      // Cesium.Viewer constructed, first frame possible
  | 'scene-configured'    // scene knobs + initial camera applied
  | 'data-fetched'        // /api/* payloads parsed
  | 'ground-sampled'      // terrain heights sampled under every footprint
  | 'layers-mounted'      // children mounted: layer effects may now run
  | 'buildings-built'     // BuildingsLayer finished creating its entities
  | 'context-ready';      // full-detail context published to every layer

const PREFIX = 'ulpin:';

export function mark(name: BootMark): void {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
  try {
    performance.mark(PREFIX + name);
  } catch {
    /* marks are diagnostics; never let one break boot */
  }
}
