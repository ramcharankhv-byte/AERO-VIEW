import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { AssetType, Provenance, UseType } from '@/lib/types';

/**
 * Every colour state in the scene, defined once.
 *
 * ARCHITECTURE RULE: no component constructs its own Cesium.Color for entity
 * styling. If a new visual state is needed it is added here, so that "what does
 * gold mean" has exactly one answer in the codebase.
 */

const rgba = (r: number, g: number, b: number, a: number) =>
  Cesium.Color.fromBytes(r, g, b, Math.round(a * 255));

// ---------------------------------------------------------------- buildings
/** Base fill by use type -- muted, so highlights read clearly against them. */
export const USE_COLOR: Record<UseType, Cesium.Color> = {
  residential: rgba(122, 146, 178, 1),
  commercial: rgba(178, 150, 110, 1),
  institutional: rgba(132, 168, 150, 1),
  industrial: rgba(150, 140, 160, 1),
};

/**
 * Tint multiplied over the window-grid facade texture in schematic mode.
 *
 * The raw USE_COLOR would swamp the texture -- multiplying a muted blue over
 * an already-muted brick reads as mud. Lerping 55% toward white keeps the
 * windows legible while the use type still comes through as a hue. Computed
 * once per use type rather than per frame: the material callback runs on every
 * building on every frame.
 */
const FACADE_TINT: Record<UseType, Cesium.Color> = (() => {
  const out = {} as Record<UseType, Cesium.Color>;
  for (const use of Object.keys(USE_COLOR) as UseType[]) {
    out[use] = Cesium.Color.lerp(
      USE_COLOR[use], Cesium.Color.WHITE, 0.55, new Cesium.Color(),
    );
  }
  return out;
})();

export const MATERIALS = {
  /** City mode: a normal, unselected building. */
  buildingDefault: (use: UseType, alpha = 0.92) =>
    USE_COLOR[use].withAlpha(alpha),

  /** Schematic mode: the tint over the repeating facade texture. */
  buildingFacade: (use: UseType, alpha = 0.92) => FACADE_TINT[use].withAlpha(alpha),

  /**
   * Photoreal mode: the schematic extrusion is still there, still tagged, and
   * still hit by scene.pick -- it is just not visible. Alpha 0.01 rather than
   * show:false precisely because a hidden entity is not pickable, and picking
   * is what keeps the ULPIN panel, the floor ladder and the basement conflict
   * checks working while Google's mesh is on screen.
   */
  buildingGhost: Cesium.Color.WHITE.withAlpha(0.01),

  /** Cursor is over it. */
  buildingHover: rgba(120, 205, 255, 1),

  /** Someone else's building while one is active -- faded right back. */
  buildingFaded: (use: UseType, alpha: number) => USE_COLOR[use].withAlpha(alpha),

  /** An above-ground floor slab in the exploded stack. */
  floorSlab: rgba(150, 190, 230, 0.34),

  /** The floor currently isolated -- bright enough to read through the stack. */
  floorActive: rgba(110, 216, 255, 0.72),
  /** Edge of the isolated floor: near-white so the highlight has a crisp rim. */
  floorActiveOutline: rgba(200, 242, 255, 1),

  /** Basements are solid grey -- they read as mass, not as habitable volume. */
  basementSlab: rgba(120, 124, 132, 0.95),

  /** Edge of a floor slab in the stack. */
  floorOutline: rgba(143, 180, 216, 0.5),

  /** A unit volume on the isolated floor. */
  unitDefault: rgba(196, 214, 236, 0.42),

  /** Edge of an unselected unit. */
  unitOutlineIdle: rgba(159, 182, 207, 0.45),

  /** The selected unit: gold, with a silhouette outline. */
  unitSelected: rgba(240, 190, 72, 0.88),
  unitOutline: rgba(255, 226, 140, 1),

  /** Surface parcel polygons, clamped to ground. */
  parcelFill: rgba(90, 170, 140, 0.16),
  parcelOutline: rgba(120, 210, 170, 0.85),
  parcelActive: rgba(150, 235, 190, 0.4),

  /** Architectural model on the active building. */
  buildingModelWall: rgba(238, 232, 220, 1),
  buildingModelRoof: (use: UseType) => ROOF_COLOR[use],
  /**
   * Flat cap over the city-scale extrusions. The extruded polygon carries the
   * facade texture on ALL faces including its top, which printed a grid of
   * window boxes on every roof; this cap is drawn just above it in a muted
   * roof tone so the top reads as a roof.
   */
  buildingRoofCap: (use: UseType, alpha = 1) => ROOF_COLOR[use].withAlpha(alpha),
  /**
   * Roof edge line. A quiet darkening of the roof tone rather than the dark
   * fixture colour -- full-contrast outlines around every roof face were
   * half of the "printed" look on the old model.
   */
  buildingModelRoofLine: rgba(28, 32, 38, 0.45),
  buildingModelFixture: rgba(80, 84, 92, 1),
  /** Ground apron at the model's foot. */
  buildingModelPlinth: rgba(96, 98, 102, 1),
  /**
   * Flat concrete cap closing the top of each per-storey prism in the
   * exploded model. Without it the extruded wall texture prints its window
   * grid on every storey's top face; this light slab tone also reads as the
   * floor-plate edge, which is the detailing the explode view wants.
   */
  buildingModelSlabCap: rgba(196, 190, 180, 1),
} as const;

/**
 * Muted concrete roof palette. All roofs in this AOI are flat slabs, so every
 * tone is a neutral deck/membrane grey -- keeping roofs near-neutral is what
 * lets the textured walls stay the visual subject.
 */
const ROOF_COLOR: Record<UseType, Cesium.Color> = {
  residential: rgba(176, 172, 164, 1),   // concrete deck
  commercial: rgba(112, 116, 122, 1),    // gravel + membrane
  institutional: rgba(150, 156, 150, 1), // weathered screed
  industrial: rgba(100, 104, 110, 1),    // coated metal sheet
};

// ---------------------------------------------------------------- utilities
export const UTILITY_COLOR: Record<AssetType, Cesium.Color> = {
  water: rgba(64, 158, 232, 1),
  sewer: rgba(150, 112, 74, 1),
  power: rgba(238, 186, 60, 1),
  metro: rgba(176, 108, 220, 1),
};

export const UTILITY_LABEL: Record<AssetType, string> = {
  water: 'Water main',
  sewer: 'Sewer',
  power: 'Power duct',
  metro: 'Metro tunnel',
};

/** A utility corridor the user has picked. */
export const UTILITY_SELECTED = Cesium.Color.WHITE.withAlpha(0.95);

/** Conflicting segments pulse between these two. */
export const CONFLICT_COLOR = rgba(255, 64, 64, 0.95);
export const CONFLICT_COLOR_DIM = rgba(150, 24, 24, 0.55);

// --------------------------------------------------------------- provenance
/** Estimated data is visually distinct from surveyed data throughout the UI. */
export const PROVENANCE_HEX: Record<Provenance, string> = {
  surveyed_plan: '#4ade80',
  osm_tag: '#38bdf8',
  dsm_dem: '#a78bfa',
  estimated: '#fbbf24',
};

/** Canvas clear colour behind the globe. */
export const SCENE_BACKGROUND = Cesium.Color.fromCssColorString('#05080f');

/** A circular cross-section for PolylineVolume tubes. */
export function tubeShape(radius: number, sides = 12): Cesium.Cartesian2[] {
  const pts: Cesium.Cartesian2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Cesium.Math.TWO_PI;
    pts.push(new Cesium.Cartesian2(radius * Math.cos(t), radius * Math.sin(t)));
  }
  return pts;
}
