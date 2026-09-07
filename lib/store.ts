'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import type { ProviderId, TreatmentId } from './cesium/imagery-catalog';
import { SUN_DEFAULT_HOUR, SUN_MAX_HOUR, SUN_MIN_HOUR } from './sun';
import type { BuildingEdit, FieldError } from './data/building-schema';
import type {
  BuildingDetail, BuildingStyle, ConflictRow, EnrichedBuilding, GeoFC, LayerKey,
  Mode, ParcelInfo, Project, RoadProps, SliceState, SurveyParcelProps,
  UtilityProps,
} from './types';
import { fetchLulcAt, type LulcResult } from './bhuvan';
import type { SiteIndexEntry, SiteSpec } from './infra/types';
import {
  UNDERGROUND_DEFAULTS, categoryOfAssetType, type UtilityCategory,
} from './underground/categories';
import { ringCentroid } from './geo';

/**
 * View state. This is the single source of truth for what the scene shows.
 *
 * ARCHITECTURE RULE: only the Picker and the UI controls call these setters.
 * Cesium layer components READ this store and render; they never write to it,
 * and they never move the camera -- CameraDirector owns all camera motion and
 * does so purely by reacting to changes here.
 */
export interface ViewState {
  /**
   * Which project the scene is showing.
   *
   * The ONLY field here that is not view state, and the only one with exactly
   * one writer: app/p/[slug]/ProjectViewer.tsx sets it once as the page
   * mounts, and nothing mutates it afterwards. There is deliberately no
   * setter -- adding one would invite a second writer, and "which project am
   * I looking at" changing under a live scene is a page navigation, not a
   * state change.
   *
   * Null only before the first project page has mounted.
   */
  projectSlug: string | null;
  /**
   * The project row itself: bbox, codes, and the optional bhuvan_layers block.
   *
   * Same single writer and lifecycle as projectSlug (ProjectViewer's useState
   * initialiser), and here for the same reason: the chrome -- LayerPanel,
   * Legend, DetailPanel -- mounts in OverlayRoot, outside CesiumRoot's viewer
   * context, and needs to know which overlays this project offers without
   * seven layers of prop drilling. Layers under Scene keep using
   * useViewer().project.
   */
  project: Project | null;

  /**
   * Who is signed in, as far as the BROWSER is concerned.
   *
   * Read once from /api/me and kept here so more than one component can ask.
   * It exists to drive presentation -- tint the citizen's own flat, hide an
   * Edit button they may not use -- and for nothing else.
   *
   * It is NOT an access control. The server already filters a citizen's
   * responses down to their own building and their own flat, so a tampered
   * value here changes what the viewer draws and not one byte of what it is
   * given. Any check that matters lives in lib/auth/access-pure.ts.
   *
   * Null until the first /api/me answers; `role: null` means anonymous or
   * not yet known, and every consumer treats those the same way.
   */
  session: { role: 'gov' | 'citizen' | null; floor: number | null; unit: string | null };

  mode: Mode;
  activeBuildingId: number | null;
  isolatedFloor: number | null;      // level_no, not floor id
  selectedUnitId: number | null;
  selectedUtilityId: number | null;
  /**
   * The infrastructure site the scene is showing, if any.
   *
   * NOT part of the building/floor/unit stack, and deliberately not a
   * `Mode`. A site is a place the camera goes, not a level of the cadastral
   * hierarchy -- you can be looking at a flyover with a building selected,
   * and neither fact invalidates the other.
   *
   * It is also the LAZY-LOAD GATE. A site's specification is only fetched
   * once it becomes active, and its geometry only built then, so a project
   * with several sites costs one of them.
   */
  activeSiteId: string | null;
  /**
   * The picked component of the active site: a platform, a pillar, a ramp.
   *
   * Keyed by the component's own string identifier rather than by a number,
   * because that identifier -- TTF-P-014 -- is the thing a user is given to
   * quote. The site id travels with it so the panel never has to guess which
   * structure a ref belongs to.
   */
  selectedComponent: { siteId: string; ref: string } | null;
  /**
   * The picked street.
   *
   * Kept apart from the building/floor/unit stack because it is not part of
   * that navigation: selecting a street changes what the panel describes, not
   * what mode the scene is in, and it never moves the camera.
   */
  selectedRoadId: number | null;
  hoveredBuildingId: number | null;
  hoveredRoadId: number | null;
  /**
   * The unit under the cursor on the isolated floor.
   *
   * Kept apart from hoveredBuildingId rather than folded into it: they are live
   * at the same time (the cursor is over a flat, inside a building) and the
   * tooltip and the units layer read different ones.
   */
  hoveredUnitId: number | null;
  layers: Record<LayerKey, boolean>;
  explodeT: number;                  // 0-100
  /** Section cut through the active building. Mutually exclusive with explode. */
  slice: SliceState;
  transparency: number;              // 0-100, applies to non-active buildings
  theme: 'dark' | 'light';
  underground: boolean;
  /**
   * Which underground categories are drawn, within `layers.utilities`.
   *
   * A SEPARATE record rather than more LayerKeys, because the two are
   * different kinds of switch: `layers.utilities` is the master -- is the
   * buried network in the scene at all -- and this says which strata of it.
   * Folding them together would make "turn the utilities off" and "turn water
   * off" the same operation, and would put seven more codes into the URL's
   * layer string for something the user thinks of as one control.
   *
   * A category that has never been true is never BUILT, so this is also the
   * lazy-loading gate: see components/layers/UtilitiesLayer.tsx.
   */
  undergroundLayers: Record<UtilityCategory, boolean>;
  /**
   * The 2D GIS view: a top-down cadastral map over a light vector basemap,
   * with the 3D stack hidden and `SurveyParcelsLayer` in its place.
   *
   * A BOOLEAN BESIDE `mode`, NOT A NEW `Mode`. `Mode` is the cadastral
   * hierarchy -- city, building, floor, unit -- and every layer, the camera
   * and the panel branch on where in that hierarchy you are. 2D GIS is not a
   * level of it; it is a different way of drawing whatever level you are on,
   * which is why it can remember and restore the mode it interrupted.
   *
   * MUTUALLY EXCLUSIVE WITH SLICE AND EXPLODE, enforced in `setGis2d`,
   * `setSlice` and `setExplode` rather than in the three controls -- the same
   * rule, and the same reason, as the pre-existing slice/explode exclusion
   * below it: whichever one the user reaches for wins, and no component has to
   * remember to switch the others off.
   *
   * NOT `viewMode`, which already exists on this store with the value '2D'.
   * That field is wired to a segmented control in the LayerPanel and to
   * nothing else -- no globe component reads it -- and adopting it would have
   * given this mode two writers on day one. It is left exactly as it is.
   */
  gis2d: boolean;
  /**
   * The survey parcel the panel is describing.
   *
   * Written by `Picker` and by `setGis2d` (which clears it) and by nothing
   * else, following the same single-writer rule as the rest of the selection.
   */
  activeSurveyParcelId: number | null;
  /**
   * What to put back when 2D GIS turns off.
   *
   * Entering the mode overwrites three fields the user chose -- the cadastral
   * mode, the basemap and its tone -- and leaving it has to undo exactly that
   * and nothing else. Holding the previous values here rather than
   * recomputing them means the restore cannot drift from what was overwritten.
   * `activeBuildingId` is carried too, not to be restored but to be COMPARED:
   * if the tree in the panel changed it, the viewer should land on that
   * building in 3D rather than on the level the user came from.
   *
   * Null whenever `gis2d` is false. Written by `setGis2d` only.
   */
  preGis2d: {
    mode: Mode;
    imageryProvider: ProviderId;
    imageryTreatment: TreatmentId;
    activeBuildingId: number | null;
  } | null;
  viewMode: '3D' | '2D' | 'Split';
  autoSpin: boolean;
  navMode: 'orbit' | 'pan' | 'zoom';
  /** Set when terrain falls back to the ellipsoid because no ion token exists. */
  ionFallback: boolean;

