import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import type { Provenance, RiskClass, RoadClass, UseType } from '@/lib/types';
import {
  UNDERGROUND_LAYERS, categoryOfAssetType, type UtilityCategory,
} from '@/lib/underground/categories';

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

/**
 * Opacity of a city-scale building mass, as actually rendered.
 *
 * Distinct from BUILDING_ALPHA above, which is still the correct resting alpha
 * for the OTHER translucent surfaces -- the parcel overlay, the section shell,
 * the floor slab in the architectural model -- and is left at 0.45 for them.
 * Only the city-scale masses are solid, and this is their number.
 *
 * 0.95, not 1.0. A fully opaque edge reads as a die-cut sticker against a
 * satellite photograph; a little softness keeps the boundary of a building
 * from looking painted on at a raking angle.
 *
 * Previously a local constant inside BuildingsLayer.tsx, which was a real
 * breach of the rule at the top of this file -- a component was deciding the
 * resting look of the primary object in the scene, and the two alphas could
 * not be compared without opening two files.
 */
export const CITY_BUILDING_ALPHA = 0.95;

/**
 * How far a building fades in underground mode.
 *
 * Low enough that the buildings stop competing with the utilities -- which are
 * the whole point of the mode -- and not zero, because the corridors have to be
 * read in relation to the plots they run under. This is the floor the
 * transparency slider is driven to when underground is on; it is not a slider
 * position the user can reach.
 */
export const UNDERGROUND_BUILDING_ALPHA = 0.1;

/**
 * Horizon-based ambient occlusion, applied by lib/cesium/lighting.ts.
 *
 * Not a colour, but it belongs to the same family of decisions and to the same
 * "stated once" rule: these two numbers are how dark the contact between a wall
 * and the ground gets, which is a look, not a setting.
 *
 * INTENSITY 2.5 against Cesium's default of 3.0: the default crushes a narrow
 * lane between two blocks to near-black under a low sun, which is the exact
 * hour this scene boots at. LENGTH_CAP_M 0.5 against a default of 0.26 --
 * sampling stops half a metre out, roughly the width of the wall-to-ground
 * contact this is meant to draw, and stopping sooner leaves it invisible at
 * city altitude.
 */
export const AMBIENT_OCCLUSION = {
  INTENSITY: 2.5,
  LENGTH_CAP_M: 0.5,
} as const;

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

  /**
   * Alpha of the levels that are NOT isolated, drawn as context around the one
   * that is.
   *
   * Isolating a level used to HIDE every other level, so the chosen floor
   * floated in space with nothing to say which floor it was. BELOW puts the
   * stack underneath it back: the levels beneath occlude nothing (the camera
   * is above them) and they are what makes the isolated plate read as sitting
   * at a HEIGHT rather than on the ground.
   *
   * ABOVE is currently unreachable, and the number is kept here with its
   * reasoning rather than deleted, because the decision is worth being able to
   * find. The levels over the user's head sit between the camera and the floor
   * they opened the view to inspect, and -- decisively -- each one adds a
   * translucent surface to Picker's SIX-deep drill (DRILL_LIMIT), which is
   * already spending slots on the height shell and the base plate. On a
   * 28-storey tower, isolating level 2 would put 26 surfaces in front of every
   * flat and nothing on the floor could be clicked. See FloorStackLayer's
   * context-plate block.
   */
  CONTEXT_ABOVE_ALPHA: 0.12,
  CONTEXT_BELOW_ALPHA: 0.6,

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
 * The wall tone of each use type's FAÇADE TEXTURE.
 *
 * Distinct from USE_VALUE above, which is the flat fill the far tier still
 * uses. These are the colours actually on screen at city scale: warm plaster,
 * curtain-wall glass, sandstone, coated metal.
 *
 * They were hex literals inside the drawers in lib/cesium/textures.ts, which
 * meant the one thing in the app that decides what a building LOOKS like was
 * the one thing not stated here. That mattered the moment a legend had to name
 * them: a key drawn from a second copy of the numbers is a key that can drift
 * from the façade it claims to describe. textures.ts imports these now, so
 * there is one set of four and the legend cannot lie.
 *
 * Note these are not in the neutral off-white band the rest of the built form
 * lives in. That is the point and it predates this file knowing about them:
 * the texture's warm plaster against its dark window pane is what reads as
 * "this is wall, that is glass" at a glance, and draining it to greys is
 * exactly the mistake DL-K.1 rolled back.
 */
