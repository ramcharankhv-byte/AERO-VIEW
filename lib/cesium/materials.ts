import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { AssetType, Provenance, RoadClass, UseType } from '@/lib/types';

/**
 * Every colour state in the scene, defined once.
 *
 * ARCHITECTURE RULE: no component constructs its own Cesium.Color for entity
 * styling. If a new visual state is needed it is added here, so that "what does
 * this tone mean" has exactly one answer in the codebase.
 *
 * COLOUR RULE: three families, and which one a tone belongs to is the whole
 * decision.
 *
 *   BUILT FORM is neutral off-white -- OFF_WHITE (#F5F5F5) and a tight band
 *   just below it. It is the one thing on screen that is not a photograph, and
 *   keeping it colourless is what makes it read as an abstraction laid over
 *   the ground rather than as another object in the scene. City-scale masses
 *   are drawn at BUILDING_ALPHA so the imagery under them stays readable.
 *
 *   THE GROUND is the provider's own colour, dimmed and slightly saturated
 *   into deep green by the imagery treatment (lib/cesium/imagery.ts). Neutral
 *   buildings against dark green terrain is the contrast the whole scheme is
 *   built on: value AND chroma separate them, so massing survives even where a
 *   pale roof sits under a pale wall.
 *
 *   MEANING keeps its hue: utility corridors by asset type, provenance by
 *   source, CONFLICT_COLOR red for a detected encroachment. These are legend
 *   entries, not surfaces, and hue is what makes four of them legible at once.
 *
 * The CHROME -- top bar, dock, panels, dashboard -- is black and white, and
 * lives in app/globals.css. It is deliberately the only monochrome surface.
 *
 * Values are chosen against a dark scene background, so the usable band is
 * roughly 70-255. Anything darker reads as a hole rather than as a surface.
 */

const rgba = (r: number, g: number, b: number, a: number) =>
  Cesium.Color.fromBytes(r, g, b, Math.round(a * 255));

/** Neutral grey. Every built-form tone, every road stroke, every selection. */
const grey = (v: number, a = 1) => rgba(v, v, v, a);

/**
 * The off-white the buildings are made of: #F5F5F5, as a 0-255 value.
 *
 * Named rather than inlined because it is the anchor of the whole built-form
 * band below -- roofs, caps, plinths and slabs are all defined as a step down
 * from it, so moving the scheme is moving this number.
 */
const OFF_WHITE = 245;

/**
 * Opacity of a city-scale building mass.
 *
 * Not a slider default and not a fade state: it is the resting look. At 0.45
 * the satellite texture under a block -- its own roof, the plot it stands in,
 * the lane beside it -- stays readable through the extrusion, so the massing
 * is drawn OVER the evidence instead of hiding it. Hover and the exploded
 * model deliberately sit above it; the transparency slider, which fades the
 * buildings you are not inspecting, is clamped to it (see BuildingsLayer) so
 * "less visible than at rest" stays true at every slider position.
 */
export const BUILDING_ALPHA = 0.45;

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
/**
 * Base fill by use type -- four off-whites in a deliberately tight band.
 *
 * OFF_WHITE is the anchor and residential takes it exactly; the other three sit
 * within a few values of it. The band is that narrow because these are one
 * material family, not four categories competing for attention: the use type is
 * a fact the DetailPanel states in words, and at 45% opacity over live imagery
 * a wide ramp would read as dirt on the glass rather than as a category. Hover
 * goes to pure white and to a higher alpha, which is what makes it legible
 * against a band this tight.
 */
const USE_VALUE: Record<UseType, number> = {
  residential: OFF_WHITE,
  commercial: 238,
  institutional: 250,
  industrial: 232,
};

const USE_COLOR: Record<UseType, Cesium.Color> = {
  residential: grey(USE_VALUE.residential),
  commercial: grey(USE_VALUE.commercial),
  institutional: grey(USE_VALUE.institutional),
  industrial: grey(USE_VALUE.industrial),
};