  /** The basemap the user picked. Written by the UI only. */
  imageryProvider: ProviderId;
  imageryTreatment: TreatmentId;
  /**
   * The basemap actually in use, which differs from imageryProvider whenever a
   * provider failed and fell back. Written by CesiumRoot only. Kept as its own
   * key so reporting the fallback cannot write back into the control that
   * triggered the swap.
   */
  imageryActive: ProviderId;

  /**
   * Whether ambient occlusion is actually running.
   *
   * The same shape as imageryActive, and for the same reason: what the scene
   * asked for and what the GPU agreed to are two different facts, and the
   * StatusBar reports the second. Null until the rig has run.
   *
   * 'unsupported' means the WebGL context cannot do it; 'low-end' means it
   * could and we chose not to (see lib/cesium/lighting.ts). Those read very
   * differently to someone deciding whether their machine is the problem, so
   * they are not collapsed into one boolean.
   *
   * Written by CesiumRoot only, like imageryActive.
   */
  ambientOcclusion: { on: boolean; reason: 'unsupported' | 'low-end' | null } | null;

  /**
   * Schematic extrusions vs Google Photorealistic 3D Tiles.
   *
   * Unlike imagery there is no separate "active" key. A failed tileset is not
   * a silent substitution the user can ignore in the StatusBar -- it changes
   * what the scene means -- so the failure path writes this back to
   * 'schematic' and raises photorealError, and the toggle tells the truth.
   */
  buildingStyle: BuildingStyle;
  /** Set when Google tiles failed; drives the toast. Null when healthy. */
  photorealError: string | null;

  /** The mini-dashboard panel. */
  statsOpen: boolean;

  /**
   * Time of day for the sun, 6-18 local, or null for no sun at all.
   *
   * Null is not "noon" -- it is "light the globe flatly and draw no shadows",
   * which is still what the slider's off position means and still the cheap
   * path (shadows cost a depth pass over every casting building). It is no
   * longer the boot state: the scene starts at SUN_DEFAULT_HOUR, because
   * raking light is what makes the extruded massing read as height.
   */
  sunHour: number | null;

  selectBuilding: (id: number | null) => void;
  isolateFloor: (level: number | null) => void;
  selectUnit: (id: number | null) => void;
  /**
   * Jump straight to a unit on a level that is not isolated yet, in ONE write.
   *
   * Clicking a flat on the exploded stack in building mode has to set both
   * isolatedFloor and selectedUnitId; doing it as isolateFloor()+selectUnit()
   * would publish an intermediate state in which the floor is isolated and the
   * unit is not, and every subscriber -- CameraDirector above all -- would act
   * on it and start the wrong flight.
   */
  openUnit: (level: number, id: number) => void;
  selectUtility: (id: number | null) => void;
  /** Open a site, or leave it. Null returns the camera to the AOI. */
  selectSite: (id: string | null) => void;
  selectComponent: (siteId: string, ref: string) => void;
  setHovered: (id: number | null) => void;
  /**
   * Every hover target in ONE write, so a mouse move renders once.
   *
   * Three explicit arguments rather than a defaulted third: a default would
   * let a future caller clear the road hover without meaning to, and this is
   * called from exactly one place.
   */
  setHover: (
    buildingId: number | null,
    unitId: number | null,
    roadId: number | null,
  ) => void;
  selectRoad: (id: number | null) => void;
  /**
   * Drop the AMBIENT selections -- street and utility -- and nothing else.
   *
   * This is what a click on bare ground does. Buildings, floors and units are
   * a navigation stack with explicit exits ("Back to floor", "Reset view"),
   * and after the fact there is no way to tell "meant to deselect" from
   * "missed the target" -- so a stray click on the sky must not tear that
   * stack down. Streets and utilities have no such stack, so clearing them is
   * unambiguous and is what the user expects from clicking away.
   */
  clearAmbient: () => void;
  toggleLayer: (key: LayerKey) => void;
  setExplode: (t: number) => void;
  setSlice: (patch: Partial<SliceState>) => void;
  setTransparency: (t: number) => void;
  toggleTheme: () => void;
  setUnderground: (on: boolean) => void;
  toggleUndergroundLayer: (key: UtilityCategory) => void;
  /** Bulk-set, for the URL hydrate and the panel's all-on/all-off. */
  setUndergroundLayers: (next: Partial<Record<UtilityCategory, boolean>>) => void;
  /** Enter or leave the 2D GIS view. The only writer of `gis2d`. */
  setGis2d: (on: boolean) => void;
  /** Select a survey parcel. Called by Picker and by the panel's own close. */
  setActiveSurveyParcel: (id: number | null) => void;
  setViewMode: (m: '3D' | '2D' | 'Split') => void;
  setAutoSpin: (on: boolean) => void;
  setNavMode: (m: 'orbit' | 'pan' | 'zoom') => void;
  setIonFallback: (on: boolean) => void;
  setImageryProvider: (id: ProviderId) => void;
  setImageryTreatment: (t: TreatmentId) => void;
  setImageryActive: (id: ProviderId) => void;
  setAmbientOcclusion: (s: ViewState['ambientOcclusion']) => void;
  setBuildingStyle: (s: BuildingStyle) => void;
  /** Report a Google-tiles failure and fall back to Schematic in one write. */
  failPhotoreal: (message: string) => void;
  dismissPhotorealError: () => void;
  setStatsOpen: (on: boolean) => void;
  setSunHour: (h: number | null) => void;
  /** Record who is signed in, once /api/me has answered. */
  setSession: (s: ViewState['session']) => void;
  /** Bulk-apply state parsed from the URL on first paint. See lib/url-state.ts. */
  hydrate: (patch: Partial<ViewState>) => void;
  resetView: () => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  parcels: false,
  buildings: true,
  // On by default: streets are basic orientation context, and a layer nobody
  // can find is a feature nobody has. Utilities stay off because underground
  // is a specialist mode, not a default view.
  roads: true,
  floors: true,
  utilities: false,
  terrain: true,
  basemap: true,
  // Bhuvan context overlays are opt-in: they are coarse relative to the
  // footprints and they cost WMS round-trips to a government server.
  bhuvanLulc: false,
  bhuvanFlood: false,
  bhuvanCyclone: false,
};

