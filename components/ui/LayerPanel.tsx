'use client';

import { useEffect, useMemo } from 'react';
// The catalogue, not imagery.ts: this component is prerendered, and imagery.ts
// pulls in Cesium, which touches `window` at module scope.
import { availableProviders, TREATMENT_LABELS } from '@/lib/cesium/imagery-catalog';
import type { ProviderId, TreatmentId } from '@/lib/cesium/imagery-catalog';
import { useViewStore } from '@/lib/store';
import {
  SUN_MAX_HOUR, SUN_MIN_HOUR, SUN_NOON_HOUR, SUN_STEP_HOURS, formatSunHour,
} from '@/lib/sun';
import { BHUVAN_KINDS, BHUVAN_LABEL, BHUVAN_LAYER_KEY } from '@/lib/bhuvan';
import { HAZARD_LABEL, RISK_MEANING } from '@/lib/hazard';
import { RISK_HEX } from '@/lib/cesium/materials';
import { RISK_ORDER } from '@/lib/types';
import type { BuildingStyle, HazardKind, LayerKey, RiskClass, SliceState } from '@/lib/types';

/**
 * Left panel: layer visibility, explode, transparency, view mode, theme.
 *
 * A UI control, so it writes to the store. It never talks to Cesium directly --
 * the layers observe these flags and render accordingly.
 */

const BUILDING_STYLES: { id: BuildingStyle; label: string; title: string }[] = [
  {
    id: 'schematic',
    label: 'Schematic',
    title: 'Our own extrusions: textured by use type, one window band per '
      + 'storey, every height provenance-tagged.',
  },
  {
    id: 'photoreal',
    label: 'Photoreal',
    title: 'Google Photorealistic 3D Tiles. Captured imagery for orientation — '
      + 'it carries no rights data, and the cadastral geometry stays pickable '
      + 'underneath it.',
  },
];

const SLICE_AXES: { id: SliceState['axis']; label: string; title: string }[] = [
  {
    id: 'ew',
    label: 'E–W',
    title: 'Cut along a north–south line and look at the east–west section.',
  },
  {
    id: 'ns',
    label: 'N–S',
    title: 'Cut along an east–west line and look at the north–south section.',
  },
];

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'parcels', label: 'Surface parcels' },
  { key: 'buildings', label: 'Buildings' },
  { key: 'roads', label: 'Streets' },
  { key: 'floors', label: 'Floors & units' },
  { key: 'utilities', label: 'Underground utilities' },
  { key: 'terrain', label: 'DEM / terrain' },
  { key: 'basemap', label: 'Basemap' },
];

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-[3px] text-[12px] text-[rgb(var(--ink))]">
      <span
        onClick={onChange}
        className={[
          'grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border transition-colors',
          checked
            ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent))]'
            : 'border-[rgb(var(--edge))] bg-transparent',
        ].join(' ')}
      >
        {checked ? (
          <svg viewBox="0 0 10 10" className="h-2 w-2" aria-hidden>
            <path
              d="M1 5l2.5 2.5L9 2"
              fill="none"
              stroke="black"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      <span onClick={onChange}>{label}</span>
    </label>
  );
}

function Slider({
  label,
  value,
  onChange,
  suffix,
  disabled,
  min = 0,
  max = 100,
  step = 1,
  /** Overrides `value + suffix` where the read-out is not a plain number. */
  display,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
  display?: string;
}) {
  return (
    <div className={disabled ? 'is-disabled' : ''}>
      <div className="flex items-center justify-between">
        <span className="row-label">{label}</span>
        <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
          {display ?? `${value}${suffix}`}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full"
      />
    </div>
  );
}

