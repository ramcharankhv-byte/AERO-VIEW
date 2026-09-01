'use client';

/**
 * View state <-> URL query string.
 *
 * The scene is a single page with no navigation, so the address bar was doing
 * nothing: a reload dropped the selection, the layer set, the basemap and the
 * building style on the floor, and there was no way to send someone a view.
 * This module makes the URL the shareable record of that state.
 *
 * Two rules keep it honest:
 *
 *   - Only DELIBERATE state is serialised. Hover, the eased fade value, the
 *     ion/photoreal fallback flags and everything in the data store are
 *     derived or transient and stay out.
 *   - Defaults are omitted. A URL only carries what the user changed, so the
 *     bare path stays bare and a shared link reads as a diff from the default
 *     view rather than as a wall of parameters.
 *
 * `mode` is not a parameter: it is implied by which of unit/floor/building is
 * present, exactly as the store's own selection cascade implies it.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useViewStore, type ViewState } from './store';
import type { BuildingStyle, LayerKey } from './types';
import type { ProviderId, TreatmentId } from './cesium/imagery-catalog';
import { PROVIDER_LABELS, TREATMENT_LABELS } from './cesium/imagery-catalog';

/** Layer keys in a fixed order, so the `layers` param is stable and diffable. */
const LAYER_ORDER: LayerKey[] = [
  'parcels', 'buildings', 'floors', 'utilities', 'terrain', 'basemap',
];

/** Short codes; layers=pbf is legible in a way layers=parcels,buildings is not. */
const LAYER_CODE: Record<LayerKey, string> = {
  parcels: 'p', buildings: 'b', floors: 'f',
  utilities: 'u', terrain: 't', basemap: 'm',
};

const DEFAULT_LAYERS: Record<LayerKey, boolean> = {
  parcels: false, buildings: true, floors: true,
  utilities: false, terrain: true, basemap: true,
};

const DEFAULTS = {
  explodeT: 0,
  transparency: 12,
  theme: 'dark' as const,
  underground: false,
  imageryProvider: 'esri' as ProviderId,
  imageryTreatment: 'gisDark' as TreatmentId,
  buildingStyle: 'schematic' as BuildingStyle,
};

const STYLES: string[] = ['schematic', 'photoreal'];

function encodeLayers(layers: Record<LayerKey, boolean>): string {
  return LAYER_ORDER.filter((k) => layers[k]).map((k) => LAYER_CODE[k]).join('');
}

function decodeLayers(raw: string): Record<LayerKey, boolean> {
  const out = {} as Record<LayerKey, boolean>;
  for (const k of LAYER_ORDER) out[k] = raw.includes(LAYER_CODE[k]);
  return out;
}