/**
 * Which underground category a picked run belongs to.
 *
 * Reads the data store rather than taking a parameter: the only caller is a
 * view-store setter, and threading the category through every call site of
 * toggleUndergroundLayer would put a lookup into six UI components instead of
 * one place. Null when the data has not loaded or the type is unrecognised,
 * which both mean "do not touch the selection".
 */
function utilityCategoryOf(id: number): UtilityCategory | null {
  const fc = useDataStore.getState().utilities;
  const f = fc?.features.find((x) => (x.properties as UtilityProps).id === id);
  return f ? categoryOfAssetType((f.properties as UtilityProps).asset_type) : null;
}

/**
 * The basemap and tone the 2D GIS view swaps to.
 *
 * Voyager rather than Positron, and `natural` rather than `gisDark`, because
 * the acceptance harness requires the SCENE to carry real chroma -- it fails
 * below 3% of coloured pixels (scripts/shoot.mjs) to catch a treatment that
 * has drained the basemap. Positron is very nearly greyscale and its land
 * colour sits within a couple of units of the noise floor that test uses;
 * Voyager carries green parks, blue water and tan carriageways over an
 * off-white ground, which is a light vector basemap that is still in colour.
 *
 * Named here rather than inside `setGis2d` so the StatusBar can print the
 * basemap without duplicating the choice.
 */
export const GIS2D_PROVIDER: ProviderId = 'cartoVoyager';
export const GIS2D_TREATMENT: TreatmentId = 'natural';

/**
 * Leave the 2D GIS view, putting back exactly what entering it overwrote.
 *
 * Shared by `setGis2d(false)`, `setExplode`, `setSlice` and `resetView`, so
 * every way out of the mode unwinds it identically -- four copies of a restore
 * is four chances to forget the basemap and leave the user in a 3D scene drawn
 * over a street map.
 *
 * The mode it restores is the one it interrupted, EXCEPT when the panel's tree
 * changed the selected building while the mode was on: landing back on the
 * level the user came from would then mean landing on a different building's
 * floor, so a changed selection wins and the viewer opens on that building.
 */
function leaveGis2d(s: ViewState): Partial<ViewState> {
  if (!s.gis2d) return {};
  const prev = s.preGis2d;
  const picked = prev !== null && s.activeBuildingId !== prev.activeBuildingId;
  const mode: Mode = s.activeBuildingId === null
    ? 'city'
    : picked
      ? 'building'
      : prev?.mode ?? 'building';
  return {
    gis2d: false,
    preGis2d: null,
    activeSurveyParcelId: null,
    mode,
    ...(prev
      ? {
        imageryProvider: prev.imageryProvider,
        imageryTreatment: prev.imageryTreatment,
      }
      : {}),
  };
}