export const USE_WALL_HEX: Record<UseType, string> = {
  residential: '#d3c9b6',
  commercial: '#33445a',
  institutional: '#d7cbae',
  industrial: '#a3aab3',
};

/**
 * The commercial curtain wall is a gradient, not a flat tone: three stops
 * across the bay, which is what stops a glass façade reading as flat paint.
 * USE_WALL_HEX.commercial is the middle stop, and it is the one the legend
 * swatch shows.
 */
export const COMMERCIAL_GLASS_HEX = ['#41556a', USE_WALL_HEX.commercial, '#2a3849'] as const;

/**
 * How the use types are NAMED, for the legend key.
 *
 * `institutional` is the fourth value, not "public" -- the data has schools,
 * hospitals and government offices under one code, and calling that "public"
 * would quietly widen it to include things it does not contain.
 */
export const USE_TYPE_LABEL: Record<UseType, string> = {
  residential: 'Residential',
  commercial: 'Commercial',
  institutional: 'Institutional',
  industrial: 'Industrial',
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

  /**
   * Tint multiplied over a city-scale wall's window-grid texture.
   *
   * WHITE, not the use-type colour: the texture already carries the hue, and a
   * coloured tint multiplies it away -- a warm tint over warm plaster pushes it
   * to grey and the windows vanish. That is DL-K.2's finding and it stands.
   *
   * What DOES vary per building is VALUE. `jitter` is a deterministic ±8%
   * seeded from the building id (see BuildingsLayer), so two identical blocks
   * side by side are not the same block twice. Eight percent is small on
   * purpose: it has to read as "these were rendered at different times" and
   * never as "these are different categories", which is a distinction the
   * legend key beside it is making with hue.
   *
   * Clamped at 1.0 -- above it the tint stops multiplying and starts clipping
   * the texture's highlights to flat white.
   */
  cityFacadeTint: (jitter = 1, alpha = CITY_BUILDING_ALPHA) =>
    grey(Math.round(255 * Math.min(1, jitter)), alpha),

  /**
   * The edge of the building the user has selected.
   *
   * Drawn as a polyline round the roof and down the corners, NOT as
   * `outline: true` on the extrusion. Two reasons, and the second is the one
   * that matters: an outlined polygon leaves Cesium's batched static path, and
   * turning it on for 2,213 extrusions to highlight ONE of them is the whole
   * layer paying for a single building. The polyline set is drawn once and
   * repositioned, so the cost is constant.
   *
   * White, which is what --accent is throughout the chrome. Amber is not
   * available here: it already means "the signed-in citizen's own flat"
   * (unitOwn below), and a second meaning would make the first ambiguous.
   */
  buildingSelectedEdge: grey(255, 0.95),

  /**
   * A dark casing drawn one step wider beneath the selection ring.
   *
   * The same device ROAD_CASING uses, for the same reason and it is needed
   * more here: the roof cap the ring traces is grey(203-221) and under a low
   * sun it renders close to white, so a white ring on it is invisible exactly
   * where the user is looking. The casing gives the ring an edge to be seen
   * against on a pale roof, and costs nothing on a dark one.
   *
   * Keeping the accent white and adding a casing -- rather than making the
   * accent itself a colour -- is what keeps the scene's one accent the same
   * white as --accent in the chrome, and leaves amber meaning "the citizen's
   * own flat" and red meaning "conflict", which are the only two hues in this
   * palette that carry a fact.
   */
  buildingSelectedEdgeCasing: grey(8, 0.7),

  /**
   * The edge of the building under the cursor.
   *
   * Deliberately much quieter than the selection. Hover is a question and
   * selection is an answer; if they read at the same strength then sweeping
   * the mouse across a block looks like repeatedly selecting things.
   */
  buildingHoverEdge: grey(255, 0.4),

  /**
   * The floor-view surfaces are GLASS, not white ledges.
   *
   * A deliberate, narrow exception to the neutral-off-white rule at the top of
   * this file, and the only one in the built form. Every surface in the floor
   * view is translucent and they are stacked, so a viewer is nearly always
   * looking through two or three of them at once; in neutral grey those
   * overlaps compound into a white haze and the stack loses its depth. A few
   * points of cool cast give each layer of the stack a hue to be told apart by
   * as well as a value, which is the same value-AND-chroma argument the ground
   * treatment rests on, applied one level down.
   *
   * The cast is small on purpose -- a dozen values off neutral. It has to read
   * as "this is glass" and never as "this is a category", because a category
   * is what the unit tints below are for.
   */
  floorSlab: rgba(198, 212, 224, 0.34),

  /** The levels around the isolated one. See FLOOR_VIEW.CONTEXT_*_ALPHA. */
  floorContext: (above: boolean) =>
    rgba(198, 212, 224, above
      ? FLOOR_VIEW.CONTEXT_ABOVE_ALPHA
      : FLOOR_VIEW.CONTEXT_BELOW_ALPHA),

  /**
   * The isolated level's base plate. Solid enough to read as a floor the flats
   * stand on, and it is the surface a click resolves to as "the floor" when no
   * unit is under the cursor -- corridors, lobbies, the level's own space.
   */
  /**
   * The isolated level's base plate: the floor the flats stand on.
   *
   * The one surface in the floor view kept close to neutral and well up the
   * value scale. It is the plane the whole view is ABOUT, it is what a click
   * resolves to as "the floor", and every unit tint has to read against it --
   * so it is the reference the glass around it is cool relative to.
   */
  floorPlate: grey(206, 0.86),

  /**
   * The isolated level's height envelope, drawn as a full-Z-extent shell so the
   * level still reads as a volume rather than a sheet of paper.
   *
   * The alpha is the whole point: at anything approaching opacity this is the
   * exact geometry that used to swallow its own unit volumes. At 0.08 the flats
   * inside are plainly visible, and Picker's drill-to-unit rule keeps the shell
   * from swallowing the pick ray as well.
   */
  floorShell: rgba(214, 228, 240, FLOOR_VIEW.SHELL_ALPHA),
  floorShellOutline: rgba(220, 232, 242, 0.55),

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

  /**
   * A flat's own tint, by its slot on the floor plate.
   *
   * Four flats on one plate used to be four volumes of the identical grey, so
   * a floor read as a single quartered slab and "which one is mine" had no
   * visual answer. The geometry now separates them; this separates them at a
   * glance, before the labels are legible.
   *
   * SIX, not four. The bank cycles by slot, so a plate with more flats than
   * tints gives two of them the same colour -- and with four, the pair that
   * collided were slots 0 and 4, which on a typical plate are not adjacent but
   * are frequently in the same line of sight. Six pushes the first repeat past
   * the flat count of nearly every plate in both projects. It is not a fix: a
   * cycle always repeats eventually. It moves the repeat to where it stops
   * mattering.
   *
   * Deliberately desaturated to roughly a tenth. The palette elsewhere spends
   * saturation on MEANING -- use type on a facade, asset type on a utility,
   * red on a conflict -- and a flat's slot means nothing beyond "not the one
   * next to it". These have to be six things you can tell apart while still
   * reading as the same kind of thing, so they differ mostly in hue at a
   * near-constant value, and none of them competes with the white a selected
   * flat turns.
   */
  unitTint: (slot: number, alpha: number = FLOOR_VIEW.UNIT_ALPHA) => {
    const tints = [
      Cesium.Color.fromBytes(205, 198, 186),  // warm sand
      Cesium.Color.fromBytes(186, 200, 205),  // cool slate
      Cesium.Color.fromBytes(196, 205, 188),  // pale sage
      Cesium.Color.fromBytes(203, 190, 202),  // dusty mauve
      Cesium.Color.fromBytes(188, 196, 210),  // pale blue
      Cesium.Color.fromBytes(208, 194, 184),  // warm clay
    ];
    return tints[((slot % tints.length) + tints.length) % tints.length].withAlpha(alpha);
  },

  /**
   * The signed-in citizen's own flat: warm, saturated, unmistakable.
   *
   * The one place in the unit palette that spends real saturation, because
   * here the colour carries the only thing the citizen came to see. It has to
   * win against the tints above and against the shell around it.
   */
  unitOwn: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) =>
    Cesium.Color.fromBytes(255, 196, 92).withAlpha(Math.max(alpha, 0.9)),
  unitOwnOutline: Cesium.Color.fromBytes(255, 214, 138),

  /**
   * A flat the viewer may see but not open.
   *
   * Quieter and flatter than any of the tints -- it has to read as the shape
   * of a home without inviting the click that would do nothing. Kept solid
   * enough to occlude properly, so the floor still reads as full rather than
   * as one flat floating in a gap.
   */
  unitRestricted: (alpha: number = FLOOR_VIEW.UNIT_ALPHA) =>
    grey(170).withAlpha(Math.min(alpha, 0.55)),

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

  /**
   * Balcony slab top face. One step lighter than the wall so the
   * projection reads as separate material, not as a thicker wall. Same
   * off-white as the slab cap so the two agree.
   */
  balconySlab: grey(232),
  /**
   * Balcony railing. A mid-grey, not a black silhouette -- a black
   * railing in front of a pale wall at 1 m tall would read as a slot
   * in the building, not as a barrier. Same tone as the floor bands so
   * the eye sees them as the same kind of detail.
   */
  balconyRailing: grey(160),
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
 * Underground corridors, one hue per category.
 *
 * These are tubes several metres down seen through a translucent globe, often
 * crossing each other in a single view, and it is the one layer where several
 * networks can be on screen at once with no room to label each. Hue is the
 * encoding that survives that; the panel and the legend state the category and
 * its depth in words beside every swatch. Kept clear of the built-form
 * off-white so a duct never reads as part of a basement, and clear of
 * CONFLICT_COLOR's red.
 *
 * The hues themselves live in lib/underground/categories.ts, with the depths
 * and corridors they belong to. This module is still the only place that
 * constructs a Cesium.Color -- it is where the hex becomes a colour, not where
 * the hex is decided. Splitting it that way is what lets the layer panel,
 * which is prerendered and must not touch Cesium, read the same swatch values.
 */