/** A finite integer clamped to [min,max], or null if absent or junk. */
function intParam(v: string | null, min: number, max: number): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function idParam(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The serialisable slice of the view store. */
export type UrlState = Pick<
  ViewState,
  'activeBuildingId' | 'isolatedFloor' | 'selectedUnitId' | 'selectedUtilityId'
  | 'layers' | 'explodeT' | 'transparency' | 'theme' | 'underground'
  | 'imageryProvider' | 'imageryTreatment' | 'buildingStyle'
>;

/** Serialise to a query string (no leading '?'). Defaults are omitted. */
export function serialise(s: UrlState): string {
  const q = new URLSearchParams();

  if (s.activeBuildingId !== null) q.set('b', String(s.activeBuildingId));
  if (s.isolatedFloor !== null) q.set('f', String(s.isolatedFloor));
  if (s.selectedUnitId !== null) q.set('unit', String(s.selectedUnitId));
  if (s.selectedUtilityId !== null) q.set('util', String(s.selectedUtilityId));

  if (s.buildingStyle !== DEFAULTS.buildingStyle) q.set('style', s.buildingStyle);
  if (s.imageryProvider !== DEFAULTS.imageryProvider) q.set('img', s.imageryProvider);
  if (s.imageryTreatment !== DEFAULTS.imageryTreatment) q.set('tone', s.imageryTreatment);

  const layers = encodeLayers(s.layers);
  // '-' rather than '' for "every layer off": an empty value would round-trip
  // as an absent param and silently restore the defaults instead.
  if (layers !== encodeLayers(DEFAULT_LAYERS)) q.set('layers', layers || '-');

  if (s.explodeT !== DEFAULTS.explodeT) q.set('x', String(Math.round(s.explodeT)));
  if (s.transparency !== DEFAULTS.transparency) q.set('t', String(Math.round(s.transparency)));
  if (s.underground !== DEFAULTS.underground) q.set('ug', s.underground ? '1' : '0');
  if (s.theme !== DEFAULTS.theme) q.set('theme', s.theme);

  return q.toString();
}

/**
 * Parse a query string into a store patch.
 *
 * Unknown or malformed values are dropped rather than defaulted loudly: a
 * hand-edited or truncated link should still open the view it can, not a blank
 * scene or an exception. Enum params are checked against the label maps, so a
 * URL can never put the store into a state its own control cannot represent.
 */
export function parse(search: string): Partial<ViewState> {
  const q = new URLSearchParams(search);
  const patch: Partial<ViewState> = {};

  const b = idParam(q.get('b'));
  const f = intParam(q.get('f'), -20, 200);
  const unit = idParam(q.get('unit'));
  const util = idParam(q.get('util'));

  if (b !== null) patch.activeBuildingId = b;
  if (f !== null) patch.isolatedFloor = f;
  if (unit !== null) patch.selectedUnitId = unit;
  if (util !== null) patch.selectedUtilityId = util;

  // The store never holds a mode inconsistent with its selection, so neither
  // may a URL. Deepest present selection wins, matching selectUnit/isolateFloor.
  if (unit !== null) patch.mode = 'unit';
  else if (f !== null) patch.mode = 'floor';
  else if (b !== null) patch.mode = 'building';

  const style = q.get('style');
  if (style && STYLES.includes(style)) patch.buildingStyle = style as BuildingStyle;

  const img = q.get('img');
  if (img && img in PROVIDER_LABELS) patch.imageryProvider = img as ProviderId;

  const tone = q.get('tone');
  if (tone && tone in TREATMENT_LABELS) patch.imageryTreatment = tone as TreatmentId;

  const layers = q.get('layers');
  if (layers !== null) patch.layers = decodeLayers(layers);

  const x = intParam(q.get('x'), 0, 100);
  if (x !== null) patch.explodeT = x;

  const t = intParam(q.get('t'), 0, 100);
  if (t !== null) patch.transparency = t;

  const ug = q.get('ug');
  if (ug === '1' || ug === '0') patch.underground = ug === '1';

  const theme = q.get('theme');
  if (theme === 'dark' || theme === 'light') patch.theme = theme;

  return patch;
}

/**
 * Hydrate from the URL on mount, then keep the URL in step with the store.
 *
 * Writes use replaceState, not pushState: dragging the transparency slider
 * must not bury the back button under a hundred history entries. The URL is a
 * live bookmark of the current view, not a trail of how it was reached.
 */
export function useUrlState(): void {
  const hydrated = useRef(false);

  /**
   * Hydrate in a layout effect, not during render: writing to an external
   * store mid-render makes React warn about updating one component while
   * rendering another, and it is the caller's own subscribers that get hit.
   *
   * This is still early enough. The caller (CesiumRoot) gates its children on
   * `ready`, which only flips after the viewer and the cadastre have loaded,
   * so no layer and above all no CameraDirector has mounted yet -- the restored
   * selection is the first one they ever see, not a jump they animate to.
   */
  useLayoutEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const patch = parse(window.location.search);
    if (Object.keys(patch).length > 0) useViewStore.getState().hydrate(patch);
  }, []);

  useEffect(() => {
    let frame = 0;

    const write = () => {
      frame = 0;
      const qs = serialise(useViewStore.getState());
      const next = window.location.pathname
        + (qs ? '?' + qs : '')
        + window.location.hash;
      const current = window.location.pathname
        + window.location.search
        + window.location.hash;
      if (next !== current) window.history.replaceState(null, '', next);
    };

    // Coalesce to one write per frame: a slider drag emits a store update per
    // pointermove, and replaceState is not free.
    const unsub = useViewStore.subscribe(() => {
      if (frame === 0) frame = requestAnimationFrame(write);
    });

    write();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      unsub();
    };
  }, []);
}