export const useViewStore = create<ViewState>((set) => ({
  projectSlug: null,
  project: null,
  session: { role: null, floor: null, unit: null },
  mode: 'city',
  activeBuildingId: null,
  isolatedFloor: null,
  selectedUnitId: null,
  selectedUtilityId: null,
  activeSiteId: null,
  selectedComponent: null,
  selectedRoadId: null,
  hoveredBuildingId: null,
  hoveredRoadId: null,
  hoveredUnitId: null,
  layers: { ...DEFAULT_LAYERS },
  explodeT: 0,
  slice: { enabled: false, axis: 'ew', offset: 0 },
  transparency: 12,
  theme: 'dark',
  underground: false,
  undergroundLayers: { ...UNDERGROUND_DEFAULTS },
  gis2d: false,
  activeSurveyParcelId: null,
  preGis2d: null,
  viewMode: '3D',
  autoSpin: false,
  navMode: 'orbit',
  ionFallback: false,
  imageryProvider: 'esri',
  imageryTreatment: 'gisDark',
  imageryActive: 'esri',
  ambientOcclusion: null,
  // Schematic is the default and the fallback: it is the only mode that
  // carries provenance, and it needs no third-party quota to draw.
  buildingStyle: 'schematic',
  photorealError: null,
  statsOpen: false,
  sunHour: SUN_DEFAULT_HOUR,

  selectBuilding: (id) =>
    set((s) =>
      id === null
        ? { mode: 'city', activeBuildingId: null, isolatedFloor: null,
            selectedUnitId: null, selectedUtilityId: null, selectedRoadId: null,
            explodeT: 0,
            // The cut plane is positioned across THIS building's footprint, so
            // it means nothing once there is no active building.
            slice: { ...s.slice, enabled: false } }
        // In 2D GIS the mode stays where setGis2d put it. The panel's tree is
        // a legitimate caller of this setter, and letting it flip the mode to
        // 'building' would ask the 3D stack to build under a top-down map --
        // and would then be overwritten again on exit. leaveGis2d() notices
        // that the selection changed and lands on this building instead.
        : { mode: s.gis2d ? s.mode : 'building', activeBuildingId: id, isolatedFloor: null,
            selectedUnitId: null, selectedUtilityId: null, selectedRoadId: null,
            slice: { ...s.slice, enabled: false, offset: 0 },
            // Auto-enable the parcels layer on selection so the user can see
            // the lot their selection is in without having to discover the
            // toggle. They can still turn it off and it will stay off.
            layers: { ...s.layers, parcels: true } }),

  isolateFloor: (level) =>
    set((s) =>
      level === null
        ? { mode: s.activeBuildingId ? 'building' : 'city', isolatedFloor: null,
            selectedUnitId: null, selectedRoadId: null }
        : { mode: 'floor', isolatedFloor: level, selectedUnitId: null,
            selectedRoadId: null }),

  selectUnit: (id) =>
    set((s) =>
      id === null
        ? { mode: s.isolatedFloor !== null ? 'floor' : 'building', selectedUnitId: null }
        : { mode: 'unit', selectedUnitId: id, selectedUtilityId: null,
            selectedRoadId: null }),

  openUnit: (level, id) =>
    set({ mode: 'unit', isolatedFloor: level, selectedUnitId: id,
          selectedUtilityId: null, selectedRoadId: null }),

  selectUtility: (id) =>
    set({ selectedUtilityId: id, selectedRoadId: null, selectedComponent: null }),
  selectRoad: (id) =>
    set({ selectedRoadId: id, selectedUtilityId: null, selectedComponent: null }),

  /**
   * Leaving a site drops the component selection with it: a card describing
   * a pillar the scene is no longer showing is a card the user cannot clear
   * by clicking anything.
   */
  selectSite: (id) =>
    set((st) => ({
      activeSiteId: id,
      selectedComponent: id === st.activeSiteId ? st.selectedComponent : null,
    })),

  selectComponent: (siteId, ref) =>
    set({
      selectedComponent: { siteId, ref },
      // A component is an ambient selection, like a street or a pipe: it
      // describes what the panel is showing without changing the mode.
      selectedUtilityId: null,
      selectedRoadId: null,
    }),

  clearAmbient: () =>
    set({ selectedRoadId: null, selectedUtilityId: null, selectedComponent: null }),
  setHovered: (id) => set({ hoveredBuildingId: id }),
  setHover: (buildingId, unitId, roadId) =>
    set({ hoveredBuildingId: buildingId, hoveredUnitId: unitId,
          hoveredRoadId: roadId }),

  toggleLayer: (key) =>
    set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),

  // Explode, slice and 2D GIS are mutually exclusive, and the exclusion is
  // enforced here rather than in the three controls: whichever one the user
  // reaches for wins, and no component has to remember to switch the others
  // off. Turning explode or slice ON therefore leaves 2D GIS the same way the
  // toggle would, restoring the basemap and the mode it took over.
  setExplode: (t) =>
    set((s) => {
      const explodeT = Math.max(0, Math.min(100, t));
      if (explodeT === 0) return { explodeT };
      return {
        explodeT,
        ...(s.slice.enabled ? { slice: { ...s.slice, enabled: false } } : {}),
        ...leaveGis2d(s),
      };
    }),

  setSlice: (patch) =>
    set((s) => {
      const slice = { ...s.slice, ...patch };
      slice.offset = Math.max(-100, Math.min(100, slice.offset));
      return slice.enabled
        ? { slice, explodeT: 0, ...leaveGis2d(s) }
        : { slice };
    }),

  setGis2d: (on) =>
    set((s) => {
      if (on === s.gis2d) return {};
      if (!on) return leaveGis2d(s);
      return {
        gis2d: true,
        preGis2d: {
          mode: s.mode,
          imageryProvider: s.imageryProvider,
          imageryTreatment: s.imageryTreatment,
          activeBuildingId: s.activeBuildingId,
        },
        // The cadastral stack stays SELECTED -- activeBuildingId, isolatedFloor
        // and selectedUnitId are untouched -- but the mode drops to city so
        // that nothing downstream is asked to draw a floor stack in a
        // top-down 2D map. Leaving them selected is what makes the exit able
        // to put the user back exactly where they were.
        mode: 'city',
        imageryProvider: GIS2D_PROVIDER,
        imageryTreatment: GIS2D_TREATMENT,
        explodeT: 0,
        slice: { ...s.slice, enabled: false },
        activeSurveyParcelId: null,
      };
    }),

  setActiveSurveyParcel: (id) => set({ activeSurveyParcelId: id }),

  setTransparency: (t) => set({ transparency: Math.max(0, Math.min(100, t)) }),
  toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),

  // Underground mode turns the utility layer on as a matter of course -- the
  // toggle would otherwise appear to do nothing.
  setUnderground: (on) =>
    set((s) => ({
      underground: on,
      selectedUtilityId: on ? s.selectedUtilityId : null,
      layers: { ...s.layers, utilities: on ? true : s.layers.utilities },
    })),

  toggleUndergroundLayer: (key) =>
    set((s) => {
      const wasOn = s.undergroundLayers[key];
      return {
        undergroundLayers: { ...s.undergroundLayers, [key]: !wasOn },
        // Turning a stratum on while the master switch is off would appear to
        // do nothing -- the same reasoning setUnderground already applies.
        layers: wasOn ? s.layers : { ...s.layers, utilities: true },
        // Hiding the stratum the selection lives in would leave a card
        // describing a pipe that is no longer on screen, and no way to clear
        // it by clicking. Only that case: a selection in another category is
        // still visible and stays put.
        selectedUtilityId:
          wasOn && s.selectedUtilityId !== null
            && utilityCategoryOf(s.selectedUtilityId) === key
            ? null
            : s.selectedUtilityId,
      };
    }),

  setUndergroundLayers: (next) =>
    set((s) => ({ undergroundLayers: { ...s.undergroundLayers, ...next } })),

  setViewMode: (m) => set({ viewMode: m }),
  setAutoSpin: (on) => set({ autoSpin: on }),
  setNavMode: (m) => set({ navMode: m }),
  setIonFallback: (on) => set({ ionFallback: on }),
  setImageryProvider: (id) => set({ imageryProvider: id }),
  setImageryTreatment: (t) => set({ imageryTreatment: t }),
  setImageryActive: (id) => set({ imageryActive: id }),
  setAmbientOcclusion: (ao) => set({ ambientOcclusion: ao }),

  // Switching style by hand clears any previous failure, so retrying Photoreal
  // after a transient network blip is just clicking the toggle again.
  setBuildingStyle: (s) => set({ buildingStyle: s, photorealError: null }),
  failPhotoreal: (message) =>
    set({ buildingStyle: 'schematic', photorealError: message }),
  dismissPhotorealError: () => set({ photorealError: null }),

  setStatsOpen: (on) => set({ statsOpen: on }),
  setSession: (s) => set({ session: s }),
  setSunHour: (h) =>
    set({ sunHour: h === null ? null : Math.max(SUN_MIN_HOUR, Math.min(SUN_MAX_HOUR, h)) }),

  /**
   * Bulk-apply state parsed from the URL.
   *
   * NOT a plain `set`. A bulk write can reach states no setter would produce,
   * and one of them was reachable from a shared link: `?ug=1` restored
   * underground mode while `layers.utilities` kept its default of false, so
   * the mode opened with its master switch off and nothing underground was
   * built. setUnderground couples those two deliberately; a second writer that
   * does not is how an invariant stops being one.
   */
  hydrate: (patch) =>
    set((s) => {
      const next = { ...patch };
      const underground = next.underground ?? s.underground;
      if (underground && next.layers === undefined && !s.layers.utilities) {
        next.layers = { ...s.layers, utilities: true };
      }
      return next;
    }),

  resetView: () =>
    set((s) => ({
      // FIRST, so the explicit fields below win. leaveGis2d puts the basemap
      // and tone back, which Reset must do or it leaves a 3D scene drawn over
      // a street map; the mode it would restore is not wanted here, because
      // Reset has always meant city view and nothing selected.
      ...leaveGis2d(s),
      mode: 'city', activeBuildingId: null, isolatedFloor: null,
      selectedUnitId: null, selectedUtilityId: null, selectedRoadId: null,
      hoveredBuildingId: null, hoveredRoadId: null,
      hoveredUnitId: null, explodeT: 0, underground: false, autoSpin: false,
      activeSiteId: null, selectedComponent: null,
      undergroundLayers: { ...UNDERGROUND_DEFAULTS },
      slice: { ...s.slice, enabled: false },
    })),
}));