export const UTILITY_COLOR: Record<UtilityCategory, Cesium.Color> =
  Object.fromEntries(
    UNDERGROUND_LAYERS.map((l) => [l.key, Cesium.Color.fromCssColorString(l.colour)]),
  ) as Record<UtilityCategory, Cesium.Color>;

/** The network's name, for the layer panel and the legend. */
export const UTILITY_LABEL: Record<UtilityCategory, string> =
  Object.fromEntries(
    UNDERGROUND_LAYERS.map((l) => [l.key, l.label]),
  ) as Record<UtilityCategory, string>;

/** One asset's name, for the detail card and the conflict banner. */
export const UTILITY_ASSET_LABEL: Record<UtilityCategory, string> =
  Object.fromEntries(
    UNDERGROUND_LAYERS.map((l) => [l.key, l.assetLabel]),
  ) as Record<UtilityCategory, string>;

/**
 * Name one asset, given whatever `asset_type` the data carries.
 *
 * Falls back to the raw stored value for a type this build has no category
 * for. Naming an unknown duct after the nearest category would be inventing a
 * fact about it; showing the string the record actually holds is not.
 */
export function utilityAssetLabel(assetType: string): string {
  const cat = categoryOfAssetType(assetType);
  return cat ? UTILITY_ASSET_LABEL[cat] : assetType;
}

