'use client';

import { useEffect } from 'react';
import { useViewStore } from '@/lib/store';
import type { LayerKey } from '@/lib/types';

/**
 * Left panel: layer visibility, explode, transparency, view mode, theme.
 *
 * A UI control, so it writes to the store. It never talks to Cesium directly --
 * the layers observe these flags and render accordingly.
 */

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="glass pointer-events-auto w-[210px] rounded-lg p-3">
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

      <div className="mt-3 space-y-2.5 border-t border-[rgb(var(--edge))]/50 pt-2.5">
        <Slider
          label="Explode"
          value={explodeT}
          onChange={setExplode}
          suffix="%"
          disabled={mode === 'city'}
        />
        <Slider
          label="Transparency"
          value={transparency}
          onChange={setTransparency}
          suffix="%"
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