/**
 * Fetched cadastral data, kept apart from view state so that a re-render caused
 * by (say) moving the explode slider never invalidates the data cache.
 */
export interface DataState {
  buildings: GeoFC<EnrichedBuilding> | null;
  parcels: GeoFC<ParcelInfo> | null;
  /**
   * The 2D cadastral layer. Null until the 2D GIS view is first opened.
   *
   * NOT fetched at boot, unlike the five collections above. It is a few
   * hundred kilobytes that nobody who never presses the toggle will look at,
   * and the boot path is already the slowest thing this application does.
   * useEnsureSurveyParcels() fetches it once, on demand.
   */
  surveyParcels: GeoFC<SurveyParcelProps> | null;
  /** True while that one fetch is in flight, so it is not issued twice. */
  pendingSurveyParcels: boolean;
  utilities: GeoFC<UtilityProps> | null;
  roads: GeoFC<RoadProps> | null;
  conflicts: ConflictRow[];
  /**
   * The project's infrastructure sites, as an index. Null until fetched;
   * an empty array is the normal answer for a project that has none.
   */
  sites: SiteIndexEntry[] | null;
  /** Full specifications, keyed by site id. Fetched one site at a time. */
  siteSpecs: Record<string, SiteSpec>;
  pendingSites: Record<string, true>;
  detail: Record<number, BuildingDetail>;
  /**
   * Ids in the detail cache, least-recently-used first.
   *
   * Kept beside `detail` rather than as a Map with insertion order because the
   * store is read by React components that compare by identity: a plain array
   * makes an eviction a visible state change, which is what it is.
   */
  detailOrder: number[];
  /**
   * Building ids whose detail fetch is in flight.
   *
   * `detail[id]` being absent cannot distinguish "still loading" from "failed",
   * and the DetailPanel needs that distinction to decide between a skeleton and
   * the em-dash fallback. It also dedupes: five components call useEnsureDetail
   * with the same id, and without this each one fetched the same document.
   */
  pendingDetail: Record<number, true>;
  /**
   * ISRO Bhuvan LULC class per building id, looked up by GetFeatureInfo at
   * the footprint centroid on first selection. 'none' means the WMS answered
   * and no polygon covers the point. Failures are NOT cached, so a re-select
   * retries. Records rather than Maps so Zustand's identity comparison works,
   * like `detail` above.
   */
  lulc: Record<number, LulcEntry>;
  pendingLulc: Record<number, true>;
  loading: boolean;
  error: string | null;
  /**
   * Bumped ONLY when the whole collection is (re)loaded, never by an
   * attribute edit.
   *
   * BuildingsLayer builds 768 entities in an effect that used to depend on
   * `buildings`. Editing one attribute changes that object's identity, which
   * would tear down and rebuild every extrusion in the scene -- the exact cost
   * that layer's design exists to avoid, paid at the worst possible moment,
   * immediately after the user clicks Save. Keying the build on this counter
   * instead means geometry is rebuilt when the data genuinely reloads, and a
   * single edited building is updated in place.
   */
  buildingsEpoch: number;

