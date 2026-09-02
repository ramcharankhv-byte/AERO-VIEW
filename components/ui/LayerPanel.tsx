'use client';

import { useEffect, useMemo } from 'react';
// The catalogue, not imagery.ts: this component is prerendered, and imagery.ts
// pulls in Cesium, which touches `window` at module scope.
import { availableProviders, TREATMENT_LABELS } from '@/lib/cesium/imagery-catalog';
import type { ProviderId, TreatmentId } from '@/lib/cesium/imagery-catalog';
import { useViewStore } from '@/lib/store';
import type { BuildingStyle, LayerKey } from '@/lib/types';

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

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'parcels', label: 'Surface parcels' },
  { key: 'buildings', label: 'Buildings' },
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
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix: string;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? 'is-disabled' : ''}>
      <div className="flex items-center justify-between">
        <span className="row-label">{label}</span>
        <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
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

  // Depends only on build-time env, so the list is stable for the session.
  const providers = useMemo(() => availableProviders(), []);

  const photoreal = buildingStyle === 'photoreal';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="glass pointer-events-auto max-h-[calc(100vh-96px)] w-[210px] overflow-y-auto rounded-lg p-3">
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
                    ? 'bg-[rgb(var(--accent))] text-black'
                    : 'bg-white/5 text-[rgb(var(--ink))] hover:bg-white/15',
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
                    ? 'bg-[rgb(var(--accent))] text-black'
                    : 'bg-white/5 text-[rgb(var(--ink))] hover:bg-white/15',
                ].join(' ')}
              >
                {TREATMENT_LABELS[t]}
              </button>
            ))}
          </div>
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
                  disabled ? 'is-disabled bg-white/5' : '',
                  viewMode === v && !disabled
                    ? 'bg-[rgb(var(--accent))] text-black'
                    : 'bg-white/5 text-[rgb(var(--ink))] hover:bg-white/15',
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
        className="mt-3 w-full rounded bg-white/5 py-1 text-[11px] text-[rgb(var(--ink))] hover:bg-white/15"
      >
        {theme === 'dark' ? 'Light theme' : 'Dark theme'}
      </button>
    </div>
  );
}