/**
 * Roof palette. All roofs in this AOI are flat slabs. Each tone sits a clear
 * step BELOW its wall tone -- far enough that the top face reads as a separate
 * plane, close enough that it is plainly the same building. With a raking
 * late-afternoon sun this step and the cast shadow do the same job from
 * opposite directions, which is why neither has to be heavy-handed.
 */
const ROOF_COLOR: Record<UseType, Cesium.Color> = {
  residential: grey(216),
  commercial: grey(209),
  institutional: grey(221),
  industrial: grey(203),
};

export const MATERIALS = {
  /**
   * Schematic mode: the flat wall colour of a city-scale extrusion.
   *
   * Flat, not the window-grid texture. A repeating facade at BUILDING_ALPHA
   * over live imagery reads as moire, not as windows -- the fenestration
   * belongs to the architectural model of the ONE building being inspected,
   * where it is opaque and close enough to resolve (BuildingModelLayer).
   */
  buildingFacade: (use: UseType, alpha = BUILDING_ALPHA) =>
    USE_COLOR[use].withAlpha(alpha),

  /**
   * Photoreal mode: the schematic extrusion is still there, still tagged, and
   * still hit by scene.pick -- it is just not visible. Alpha 0.01 rather than
   * show:false precisely because a hidden entity is not pickable, and picking
   * is what keeps the ULPIN panel, the floor ladder and the basement conflict
   * checks working while Google's mesh is on screen.
   */
  buildingGhost: Cesium.Color.WHITE.withAlpha(0.01),

  /** Cursor is over it. Well above the base band, so it cannot be mistaken
   *  for an unusually pale neighbour. */
  buildingHover: grey(255),

  /** An above-ground floor slab in the exploded stack. */
  floorSlab: grey(210, 0.34),

  /**
   * The isolated level's base plate. Solid enough to read as a floor the flats
   * stand on, and it is the surface a click resolves to as "the floor" when no
   * unit is under the cursor -- corridors, lobbies, the level's own space.
   */
  floorPlate: grey(198, 0.82),

  /**
   * The isolated level's height envelope, drawn as a full-Z-extent shell so the
   * level still reads as a volume rather than a sheet of paper.
   *
   * The alpha is the whole point: at anything approaching opacity this is the
   * exact geometry that used to swallow its own unit volumes. At 0.08 the flats
   * inside are plainly visible, and Picker's drill-to-unit rule keeps the shell
   * from swallowing the pick ray as well.
   */
  floorShell: grey(230, FLOOR_VIEW.SHELL_ALPHA),
  floorShellOutline: grey(235, 0.55),

  /** Edge of the isolated floor: pure white, so the highlight has a crisp rim. */
  floorActiveOutline: grey(255),

  /** Basements are the darkest tone -- they read as mass, not as habitable
   *  volume. */
  basementSlab: grey(96, 0.95),

  /** Edge of a floor slab in the stack. */
  floorOutline: grey(180, 0.5),

  /**
   * A unit volume on the isolated floor.
   *
   * `alpha` is supplied by the caller because the units layer eases it: they
   * fade in as the exploded stack opens, and they dim (never vanish) while a
   * sibling is selected.
   */
  unitDefault: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) => grey(198).withAlpha(alpha),

  /** Cursor is over it. The same brightening the buildings use for hover, so
   *  the gesture means one thing at every level of the hierarchy. */
  unitHover: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) =>
    grey(232).withAlpha(Math.max(alpha, 0.7)),

  /** Edge of an unselected unit. */
  unitOutlineIdle: grey(150, 0.45),

  /**
   * The selected unit: pure white with a full-strength white silhouette.
   *
   * Hover and selection are close in value, so the OUTLINE is what actually
   * distinguishes them -- an unselected flat never gets one at this strength,
   * and a full-strength white silhouette survives being seen through the
   * translucent shell around it.
   */
  unitSelected: (alpha = 0.88) => grey(255).withAlpha(alpha),
  unitOutline: grey(255),

  /** Unit code label on the isolated floor. */
  unitLabelFill: grey(245),
  unitLabelOutline: grey(0),

  /** Surface parcel polygons, clamped to ground. */
  parcelFill: grey(190, 0.1),
  parcelOutline: grey(215, 0.85),
  parcelActive: grey(240, 0.28),

  /** Architectural model on the active building. */
  buildingModelWall: grey(OFF_WHITE),
  buildingModelRoof: (use: UseType) => ROOF_COLOR[use],
  /**
   * Flat cap over the city-scale extrusions. The extruded polygon carries the
   * facade texture on ALL faces including its top, which printed a grid of
   * window boxes on every roof; this cap is drawn just above it in a muted
   * roof tone so the top reads as a roof.
   */
  buildingRoofCap: (use: UseType, alpha = BUILDING_ALPHA) =>
    ROOF_COLOR[use].withAlpha(alpha),
  /**
   * Roof edge line. A quiet darkening of the roof tone rather than the dark
   * fixture colour -- full-contrast outlines around every roof face were
   * half of the "printed" look on the old model.
   */
  buildingModelRoofLine: grey(24, 0.45),
  buildingModelFixture: grey(120),
  /** Ground apron at the model's foot. */
  buildingModelPlinth: grey(132),
  /**
   * Flat concrete cap closing the top of each per-storey prism in the
   * exploded model. Without it the extruded wall texture prints its window
   * grid on every storey's top face; this light slab tone also reads as the
   * floor-plate edge, which is the detailing the explode view wants.
   */
  buildingModelSlabCap: grey(232),
} as const;