  setBuildings: (fc: GeoFC<EnrichedBuilding>) => void;
  setParcels: (fc: GeoFC<ParcelInfo>) => void;
  setSurveyParcels: (fc: GeoFC<SurveyParcelProps> | null) => void;
  beginSurveyParcels: () => void;
  setUtilities: (fc: GeoFC<UtilityProps>) => void;
  setRoads: (fc: GeoFC<RoadProps>) => void;
  setConflicts: (rows: ConflictRow[]) => void;
  setSites: (rows: SiteIndexEntry[]) => void;
  putSiteSpec: (id: string, spec: SiteSpec) => void;
  beginSite: (id: string) => void;
  endSite: (id: string) => void;
  putDetail: (id: number, d: BuildingDetail) => void;
  /** Mark a cached document as freshly used, so it is not the next evicted. */
  touchDetail: (id: number) => void;
  /**
   * Replace ONE building's properties in the loaded collection.
   *
   * Produces a new `buildings` object identity, which every subscriber sees.
   * That is why `buildingsEpoch` exists beside it -- see below.
   */
  patchBuilding: (id: number, props: Partial<EnrichedBuilding>) => void;
  beginDetail: (id: number) => void;
  endDetail: (id: number) => void;
  putLulc: (id: number, r: LulcEntry) => void;
  beginLulc: (id: number) => void;
  endLulc: (id: number) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

/**
 * How many building detail documents to keep client-side.
 *
 * See putDetail for why this is a document count and not a byte budget.
 */
const DETAIL_CACHE_LIMIT = 48;

export const useDataStore = create<DataState>((set) => ({
  buildings: null,
  parcels: null,
  surveyParcels: null,
  pendingSurveyParcels: false,
  utilities: null,
  roads: null,
  conflicts: [],
  sites: null,
  siteSpecs: {},
  pendingSites: {},
  detail: {},
  detailOrder: [],
  pendingDetail: {},
  lulc: {},
  pendingLulc: {},
  loading: false,
  error: null,
  buildingsEpoch: 0,

  setBuildings: (fc) =>
    set((st) => ({ buildings: fc, buildingsEpoch: st.buildingsEpoch + 1 })),
  setParcels: (fc) => set({ parcels: fc }),
  setSurveyParcels: (fc) => set({ surveyParcels: fc, pendingSurveyParcels: false }),
  beginSurveyParcels: () => set({ pendingSurveyParcels: true }),
  setUtilities: (fc) => set({ utilities: fc }),
  setRoads: (fc) => set({ roads: fc }),
  setConflicts: (rows) => set({ conflicts: rows }),

  setSites: (rows) => set({ sites: rows }),
  /**
   * Cache a site's specification.
   *
   * Unbounded, unlike the building detail cache below, and deliberately: a
   * project holds a handful of sites, each a few tens of kilobytes, and they
   * are immutable for the life of the page. An LRU here would evict the one
   * structure the user is standing in.
   */
  putSiteSpec: (id, spec) =>
    set((s) => ({
      siteSpecs: { ...s.siteSpecs, [id]: spec },
      pendingSites: (({ [id]: _drop, ...rest }) => rest)(s.pendingSites),
    })),
  beginSite: (id) =>
    set((s) => ({ pendingSites: { ...s.pendingSites, [id]: true as const } })),
  endSite: (id) =>
    set((s) => ({
      pendingSites: (({ [id]: _drop, ...rest }) => rest)(s.pendingSites),
    })),
  putDetail: (id, d) =>
    set((s) => {
      // BOUNDED, and least-recently-used.
      //
      // This cache used to grow without limit: every building the user touched
      // stayed in memory for the life of the tab, and a detail document runs
      // to 35 KB of floors, units and rings. A session spent clicking around
      // an AOI therefore leaked steadily -- the probe measured +45 MB of heap
      // over five select/deselect cycles alone.
      //
      // The bound is on the number of documents rather than on bytes: the
      // documents are of comparable size, and counting bytes would mean
      // measuring them, which is more expensive than the cache saves. 48 is
      // roughly a working session of browsing, which is what a cache is for --
      // going back to a building you just looked at must stay instant.
      const detail = { ...s.detail, [id]: d };
      const order = [...s.detailOrder.filter((x) => x !== id), id];
      while (order.length > DETAIL_CACHE_LIMIT) {
        const evicted = order.shift();
        if (evicted !== undefined) delete detail[evicted];
      }
      return { detail, detailOrder: order };
    }),

  touchDetail: (id) =>
    set((s) => (s.detail[id]
      ? { detailOrder: [...s.detailOrder.filter((x) => x !== id), id] }
      : s)),

  patchBuilding: (id, props) =>
    set((s) => {
      if (!s.buildings) return s;
      const i = s.buildings.features.findIndex((f) => f.properties.id === id);
      if (i < 0) return s;
      const features = s.buildings.features.slice();
      features[i] = {
        ...features[i],
        properties: { ...features[i].properties, ...props },
      };
      // Note: buildingsEpoch is deliberately NOT bumped. This is an attribute
      // change, not a reload, and the scene updates the one affected building
      // imperatively rather than rebuilding all of them.
      return { buildings: { ...s.buildings, features } };
    }),
  beginDetail: (id) => set((s) => ({ pendingDetail: { ...s.pendingDetail, [id]: true } })),
  endDetail: (id) =>
    set((s) => {
      if (!s.pendingDetail[id]) return s;
      const next = { ...s.pendingDetail };
      delete next[id];
      return { pendingDetail: next };
    }),
  putLulc: (id, r) => set((s) => ({ lulc: { ...s.lulc, [id]: r } })),
  beginLulc: (id) => set((s) => ({ pendingLulc: { ...s.pendingLulc, [id]: true } })),
  endLulc: (id) =>
    set((s) => {
      if (!s.pendingLulc[id]) return s;
      const next = { ...s.pendingLulc };
      delete next[id];
      return { pendingLulc: next };
    }),
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e }),
}));

/** A resolved LULC lookup: the class, or 'none' when no polygon covers the point. */
export type LulcEntry = LulcResult | 'none';

/** Utility helper: the detail record for the active building, if loaded. */
export function useActiveDetail(): BuildingDetail | null {
  const id = useViewStore((s) => s.activeBuildingId);
  const detail = useDataStore((s) => s.detail);
  return id === null ? null : detail[id] ?? null;
}

// ---------------------------------------------------------------------------
// Reactive context selectors for the DetailPanel.
//
// These hooks read the data store and return derived views over the active
// building. They are pure: they do not write to the view store, do not fetch,
// and memoise on the input id plus the arrays they depend on.
// ---------------------------------------------------------------------------

/** Other buildings on the same parcel as the active one. */
export function useParcelSiblings(activeBuildingId: number | null): EnrichedBuilding[] {
  const buildings = useDataStore((s) => s.buildings);
  if (!buildings || activeBuildingId === null) return [];
  const me = buildings.features.find((f) => f.properties.id === activeBuildingId)?.properties;
  if (!me) return [];
  return buildings.features
    .map((f) => f.properties)
    .filter((p) => p.parcel_id === me.parcel_id && p.id !== me.id);
}

/** Conflicts whose building matches the active selection. */
export function useBuildingConflicts(activeBuildingId: number | null): ConflictRow[] {
  const conflicts = useDataStore((s) => s.conflicts);
  if (activeBuildingId === null) return [];
  return conflicts.filter((c) => c.building_id === activeBuildingId);
}

/** Other buildings within `radiusM` of the active centroid, sorted nearest first. */
export function useBuildingNeighbours(
  activeBuildingId: number | null,
  radiusM = 50,
): Array<{ b: EnrichedBuilding; distanceM: number }> {
  const buildings = useDataStore((s) => s.buildings);
  if (!buildings || activeBuildingId === null) return [];
  const me = buildings.features.find((f) => f.properties.id === activeBuildingId);
  if (!me) return [];
  const myRing = (me.geometry.coordinates as number[][][])[0];
  const { lon: mLon, lat: mLat } = (() => {
    const n = Math.max(1, myRing.length - 1);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += myRing[i][0]; y += myRing[i][1]; }
    return { lon: x / n, lat: y / n };
  })();
  const out: Array<{ b: EnrichedBuilding; distanceM: number }> = [];
  for (const f of buildings.features) {
    if (f.properties.id === activeBuildingId) continue;
    const ring = (f.geometry.coordinates as number[][][])[0];
    const n = Math.max(1, ring.length - 1);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
    const lon = x / n, lat = y / n;
    const R = 6371008.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat - mLat);
    const dLon = toRad(lon - mLon);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(mLat)) * Math.cos(toRad(lat)) * Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    if (d <= radiusM) out.push({ b: f.properties, distanceM: d });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, 5);
}

export type { UtilityProps };

/**
 * Fetch a building's floors/units on demand and cache them.
 *
 * Writes only to the DATA store, never to the view store, so layers may call
 * this without breaking the "layers read, picker/UI write" rule.
 */