// ---------------------------------------------------------- infrastructure
/**
 * Named infrastructure: the station, the flyover, and their parts.
 *
 * NEUTRAL GREYS, on purpose, and the same family the buildings are drawn from.
 * These structures are the built form of this scene -- they are not a category
 * competing for attention, and hue here would fight the one place hue is
 * carrying meaning, which is the buried networks below them. What separates a
 * platform from a deck from a pier is VALUE: paving is light, structure is
 * mid, running surfaces are dark. That reads at every zoom and survives a
 * colour-blind viewer, which a palette of six tints would not.
 *
 * Selection is the exception, and gets the same white the rest of the scene
 * uses for "this is the thing you picked".
 */
export const INFRA_COLOR: Record<string, Cesium.Color> = {
  // Enclosed built form: the same off-white as a building, because that is
  // what it is.
  station_building: grey(OFF_WHITE, 0.92),
  concourse: grey(236, 0.9),
  entrance: grey(232, 0.94),

  // Paving and decks.
  platform: grey(198, 0.95),
  foot_over_bridge: grey(214, 0.95),
  deck_span: grey(196, 0.97),
  ramp: grey(190, 0.97),
  pier_cap: grey(168, 0.98),
  pillar: grey(158, 0.98),
  barrier: grey(220, 0.95),

  // A canopy is a roof, so it is nearly opaque. At 0.4 it read as haze AND
  // sorted badly against the platform four metres under it, which showed up as
  // bright blotches where two translucent surfaces disagreed about order.
  platform_shelter: grey(238, 0.82),

  // Running surfaces: the darkest tones on the structure.
  track: grey(86, 0.95),
  road: grey(70, 0.9),
  junction: grey(78, 0.9),
  parking: grey(92, 0.85),
};

