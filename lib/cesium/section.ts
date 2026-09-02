import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { clipRingToHalfPlane, flatLonLat, type HalfPlane } from '@/lib/geo';

/**
 * Section-cut plumbing shared by every sliceable layer.
 *
 * WHY THIS IS CPU WORK. Cesium exposes ClippingPlaneCollection on a Globe, a
 * Model and a Cesium3DTileset only. Everything the slice has to cut here --
 * floor plates, floor shells, unit volumes, stack slabs -- is entity geometry,
 * drawn through a Primitive, which carries no clippingPlanes property at all.
 * So the half-plane defined by lib/geo's slicePlane() is applied to the RINGS
 * instead, and the cut geometry is fed back through the same CallbackProperty
 * mechanism the rest of the app animates with. The plane itself is still
 * computed in exactly one place, so no two layers can disagree about the cut.
 *
 * COST. The clip only re-runs when `version` changes -- once per slider tick,
 * not once per frame -- and the resulting PolygonHierarchy is handed back by
 * reference, so a static scene re-reads a cached object.
 */

export interface SectionSource {
  /** Bumped by the layer whenever the plane changes. -1 is never a valid value. */
  version: number;
  /** Null when slice is off: the ring is passed through untouched. */
  plane: HalfPlane | null;
}

export interface SectionedRing {
  /** Feed this to PolygonGraphics.hierarchy. */
  hierarchy: Cesium.CallbackProperty;
  /** False once the plane has cut the ring away entirely -- hide the entity. */
  survives: () => boolean;
}

function hierarchyOf(ring: number[][]): Cesium.PolygonHierarchy {
  return new Cesium.PolygonHierarchy(
    Cesium.Cartesian3.fromDegreesArray(flatLonLat(ring)),
  );
}

/**
 * A polygon hierarchy that follows the current section plane.
 *
 * When the plane removes the ring completely the LAST surviving hierarchy is
 * kept and `survives()` reports false: Cesium throws on a polygon with fewer
 * than three positions, so the entity is hidden rather than emptied.
 */
export function sectionedRing(
  ring: number[][],
  read: () => SectionSource,
): SectionedRing {
  let seen = -1;
  let hierarchy = hierarchyOf(ring);
  let alive = true;

  const refresh = () => {
    const { version, plane } = read();
    if (version === seen) return;
    seen = version;
    if (!plane) {
      hierarchy = hierarchyOf(ring);
      alive = true;
      return;
    }
    const cut = clipRingToHalfPlane(ring, plane);
    // A closed ring needs four entries to yield three distinct positions.
    alive = cut.length >= 4;
    if (alive) hierarchy = hierarchyOf(cut);
  };

  return {
    hierarchy: new Cesium.CallbackProperty(() => {
      refresh();
      return hierarchy;
    }, false),
    survives: () => {
      refresh();
      return alive;
    },
  };
}