export function useEnsureDetail(id: number | null): BuildingDetail | null {
  const detail = useDataStore((s) => s.detail);
  /**
   * Whether THIS id is cached, as a boolean.
   *
   * The effect below depends on this rather than on the whole `detail` record,
   * and the difference matters now that the effect has a cleanup. Depending on
   * the record means any document landing anywhere re-runs the effect, which
   * fires the cleanup, which aborts the fetch in flight for the building the
   * user is actually looking at -- and the pendingDetail guard then stops the
   * re-run from starting it again, so the panel would wait forever.
   *
   * A boolean changes only when this building's own presence changes, so a
   * cleanup can only mean "the id changed, the doc arrived, or we unmounted",
   * all three of which are safe to abort on.
   */
  const isCached = useDataStore((s) => id !== null && Boolean(s.detail[id]));
  /**
   * SCOPED TO THE PROJECT.
   *
   * This used to fetch the UNSCOPED `/api/building/:id`, which the alias route
   * resolves to the demo project. Building ids restart per project, so opening
   * a building in any other AOI silently returned the demo project's floors
   * and units for the same numeric id -- a wrong document rendered as if it
   * were right, which is worse than an error.
   *
   * Null before the first project page has mounted, which is also the only
   * time this hook can be called with nothing to fetch for.
   */
  const slug = useViewStore((s) => s.projectSlug);

  useEffect(() => {
    if (id === null || slug === null) return undefined;
    if (isCached) {
      // A cache HIT is still a use: without this the document you keep coming
      // back to ages out exactly like one you looked at once, which is the
      // opposite of what an LRU is for.
      useDataStore.getState().touchDetail(id);
      return undefined;
    }
    // pendingDetail is read imperatively rather than subscribed to: making it a
    // dependency would re-run this effect the moment the fetch is registered.
    // Five components call this hook with the same id, so the guard is what
    // turns five identical requests into one.
    if (useDataStore.getState().pendingDetail[id]) return undefined;
    useDataStore.getState().beginDetail(id);

    // An AbortController, so that clicking through buildings faster than the
    // network answers does not leave a queue of responses to parse. The
    // document that arrives for a building the user has already left is not
    // wrong, but paying to decode 35 KB of JSON for it is: at a fast click
    // rate that decode is what makes the panel for the CURRENT building late.
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/p/${slug}/building/${id}`, {
          signal: abort.signal,
        });
        if (!res.ok) return;
        const doc = (await res.json()) as BuildingDetail;
        useDataStore.getState().putDetail(id, doc);
      } catch {
        /* aborted, or transient: the layer renders nothing until it succeeds */
      } finally {
        useDataStore.getState().endDetail(id);
      }
    })();

    return () => {
      // Only abandon a fetch that is still in flight. Aborting after the
      // document landed is harmless but pointless; aborting before it did is
      // the whole point.
      if (!useDataStore.getState().detail[id]) abort.abort();
    };
  }, [id, slug, isCached]);

  return id === null ? null : detail[id] ?? null;
}

/** True while `/api/building/:id` is in flight. Distinct from "failed". */
export function useDetailPending(id: number | null): boolean {
  const pending = useDataStore((s) => s.pendingDetail);
  return id === null ? false : Boolean(pending[id]);
}

/** Give up on a Bhuvan lookup after this long; the panel never waits on it. */
const LULC_TIMEOUT_MS = 8000;

/**
 * Ensure the ISRO Bhuvan LULC class for a building is being fetched, and
 * return it once it is.
 *
 * The useEnsureDetail pattern -- data store only, one request per id, an
 * AbortController for a selection the user has already left -- with two
 * deliberate differences: it keys off `buildingsEpoch` rather than the
 * `buildings` object, so an attribute edit does not abort a lookup in flight,
 * and it never caches a failure, so the next selection retries. It is a no-op
 * when the project defines no LULC layer.
 */
export function useEnsureLulc(id: number | null, layer: string | null): LulcEntry | null {
  const cached = useDataStore((s) => (id === null ? undefined : s.lulc[id]));
  const isCached = cached !== undefined;
  const epoch = useDataStore((s) => s.buildingsEpoch);

  useEffect(() => {
    if (id === null || !layer || isCached) return undefined;
    const st = useDataStore.getState();
    if (st.pendingLulc[id]) return undefined;
    const f = st.buildings?.features.find((x) => x.properties.id === id);
    if (!f) return undefined;
    const p = f.properties;
    const c = p.lat !== undefined && p.lon !== undefined
      ? { lon: p.lon, lat: p.lat }
      : ringCentroid((f.geometry.coordinates as number[][][])[0]);

    st.beginLulc(id);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LULC_TIMEOUT_MS);
    (async () => {
      try {
        const r = await fetchLulcAt(layer, c.lon, c.lat, abort.signal);
        useDataStore.getState().putLulc(id, r ?? 'none');
      } catch {
        /* aborted, timed out or WMS down: left uncached so a re-select retries */
      } finally {
        clearTimeout(timer);
        useDataStore.getState().endLulc(id);
      }
    })();
    return () => {
      if (useDataStore.getState().lulc[id] === undefined) abort.abort();
    };
  }, [id, layer, isCached, epoch]);

  return id === null ? null : cached ?? null;
}

/** True while the Bhuvan GetFeatureInfo for this building is in flight. */
export function useLulcPending(id: number | null): boolean {
  const pending = useDataStore((s) => s.pendingLulc);
  return id === null ? false : Boolean(pending[id]);
}


// ---------------------------------------------------------------------------
// Manual edit session.
//
// A THIRD store, deliberately. The view store's contract (see the top of this
// file) is scene state that layers and CameraDirector subscribe to; a draft
// form value is neither, and putting it there would wake every layer on every
// keystroke. It is also not fetched data, so it does not belong in the data
// store either.
// ---------------------------------------------------------------------------

export interface EditState {
  /** The building whose form is open, or null. */
  editingId: number | null;
  /**
   * Drafts, kept per building.
   *
   * Retained when the user navigates away mid-edit rather than discarded: a
   * Cesium click has already written the view store by the time React could
   * offer a confirm dialog, so blocking the navigation is not available. The
   * honest alternative is to keep the work and say so, which is what the
   * unsaved-changes banner does.
   */
  drafts: Record<number, Partial<BuildingEdit>>;
  saving: boolean;
  /** Per-field errors from the last save attempt, client- or server-side. */
  fieldErrors: FieldError[];
  /** A form-level failure (network, 500) that is not about one field. */
  formError: string | null;
  /** Revision of the last successful save, for the transient confirmation. */
  savedRev: number | null;

  beginEdit: (id: number) => void;
  cancelEdit: (id: number) => void;
  setDraftField: (id: number, field: keyof BuildingEdit, value: string | number) => void;
  setSaving: (b: boolean) => void;
  setFieldErrors: (e: FieldError[]) => void;
  setFormError: (e: string | null) => void;
  finishSave: (id: number, rev: number) => void;
  clearSaved: () => void;
}

export const useEditStore = create<EditState>((set) => ({
  editingId: null,
  drafts: {},
  saving: false,
  fieldErrors: [],
  formError: null,
  savedRev: null,

  beginEdit: (id) => set({ editingId: id, fieldErrors: [], formError: null, savedRev: null }),

  cancelEdit: (id) =>
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[id];
      return { editingId: null, drafts, fieldErrors: [], formError: null };
    }),

  setDraftField: (id, field, value) =>
    set((s) => ({
      drafts: { ...s.drafts, [id]: { ...s.drafts[id], [field]: value } },
      // Clearing this field's error as soon as it is touched: leaving a stale
      // message under a box the user is actively fixing reads as the fix not
      // having worked.
      fieldErrors: s.fieldErrors.filter((e) => e.field !== field),
      formError: null,
    })),

  setSaving: (saving) => set({ saving }),
  setFieldErrors: (fieldErrors) => set({ fieldErrors, saving: false }),
  setFormError: (formError) => set({ formError, saving: false }),

  finishSave: (id, rev) =>
    set((s) => {
      const drafts = { ...s.drafts };
      delete drafts[id];
      return {
        editingId: null, drafts, saving: false,
        fieldErrors: [], formError: null, savedRev: rev,
      };
    }),

  clearSaved: () => set({ savedRev: null }),
}));

/** True when the given building has unsaved changes. */
export function useIsDirty(id: number | null): boolean {
  const drafts = useEditStore((s) => s.drafts);
  if (id === null) return false;
  const d = drafts[id];
  return Boolean(d && Object.keys(d).length > 0);
}

// ---------------------------------------------------------------------------
// Infrastructure sites.
//
// Two hooks, and the split between them IS the lazy loading. The index is a
// few hundred bytes and drives the navigator, so it is fetched once the
// project is known. A site's specification is the whole structure, so it is
// fetched only when that site becomes active -- and the layer builds geometry
// only from what these return, so a project with several sites costs one.
// ---------------------------------------------------------------------------

/**
 * The project's site index, fetched once.
 *
 * Returns an empty array rather than null on failure: a project with no sites
 * and a project whose index could not be read look the same to a navigator
 * that simply has nothing to list, and the alternative is a spinner that never
 * resolves on every project that has none.
 */
export function useSiteIndex(): SiteIndexEntry[] {
  const slug = useViewStore((s) => s.projectSlug);
  const sites = useDataStore((s) => s.sites);

  useEffect(() => {
    if (slug === null || sites !== null) return undefined;
    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/p/${slug}/sites`, { signal: abort.signal });
        if (!res.ok) {
          useDataStore.getState().setSites([]);
          return;
        }
        const doc = (await res.json()) as { sites?: SiteIndexEntry[] };
        useDataStore.getState().setSites(Array.isArray(doc.sites) ? doc.sites : []);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        useDataStore.getState().setSites([]);
      }
    })();
    return () => abort.abort();
  }, [slug, sites]);

  return sites ?? [];
}