/** Fallback for a component kind with no tone of its own. */
export const INFRA_DEFAULT = grey(190, 0.92);

/** The component the user has picked. Same white as every other selection. */
export const INFRA_SELECTED = grey(255, 0.97);

/** Outline of the picked component, so it reads at a distance. */
export const INFRA_SELECTED_OUTLINE = grey(255);

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
/**
 * The derived hazard-exposure ramp: four ordered classes, one sequential
 * yellow-to-red scale used for BOTH flood and cyclone.
 *
 * Sequential, not categorical, because the classes are ordered -- the reader
 * has to see "more" without consulting the key. One ramp for both hazards
 * rather than two palettes: only one hazard is ever drawn at a time, the key
 * names which, and a second hue set would imply the two are comparable
 * categories rather than the same scale applied twice.
 *
 * `low` is deliberately pale and nearly transparent. No part of a coastal
 * ward is at zero risk, and painting one flat would be a claim the data does
 * not support -- so the least-exposed class reads as "not flagged" instead.
 *
 * These are MEANING colours in the sense of the rule at the top of this file:
 * they are a legend entry, and hue is what makes the four legible at once.
 */
export const RISK_HEX: Record<RiskClass, string> = {
  low: '#FDE68A',       // pale straw
  moderate: '#FBBF24',  // amber
  high: '#F97316',      // orange
  severe: '#DC2626',    // deep red
};

/** Fill opacity of the ground patch per class. Ordered like the hues. */
export const RISK_ALPHA: Record<RiskClass, number> = {
  low: 0.14,
  moderate: 0.3,
  high: 0.42,
  severe: 0.55,
};

/** The ground patch drawn under each parcel, per class. */
export const RISK_COLOR: Record<RiskClass, Cesium.Color> = {
  low: Cesium.Color.fromCssColorString(RISK_HEX.low).withAlpha(RISK_ALPHA.low),
  moderate: Cesium.Color.fromCssColorString(RISK_HEX.moderate).withAlpha(RISK_ALPHA.moderate),
  high: Cesium.Color.fromCssColorString(RISK_HEX.high).withAlpha(RISK_ALPHA.high),
  severe: Cesium.Color.fromCssColorString(RISK_HEX.severe).withAlpha(RISK_ALPHA.severe),
};

/** Outline of a risk patch. Only the top two classes are outlined. */
export const RISK_OUTLINE: Record<RiskClass, Cesium.Color> = {
  low: Cesium.Color.fromCssColorString(RISK_HEX.low).withAlpha(0.0),
  moderate: Cesium.Color.fromCssColorString(RISK_HEX.moderate).withAlpha(0.0),
  high: Cesium.Color.fromCssColorString(RISK_HEX.high).withAlpha(0.5),
  severe: Cesium.Color.fromCssColorString(RISK_HEX.severe).withAlpha(0.75),
};

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