export default function LayerPanel() {
  const layers = useViewStore((s) => s.layers);
  const toggleLayer = useViewStore((s) => s.toggleLayer);
  const sunHour = useViewStore((s) => s.sunHour);
  const setSunHour = useViewStore((s) => s.setSunHour);
  const explodeT = useViewStore((s) => s.explodeT);
  const setExplode = useViewStore((s) => s.setExplode);
  const transparency = useViewStore((s) => s.transparency);
  const setTransparency = useViewStore((s) => s.setTransparency);
  const viewMode = useViewStore((s) => s.viewMode);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const theme = useViewStore((s) => s.theme);
  const toggleTheme = useViewStore((s) => s.toggleTheme);
  const mode = useViewStore((s) => s.mode);
  const imageryProvider = useViewStore((s) => s.imageryProvider);
  const setImageryProvider = useViewStore((s) => s.setImageryProvider);
  const imageryTreatment = useViewStore((s) => s.imageryTreatment);
  const setImageryTreatment = useViewStore((s) => s.setImageryTreatment);
  const buildingStyle = useViewStore((s) => s.buildingStyle);
  const setBuildingStyle = useViewStore((s) => s.setBuildingStyle);
  const slice = useViewStore((s) => s.slice);
  const setSlice = useViewStore((s) => s.setSlice);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const canSlice = activeBuildingId !== null;
  // Only the overlays this project defines get a toggle; a project without a
  // bhuvan_layers block gets no group at all.
  const bhuvan = useViewStore((s) => s.project?.bhuvan_layers ?? null);
  // Which hazard the ground is grading, if any. Flood wins when both are on,
  // exactly as HazardRiskLayer resolves it.
  const hazard: HazardKind | null =
    layers.bhuvanFlood ? 'flood' : layers.bhuvanCyclone ? 'cyclone' : null;
  const contextRows = useMemo(
    () => BHUVAN_KINDS.filter((k) => bhuvan?.[k])
      .map((k) => ({ key: BHUVAN_LAYER_KEY[k], label: BHUVAN_LABEL[k] })),
    [bhuvan],
  );

  // Depends only on build-time env, so the list is stable for the session.
  const providers = useMemo(() => availableProviders(), []);

  const photoreal = buildingStyle === 'photoreal';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div data-panel="layers"
      className="glass pointer-events-auto w-full rounded-lg p-3">
      <div className="panel-title">Layers</div>
      <div className="mt-1.5">
        {LAYERS.map((l) => (
          <Check
            key={l.key}
            label={l.label}
            checked={layers[l.key]}
            onChange={() => toggleLayer(l.key)}
          />
        ))}
      </div>

      {/* ISRO Bhuvan WMS context overlays, drawn over the basemap. Only the
          toggles the current project defines; nothing for a project without
          a bhuvan_layers block. Disabled under Photoreal, where the globe
          surface is hidden and there is nothing for an overlay to sit on. */}
      {contextRows.length > 0 ? (
        <div className="mt-3 border-t border-[rgb(var(--edge))]/50 pt-2.5">
          <div
            className={photoreal ? 'is-disabled' : ''}
            title={photoreal ? 'Google 3D Tiles hide the globe surface' : undefined}
          >
            <span className="row-label">Context (ISRO)</span>
            <div className="mt-1">
              {contextRows.map((r) => (
                <Check
                  key={r.key}
                  label={r.label}
                  checked={layers[r.key]}
                  onChange={() => toggleLayer(r.key)}
                />
              ))}
            </div>
            {/* The key sits HERE, beside the switch that turns the ramp on,
                rather than only in the Legend: the left column scrolls, the
                Legend is below the fold on a laptop, and a four-class ramp
                the reader cannot decode is a code with no key. The Legend
                keeps the fuller version with the drivers and the caveat. */}
            {hazard ? (
              <div className="mt-2 border-t border-[rgb(var(--edge))]/40 pt-2">
                <span className="row-label">{HAZARD_LABEL[hazard]} (derived)</span>
                <div className="mt-1 space-y-[3px]">
                  {[...RISK_ORDER].reverse().map((cls: RiskClass) => (
                    <div key={cls} className="flex items-center gap-1.5">
                      {/* Inline colour: the chrome audit reads computed styles
                          and exempts inline ones, which is what lets a key be
                          coloured inside a monochrome panel. */}
                      <span
                        className="h-2 w-3 shrink-0 rounded-sm ring-1 ring-[rgb(var(--edge-strong))]"
                        style={{ background: RISK_HEX[cls] }}
                      />
                      <span className="w-14 shrink-0 text-[10px] capitalize text-[rgb(var(--ink))]">
                        {cls}
                      </span>
                      <span className="flex-1 truncate text-[9px] text-[rgb(var(--muted))]">
                        {RISK_MEANING[hazard][cls]}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">
                  Graded from CartoDEM, relative within this AOI. The Bhuvan
                  zone underneath is national and covers it in one class.
                </p>
              </div>
            ) : (
              <p className="mt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">
                Bhuvan WMS overlays, © NRSC/ISRO. Off by default.
              </p>
            )}
          </div>
        </div>
      ) : null}

      {/* How buildings are drawn. Sits under the Buildings checkbox, which
          stays the on/off switch for whichever style is selected here. */}
      <div className="mt-3 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <div className={layers.buildings ? '' : 'is-disabled'}>
          <span className="row-label">Buildings</span>
          <div
            className="mt-1 grid grid-cols-2 gap-1"
            role="radiogroup"
            aria-label="Building style"
          >
            {BUILDING_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={buildingStyle === s.id}
                title={s.title}
                onClick={() => setBuildingStyle(s.id)}
                className={[
                  'rounded py-1 text-[11px] transition-colors',
                  buildingStyle === s.id
                    ? 'is-active'
                    : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
                ].join(' ')}
              >
                {s.label}
              </button>
            ))}
          </div>
          {photoreal ? (
            <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
              Captured mesh — no rights data. Cadastral geometry stays
              selectable underneath.
            </p>
          ) : null}
        </div>
      </div>

      {/* Basemap source and tone. Sits directly under the Basemap checkbox,
          which stays the on/off switch for whatever is selected here. */}
      <div className="mt-3 space-y-2.5 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        {/* Photoreal tiles carry their own imagery and hide the globe surface,
            so the basemap underneath them is not on screen to be chosen. */}
        <div
          className={layers.basemap && !photoreal ? '' : 'is-disabled'}
          title={photoreal ? 'Google 3D Tiles supply their own imagery' : undefined}
        >
          <span className="row-label">Imagery</span>
          <select
            value={imageryProvider}
            onChange={(e) => setImageryProvider(e.target.value as ProviderId)}
            className="mt-1 w-full rounded border border-[rgb(var(--edge))] bg-[rgb(var(--panel))] px-1.5 py-1 text-[11px] text-[rgb(var(--ink))] outline-none focus:border-[rgb(var(--accent))]"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="row-label">Tone</span>
          {/* A segmented row rather than radio inputs: it is the house idiom
              for a mutually-exclusive choice (see View below, and NavDock).
              Marked up as a radiogroup so it still reads as one. */}
          <div className="mt-1 grid grid-cols-2 gap-1" role="radiogroup" aria-label="Tone">
            {(['natural', 'gisDark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={imageryTreatment === t}
                onClick={() => setImageryTreatment(t as TreatmentId)}
                className={[
                  'rounded py-1 text-[11px] transition-colors',
                  imageryTreatment === t
                    ? 'is-active'
                    : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
                ].join(' ')}
              >
                {TREATMENT_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* --- sun ---------------------------------------------------------- */}
      <div className="mt-3 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <Slider
          label="Sun"
          value={sunHour ?? SUN_NOON_HOUR}
          onChange={setSunHour}
          suffix=""
          min={SUN_MIN_HOUR}
          max={SUN_MAX_HOUR}
          step={SUN_STEP_HOURS}
          display={sunHour === null ? 'off' : formatSunHour(sunHour)}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          {/* The slider's off position is the only way back to the unlit,
              shadowless scene -- it is the cheap path, not the default. */}
          <span className="text-[9px] leading-snug text-[rgb(var(--muted))]">
            {sunHour === null
              ? 'Lighting and shadows off'
              : 'Shadows on · buildings only'}
          </span>
          <button
            type="button"
            onClick={() => setSunHour(SUN_NOON_HOUR)}
            className="shrink-0 rounded bg-[rgb(var(--tint)/0.06)] px-2 py-0.5 text-[10px] text-[rgb(var(--ink))] transition-colors tint-hover"
          >
            Noon
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-2.5 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <Slider
          label="Explode"
          value={explodeT}
          onChange={setExplode}
          suffix="%"
          disabled={mode === 'city'}
        />
        {/* Both sliders act on schematic geometry only -- they never touch the
            Google tileset. Explode still bites in Photoreal because the floor
            stack renders above the tiles; transparency does not, because the
            extrusions it fades are already ghosted to alpha 0.01 for picking. */}
        <Slider
          label="Transparency"
          value={transparency}
          onChange={setTransparency}
          suffix="%"
          disabled={photoreal}
        />
      </div>

      {/* --- section cut --------------------------------------------------
          Sits with Explode because the two are mutually exclusive: the store
          switches whichever one is on off when the other is reached for, so
          the control never has to disable its neighbour. Cutting needs a
          building to cut, hence the city-mode gate. */}
      <div className="mt-3 space-y-2 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <div className={canSlice ? '' : 'is-disabled'}>
          <div className="flex items-center justify-between">
            <span className="row-label">Slice</span>
            <button
              type="button"
              role="switch"
              aria-checked={slice.enabled}
              aria-label="Slice"
              disabled={!canSlice}
              onClick={() => setSlice({ enabled: !slice.enabled })}
              className={[
                'rounded px-2 py-0.5 text-[10px] transition-colors',
                slice.enabled
                  ? 'is-active'
                  : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
              ].join(' ')}
            >
              {slice.enabled ? 'on' : 'off'}
            </button>
          </div>
          <div
            className="mt-1 grid grid-cols-2 gap-1"
            role="radiogroup"
            aria-label="Slice axis"
          >
            {SLICE_AXES.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={slice.axis === a.id}
                disabled={!canSlice}
                title={a.title}
                onClick={() => setSlice({ axis: a.id, enabled: true })}
                className={[
                  'rounded py-1 text-[11px] transition-colors',
                  slice.axis === a.id
                    ? 'is-active'
                    : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
                ].join(' ')}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <Slider
          label="Slice position"
          value={slice.offset}
          onChange={(v) => setSlice({ offset: v })}
          suffix="%"
          min={-100}
          max={100}
          disabled={!canSlice || !slice.enabled}
        />
        <p className="text-[9px] leading-snug text-[rgb(var(--muted))]">
          {slice.enabled
            ? 'Cuts floor plates, height shells and every flat on them.'
            : 'Section the active building. Turns Explode off.'}
        </p>
      </div>

      <div className="mt-3 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <span className="row-label">View</span>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {(['3D', '2D', 'Split'] as const).map((v) => {
            // Split view is out of scope for this build and is shown disabled
            // rather than hidden, so its absence is explicit.
            const disabled = v === 'Split';
            return (
              <button
                key={v}
                type="button"
                disabled={disabled}
                title={disabled ? 'Split view — not implemented' : undefined}
                onClick={() => setViewMode(v)}
                className={[
                  'rounded py-1 text-[11px] transition-colors',
                  disabled ? 'is-disabled bg-[rgb(var(--tint)/0.06)]' : '',
                  viewMode === v && !disabled
                    ? 'is-active'
                    : 'bg-[rgb(var(--tint)/0.06)] text-[rgb(var(--ink))] tint-hover',
                ].join(' ')}
              >
                {v}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={toggleTheme}
        className="mt-3 w-full rounded bg-[rgb(var(--tint)/0.06)] py-1 text-[11px] text-[rgb(var(--ink))] tint-hover"
      >
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
    </div>
  );
}