// -------------------------------------------------------------------- roads
/**
 * Street and road centrelines, drawn clamped to the ground.
 *
 * Roads are the one layer that must stay legible over BOTH a dark satellite
 * basemap and Google's captured mesh, so each is drawn as a bright line over a
 * dark casing -- the standard cartographic trick, and the only way a neutral
 * grey line survives both a black rooftop and a white one underneath it.
 *
 * Width is in screen pixels and encodes the road hierarchy, which is what the
 * hue used to do on a conventional map. The order below is the hierarchy.
 */
export const ROAD_STYLE: Record<RoadClass, { width: number; value: number; alpha: number }> = {
  motorway: { width: 7, value: 240, alpha: 0.95 },
  trunk: { width: 7, value: 238, alpha: 0.95 },
  primary: { width: 6, value: 236, alpha: 0.94 },
  secondary: { width: 5, value: 220, alpha: 0.92 },
  tertiary: { width: 4, value: 200, alpha: 0.9 },
  residential: { width: 3, value: 172, alpha: 0.86 },
  living_street: { width: 3, value: 172, alpha: 0.86 },
  unclassified: { width: 3, value: 156, alpha: 0.84 },
  service: { width: 2, value: 132, alpha: 0.78 },
};

export const ROAD_COLOR: Record<RoadClass, Cesium.Color> = (() => {
  const out = {} as Record<RoadClass, Cesium.Color>;
  for (const cls of Object.keys(ROAD_STYLE) as RoadClass[]) {
    const s = ROAD_STYLE[cls];
    out[cls] = grey(s.value, s.alpha);
  }
  return out;
})();

/** What each class is called in the panel and the key. */
export const ROAD_CLASS_LABEL: Record<RoadClass, string> = {
  motorway: 'Motorway',
  trunk: 'Trunk road',
  primary: 'Arterial road',
  secondary: 'Sub-arterial road',
  tertiary: 'Collector road',
  residential: 'Residential street',
  unclassified: 'Minor street',
  living_street: 'Living street',
  service: 'Service lane',
};

/**
 * Dark casing drawn under every road line.
 *
 * One grey value cannot hold contrast against both the dimmed satellite
 * basemap and Google's bright photoreal mesh. A dark casing under a light
 * stroke is the standard cartographic answer and it works over any surface
 * without reaching for a hue.
 */
