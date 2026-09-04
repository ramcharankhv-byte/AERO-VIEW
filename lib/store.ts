'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import type { ProviderId, TreatmentId } from './cesium/imagery-catalog';
import { SUN_DEFAULT_HOUR, SUN_MAX_HOUR, SUN_MIN_HOUR } from './sun';
import type { BuildingEdit, FieldError } from './data/building-schema';
import type {
  BuildingDetail, BuildingStyle, ConflictRow, EnrichedBuilding, GeoFC, LayerKey,
  Mode, ParcelInfo, RoadProps, SliceState, UtilityProps,
} from './types';

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

  mode: Mode;
  activeBuildingId: number | null;
  isolatedFloor: number | null;      // level_no, not floor id
  selectedUnitId: number | null;
  selectedUtilityId: number | null;
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
  setViewMode: (m: '3D' | '2D' | 'Split') => void;
  setAutoSpin: (on: boolean) => void;
  setNavMode: (m: 'orbit' | 'pan' | 'zoom') => void;
  setIonFallback: (on: boolean) => void;
  setImageryProvider: (id: ProviderId) => void;
  setImageryTreatment: (t: TreatmentId) => void;
  setImageryActive: (id: ProviderId) => void;
  setBuildingStyle: (s: BuildingStyle) => void;
  /** Report a Google-tiles failure and fall back to Schematic in one write. */
  failPhotoreal: (message: string) => void;
  dismissPhotorealError: () => void;
  setStatsOpen: (on: boolean) => void;
  setSunHour: (h: number | null) => void;
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
};