/**
 * One site's specification, fetched on first use and cached.
 *
 * Mirrors useEnsureDetail: the pending guard is read imperatively rather than
 * subscribed to, so registering the fetch does not re-run the effect that
 * started it, and several components asking for the same site produce one
 * request. The AbortController matters for the same reason it does there --
 * clicking between sites faster than the network answers should not leave a
 * queue of specifications to parse.
 */
/**
 * Fetch the survey parcels once, the first time the 2D GIS view is opened.
 *
 * The same shape as useEnsureSite: an in-flight flag on the store so a
 * re-render cannot issue a second request, and an AbortController so leaving
 * the mode mid-flight does not settle into a store that has moved on.
 *
 * A FAILURE IS AN EMPTY COLLECTION, not a retry loop and not an error banner.
 * The endpoint already answers with an empty FeatureCollection for a project
 * seeded before this layer existed (lib/db.ts getSurveyParcels), so "no
 * parcels" is a real, expected state that the legend and the panel say out
 * loud. A transport failure lands in the same place, and pressing the toggle
 * again re-issues it, because the store still holds null.
 */
export function useEnsureSurveyParcels(
  enabled: boolean,
): GeoFC<SurveyParcelProps> | null {
  const fc = useDataStore((s) => s.surveyParcels);
  const slug = useViewStore((s) => s.projectSlug);

  useEffect(() => {
    if (!enabled || slug === null) return undefined;
    const st = useDataStore.getState();
    if (st.surveyParcels !== null || st.pendingSurveyParcels) return undefined;
    st.beginSurveyParcels();

    const abort = new AbortController();
    let settled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/p/${encodeURIComponent(slug)}/survey-parcels`,
          { signal: abort.signal },
        );
        const body = res.ok
          ? ((await res.json()) as GeoFC<SurveyParcelProps>)
          : null;
        settled = true;
        useDataStore.getState().setSurveyParcels(
          body && Array.isArray(body.features)
            ? body
            : { type: 'FeatureCollection', features: [] },
        );
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        settled = true;
        useDataStore.getState().setSurveyParcels(null);
      }
    })();
    return () => {
      abort.abort();
      // Clear the in-flight flag ONLY if this request never landed. Without
      // this, leaving the mode mid-fetch leaves `pendingSurveyParcels` true
      // with nothing to clear it, and the parcels never load again for the
      // life of the page -- a stuck flag looks exactly like a project that
      // has no parcels, which is the one wrong thing this layer can say.
      if (!settled) useDataStore.setState({ pendingSurveyParcels: false });
    };
  }, [enabled, slug]);

  return fc;
}

export function useEnsureSite(id: string | null): SiteSpec | null {
  const specs = useDataStore((s) => s.siteSpecs);
  const isCached = useDataStore((s) => id !== null && Boolean(s.siteSpecs[id]));
  const slug = useViewStore((s) => s.projectSlug);

  useEffect(() => {
    if (id === null || slug === null || isCached) return undefined;
    if (useDataStore.getState().pendingSites[id]) return undefined;
    useDataStore.getState().beginSite(id);

    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/p/${slug}/infra/${encodeURIComponent(id)}`, {
          signal: abort.signal,
        });
        if (!res.ok) {
          useDataStore.getState().endSite(id);
          return;
        }
        useDataStore.getState().putSiteSpec(id, (await res.json()) as SiteSpec);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        useDataStore.getState().endSite(id);
      }
    })();
    return () => {
      abort.abort();
      useDataStore.getState().endSite(id);
    };
  }, [id, slug, isCached]);

  return id === null ? null : specs[id] ?? null;
}

/** True while this site's specification is in flight. Drives the navigator. */
export function useSitePending(id: string | null): boolean {
  return useDataStore((s) => (id === null ? false : Boolean(s.pendingSites[id])));
}