export const ROAD_CASING = grey(8, 0.72);
/** Cursor is over it. */
export const ROAD_HOVER = grey(255, 0.96);
/** The picked street. */
export const ROAD_SELECTED = grey(255, 0.98);
/** How much wider the casing is than the line it sits under, in pixels. */
export const ROAD_CASING_EXTRA_PX = 2;
/** Extra width of the halo drawn over the one selected street, in pixels. */
export const ROAD_SELECTED_EXTRA_PX = 3;
/**
 * Click tolerance for streets, in screen pixels.
 *
 * A 2-3 px stroke is an unusable target, and the brief requires selection to
 * work whether the user hits the drawn line or merely its vicinity. This is
 * applied as the width of a WIDENED second pick pass in Picker.tsx, not as an
 * invisible corridor entity: the widened pass costs no entities and no GPU
 * time, and it runs only after the tight pick has already failed to find any
 * solid, so it can never enlarge the target of a building, floor or unit.
 */
export const ROAD_PICK_PX = 13;

// ---------------------------------------------------------------- utilities
/**
 * Utility corridors, one hue per asset type.
 *
 * These are tubes several metres underground seen through a translucent globe,
 * often crossing each other in a single view, and they are the one layer where
 * four categories are on screen at once with no room to label each. Hue is the
 * encoding that survives that; the Legend still states the type and the depth
 * in words beside every swatch. Kept clear of the built-form green so a duct
 * never reads as part of a basement, and clear of CONFLICT_COLOR's red.
 */
export const UTILITY_COLOR: Record<AssetType, Cesium.Color> = {
  power: Cesium.Color.fromCssColorString('#FACC15'),   // amber
  water: Cesium.Color.fromCssColorString('#38BDF8'),   // blue
  sewer: Cesium.Color.fromCssColorString('#B45309'),   // brown
  metro: Cesium.Color.fromCssColorString('#C084FC'),   // violet
};

export const UTILITY_LABEL: Record<AssetType, string> = {
  water: 'Water main',
  sewer: 'Sewer',
  power: 'Power duct',
  metro: 'Metro tunnel',
};

/** A utility corridor the user has picked. */
export const UTILITY_SELECTED = Cesium.Color.WHITE.withAlpha(0.95);

/**
 * Conflicting segments pulse between these two.
 *
 * THE ONLY HUE IN THE APPLICATION. A 3D intersection between a sewer and an
 * occupied basement is the one thing in this scene that a viewer must not scan
 * past, and it is the finding the whole ST_3DIntersects pipeline exists to
 * produce. Encoding it as another grey would bury it in the grey it is
 * supposed to stand out from. Matches --danger in app/globals.css.
 */
export const CONFLICT_COLOR = rgba(239, 68, 68, 0.95);
export const CONFLICT_COLOR_DIM = rgba(120, 26, 26, 0.55);

// --------------------------------------------------------------- provenance
/**
 * Estimated data stays visually distinct from surveyed data throughout the UI,
 * by hue AND by fill pattern.
 *
 * Ordered by strength of evidence: green is a surveyed plan, violet is a guess.
 * The pattern paired with each colour lives in app/globals.css (.swatch-solid /
 * -dense / -mid / -open) and is what keeps the four distinguishable in
 * greyscale and for a colour-blind reader -- the hue is the fast read, the
 * pattern is the reliable one.
 */
export const PROVENANCE_HEX: Record<Provenance, string> = {
  surveyed_plan: '#4ADE80',  // measured
  osm_tag: '#38BDF8',        // mapped
  dsm_dem: '#FACC15',        // derived
  estimated: '#C084FC',      // nothing measured it
};

/** The fill pattern paired with each provenance value. See globals.css. */
export const PROVENANCE_SWATCH: Record<Provenance, string> = {
  surveyed_plan: 'swatch-solid',   // measured
  osm_tag: 'swatch-dense',         // mapped
  dsm_dem: 'swatch-mid',           // derived
  estimated: 'swatch-open',        // nothing measured it
};

/** Canvas clear colour behind the globe. */
export const SCENE_BACKGROUND = Cesium.Color.BLACK;

/** A circular cross-section for PolylineVolume tubes. */
export function tubeShape(radius: number, sides = 12): Cesium.Cartesian2[] {
  const pts: Cesium.Cartesian2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Cesium.Math.TWO_PI;
    pts.push(new Cesium.Cartesian2(radius * Math.cos(t), radius * Math.sin(t)));
  }
  return pts;
}