export const useViewStore = create<ViewState>((set) => ({
  projectSlug: null,
  mode: 'city',
  activeBuildingId: null,
  isolatedFloor: null,
  selectedUnitId: null,
  selectedUtilityId: null,
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
  viewMode: '3D',
  autoSpin: false,
  navMode: 'orbit',
  ionFallback: false,
  imageryProvider: 'esri',
  imageryTreatment: 'gisDark',
  imageryActive: 'esri',
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
        : { mode: 'building', activeBuildingId: id, isolatedFloor: null,
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

  selectUtility: (id) => set({ selectedUtilityId: id, selectedRoadId: null }),
  selectRoad: (id) => set({ selectedRoadId: id, selectedUtilityId: null }),
  clearAmbient: () => set({ selectedRoadId: null, selectedUtilityId: null }),
  setHovered: (id) => set({ hoveredBuildingId: id }),
  setHover: (buildingId, unitId, roadId) =>
    set({ hoveredBuildingId: buildingId, hoveredUnitId: unitId,
          hoveredRoadId: roadId }),

  toggleLayer: (key) =>
    set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),

  // Explode and slice are mutually exclusive, and the exclusion is enforced
  // here rather than in the two controls: whichever one the user reaches for
  // wins, and no component has to remember to switch the other off.
  setExplode: (t) =>
    set((s) => {
      const explodeT = Math.max(0, Math.min(100, t));
      return explodeT > 0 && s.slice.enabled
        ? { explodeT, slice: { ...s.slice, enabled: false } }
        : { explodeT };
    }),

  setSlice: (patch) =>
    set((s) => {
      const slice = { ...s.slice, ...patch };
      slice.offset = Math.max(-100, Math.min(100, slice.offset));
      return slice.enabled ? { slice, explodeT: 0 } : { slice };
    }),

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

  setViewMode: (m) => set({ viewMode: m }),
  setAutoSpin: (on) => set({ autoSpin: on }),
  setNavMode: (m) => set({ navMode: m }),
  setIonFallback: (on) => set({ ionFallback: on }),
  setImageryProvider: (id) => set({ imageryProvider: id }),
  setImageryTreatment: (t) => set({ imageryTreatment: t }),
  setImageryActive: (id) => set({ imageryActive: id }),

  // Switching style by hand clears any previous failure, so retrying Photoreal
  // after a transient network blip is just clicking the toggle again.
  setBuildingStyle: (s) => set({ buildingStyle: s, photorealError: null }),
  failPhotoreal: (message) =>
    set({ buildingStyle: 'schematic', photorealError: message }),
  dismissPhotorealError: () => set({ photorealError: null }),

  setStatsOpen: (on) => set({ statsOpen: on }),
  setSunHour: (h) =>
    set({ sunHour: h === null ? null : Math.max(SUN_MIN_HOUR, Math.min(SUN_MAX_HOUR, h)) }),

  hydrate: (patch) => set(patch),

  resetView: () =>
    set((s) => ({
      mode: 'city', activeBuildingId: null, isolatedFloor: null,
      selectedUnitId: null, selectedUtilityId: null, selectedRoadId: null,
      hoveredBuildingId: null, hoveredRoadId: null,
      hoveredUnitId: null, explodeT: 0, underground: false, autoSpin: false,
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
  utilities: GeoFC<UtilityProps> | null;
  roads: GeoFC<RoadProps> | null;
  conflicts: ConflictRow[];
  detail: Record<number, BuildingDetail>;
  /**
   * Building ids whose detail fetch is in flight.
   *
   * `detail[id]` being absent cannot distinguish "still loading" from "failed",
   * and the DetailPanel needs that distinction to decide between a skeleton and
   * the em-dash fallback. It also dedupes: five components call useEnsureDetail
   * with the same id, and without this each one fetched the same document.
   */
  pendingDetail: Record<number, true>;
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
  setUtilities: (fc: GeoFC<UtilityProps>) => void;
  setRoads: (fc: GeoFC<RoadProps>) => void;
  setConflicts: (rows: ConflictRow[]) => void;
  putDetail: (id: number, d: BuildingDetail) => void;
  /**
   * Replace ONE building's properties in the loaded collection.
   *
   * Produces a new `buildings` object identity, which every subscriber sees.
   * That is why `buildingsEpoch` exists beside it -- see below.
   */
  patchBuilding: (id: number, props: Partial<EnrichedBuilding>) => void;
  beginDetail: (id: number) => void;
  endDetail: (id: number) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

export const useDataStore = create<DataState>((set) => ({
  buildings: null,
  parcels: null,
  utilities: null,
  roads: null,
  conflicts: [],
  detail: {},
  pendingDetail: {},
  loading: false,
  error: null,
  buildingsEpoch: 0,

  setBuildings: (fc) =>
    set((st) => ({ buildings: fc, buildingsEpoch: st.buildingsEpoch + 1 })),
  setParcels: (fc) => set({ parcels: fc }),
  setUtilities: (fc) => set({ utilities: fc }),
  setRoads: (fc) => set({ roads: fc }),
  setConflicts: (rows) => set({ conflicts: rows }),
  putDetail: (id, d) => set((s) => ({ detail: { ...s.detail, [id]: d } })),

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
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e }),
}));

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

  useEffect(() => {
    if (id === null || detail[id]) return;
    // pendingDetail is read imperatively rather than subscribed to: making it a
    // dependency would re-run this effect the moment the fetch is registered.
    // Five components call this hook with the same id, so the guard is what
    // turns five identical requests into one.
    if (useDataStore.getState().pendingDetail[id]) return;
    useDataStore.getState().beginDetail(id);
    (async () => {
      try {
        const res = await fetch(`/api/building/${id}`);
        if (!res.ok) return;
        const doc = (await res.json()) as BuildingDetail;
        // No cancellation guard: the result lands in a shared cache, not in
        // component state, so a caller unmounting mid-flight is not a reason to
        // throw the document away.
        useDataStore.getState().putDetail(id, doc);
      } catch {
        /* transient; the layer simply renders nothing until it succeeds */
      } finally {
        useDataStore.getState().endDetail(id);
      }
    })();
  }, [id, detail]);

  return id === null ? null : detail[id] ?? null;
}

/** True while `/api/building/:id` is in flight. Distinct from "failed". */
export function useDetailPending(id: number | null): boolean {
  const pending = useDataStore((s) => s.pendingDetail);
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
