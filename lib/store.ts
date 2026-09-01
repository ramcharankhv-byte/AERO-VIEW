'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  BuildingDetail, BuildingProps, ConflictRow, GeoFC, LayerKey, Mode,
  ParcelInfo, UtilityProps,
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
  mode: Mode;
  activeBuildingId: number | null;
  isolatedFloor: number | null;      // level_no, not floor id
  selectedUnitId: number | null;
  selectedUtilityId: number | null;
  hoveredBuildingId: number | null;
  layers: Record<LayerKey, boolean>;
  explodeT: number;                  // 0-100
  transparency: number;              // 0-100, applies to non-active buildings
  theme: 'dark' | 'light';
  underground: boolean;
  viewMode: '3D' | '2D' | 'Split';
  autoSpin: boolean;
  navMode: 'orbit' | 'pan' | 'zoom';
  /** Set when the scene falls back to OSM imagery because no ion token exists. */
  ionFallback: boolean;

  selectBuilding: (id: number | null) => void;
  isolateFloor: (level: number | null) => void;
  selectUnit: (id: number | null) => void;
  selectUtility: (id: number | null) => void;
  setHovered: (id: number | null) => void;
  toggleLayer: (key: LayerKey) => void;
  setExplode: (t: number) => void;
  setTransparency: (t: number) => void;
  toggleTheme: () => void;
  setUnderground: (on: boolean) => void;
  setViewMode: (m: '3D' | '2D' | 'Split') => void;
  setAutoSpin: (on: boolean) => void;
  setNavMode: (m: 'orbit' | 'pan' | 'zoom') => void;
  setIonFallback: (on: boolean) => void;
  resetView: () => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  parcels: false,
  buildings: true,
  floors: true,
  utilities: false,
  terrain: true,
  basemap: true,
};

export const useViewStore = create<ViewState>((set) => ({
  mode: 'city',
  activeBuildingId: null,
  isolatedFloor: null,
  selectedUnitId: null,
  selectedUtilityId: null,
  hoveredBuildingId: null,
  layers: { ...DEFAULT_LAYERS },
  explodeT: 0,
  transparency: 12,
  theme: 'dark',
  underground: false,
  viewMode: '3D',
  autoSpin: false,
  navMode: 'orbit',
  ionFallback: false,

  selectBuilding: (id) =>
    set(() =>
      id === null
        ? { mode: 'city', activeBuildingId: null, isolatedFloor: null,
            selectedUnitId: null, selectedUtilityId: null, explodeT: 0 }
        : { mode: 'building', activeBuildingId: id, isolatedFloor: null,
            selectedUnitId: null, selectedUtilityId: null }),

  isolateFloor: (level) =>
    set((s) =>
      level === null
        ? { mode: s.activeBuildingId ? 'building' : 'city', isolatedFloor: null,
            selectedUnitId: null }
        : { mode: 'floor', isolatedFloor: level, selectedUnitId: null }),

  selectUnit: (id) =>
    set((s) =>
      id === null
        ? { mode: s.isolatedFloor !== null ? 'floor' : 'building', selectedUnitId: null }
        : { mode: 'unit', selectedUnitId: id, selectedUtilityId: null }),

  selectUtility: (id) => set({ selectedUtilityId: id }),
  setHovered: (id) => set({ hoveredBuildingId: id }),

  toggleLayer: (key) =>
    set((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } })),

  setExplode: (t) => set({ explodeT: Math.max(0, Math.min(100, t)) }),
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

  resetView: () =>
    set({
      mode: 'city', activeBuildingId: null, isolatedFloor: null,
      selectedUnitId: null, selectedUtilityId: null, hoveredBuildingId: null,
      explodeT: 0, underground: false, autoSpin: false,
    }),
}));

/**
 * Fetched cadastral data, kept apart from view state so that a re-render caused
 * by (say) moving the explode slider never invalidates the data cache.
 */
export interface DataState {
  buildings: GeoFC<BuildingProps> | null;
  parcels: GeoFC<ParcelInfo> | null;
  utilities: GeoFC<UtilityProps> | null;
  conflicts: ConflictRow[];
  detail: Record<number, BuildingDetail>;
  loading: boolean;
  error: string | null;

  setBuildings: (fc: GeoFC<BuildingProps>) => void;
  setParcels: (fc: GeoFC<ParcelInfo>) => void;
  setUtilities: (fc: GeoFC<UtilityProps>) => void;
  setConflicts: (rows: ConflictRow[]) => void;
  putDetail: (id: number, d: BuildingDetail) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

export const useDataStore = create<DataState>((set) => ({
  buildings: null,
  parcels: null,
  utilities: null,
  conflicts: [],
  detail: {},
  loading: false,
  error: null,

  setBuildings: (fc) => set({ buildings: fc }),
  setParcels: (fc) => set({ parcels: fc }),
  setUtilities: (fc) => set({ utilities: fc }),
  setConflicts: (rows) => set({ conflicts: rows }),
  putDetail: (id, d) => set((s) => ({ detail: { ...s.detail, [id]: d } })),
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e }),
}));

/** Utility helper: the detail record for the active building, if loaded. */
export function useActiveDetail(): BuildingDetail | null {
  const id = useViewStore((s) => s.activeBuildingId);
  const detail = useDataStore((s) => s.detail);
  return id === null ? null : detail[id] ?? null;
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
  const putDetail = useDataStore((s) => s.putDetail);

  useEffect(() => {
    if (id === null || detail[id]) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/building/${id}`);
        if (!res.ok) return;
        const doc = (await res.json()) as BuildingDetail;
        if (!cancelled) putDetail(id, doc);
      } catch {
        /* transient; the layer simply renders nothing until it succeeds */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, detail, putDetail]);

  return id === null ? null : detail[id] ?? null;
}
