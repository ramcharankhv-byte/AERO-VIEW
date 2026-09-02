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

// -------------------------------------------------------------- floor view
/**
 * Every dimension and threshold the floor/unit view is tuned by, in one block.
 *
 * ARCHITECTURE RULE, same spirit as the colours below: no layer invents its own
 * plate thickness, inset or fade threshold. FloorStackLayer and UnitsLayer have
 * to agree about where the plate top is or the flats float; putting the numbers
 * anywhere but here is what lets them drift apart.
 */
export const FLOOR_VIEW = {
  /** Thickness of the isolated level's base plate, metres. */
  PLATE_THICKNESS_M: 0.3,
  /** Seam between stacked slabs in the exploded stack, metres. */
  SLAB_GAP_M: 0.35,
  /** Alpha of the full-height shell drawn around the isolated level. */
  SHELL_ALPHA: 0.08,

  /**
   * How far each unit is pulled in from its stored footprint, metres.
   *
   * Units are a grid subdivision, so neighbours literally share wall lines.
   * Drawn as stored they z-fight along every shared face; inset, each flat is
   * its own box with a 2 x this gap to the next one -- which is also what makes
   * a section cut read as separate flats rather than one merged slab.
   */
  UNIT_INSET_M: 0.12,
  /** How far a unit's base sits above the plate's top face, metres. */
  UNIT_LIFT_M: 0.1,
  /** Floor for a unit box's rendered height once the plate and lift are taken. */
  UNIT_MIN_HEIGHT_M: 0.6,

  /** Opacity of a unit volume at rest. */
  UNIT_ALPHA: 0.82,
  /** Opacity of the units NOT selected. Dimmed, never hidden. */
  UNIT_DIM_ALPHA: 0.45,

  /** Unit code labels are decluttered beyond this camera distance, metres. */
  LABEL_MAX_DISTANCE_M: 250,

  /**
   * Explode fractions (0-1 of the slider) between which units fade in on the
   * exploded stack. Below the first the storeys have not separated enough for a
   * flat to be visible on top of one; above the second they are fully up.
   */
  EXPLODE_UNITS_IN: 0.6,
  EXPLODE_UNITS_FULL: 0.8,
} as const;

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

  /**
   * The isolated level's base plate. Solid enough to read as a floor the flats
   * stand on, and it is the surface a click resolves to as "the floor" when no
   * unit is under the cursor -- corridors, lobbies, the level's own space.
   */
  floorPlate: rgba(120, 168, 214, 0.82),

  /**
   * The isolated level's height envelope, drawn as a full-Z-extent shell so the
   * level still reads as a volume rather than a sheet of paper.
   *
   * The alpha is the whole point: at anything approaching opacity this is the
   * exact geometry that used to swallow its own unit volumes. At 0.08 the flats
   * inside are plainly visible, and Picker's drill-to-unit rule keeps the shell
   * from swallowing the pick ray as well.
   */
  floorShell: rgba(150, 198, 240, FLOOR_VIEW.SHELL_ALPHA),
  floorShellOutline: rgba(176, 220, 255, 0.55),

  /** Edge of the isolated floor: near-white so the highlight has a crisp rim. */
  floorActiveOutline: rgba(200, 242, 255, 1),

  /** Basements are solid grey -- they read as mass, not as habitable volume. */
  basementSlab: rgba(120, 124, 132, 0.95),

  /** Edge of a floor slab in the stack. */
  floorOutline: rgba(143, 180, 216, 0.5),

  /**
   * A unit volume on the isolated floor.
   *
   * `alpha` is supplied by the caller because the units layer eases it: they
   * fade in as the exploded stack opens, and they dim (never vanish) while a
   * sibling is selected.
   */
  unitDefault: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) =>
    rgba(196, 214, 236, 1).withAlpha(alpha),

  /** Cursor is over it. Same blue the buildings use for hover, so the gesture
   *  means one thing at every level of the hierarchy. */
  unitHover: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) =>
    rgba(120, 205, 255, 1).withAlpha(Math.max(alpha, 0.7)),

  /** Edge of an unselected unit. */
  unitOutlineIdle: rgba(159, 182, 207, 0.45),

  /** The selected unit: gold, with a silhouette outline. */
  unitSelected: (alpha = 0.88) => rgba(240, 190, 72, 1).withAlpha(alpha),
  unitOutline: rgba(255, 226, 140, 1),

  /** Unit code label on the isolated floor. */
  unitLabelFill: rgba(238, 246, 255, 1),
  unitLabelOutline: rgba(8, 14, 24, 1),

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
