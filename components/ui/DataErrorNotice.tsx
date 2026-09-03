'use client';

import { useState } from 'react';
import { useDataStore } from '@/lib/store';
import { fetchInitialData } from '@/lib/cesium/setup';

/**
 * The boot-fetch failure state.
 *
 * `DataState.error` has existed since the beginning and was written on every
 * failed boot, but nothing ever read it: a network failure produced an empty
 * globe, a permanently-spinning-looking scene and no explanation at all. This
 * is the surface that makes that state legible, and it offers the one action
 * that can actually resolve it.
 *
 * Retry re-runs the same fetch the boot path uses rather than reloading the
 * page: the Cesium viewer, the terrain provider and the sampled ground heights
 * are all still valid, and tearing the scene down to recover from a failed
 * JSON request would be a much heavier answer than the problem deserves.
 */
export default function DataErrorNotice() {
  const error = useDataStore((s) => s.error);
  const [retrying, setRetrying] = useState(false);

  if (!error) return null;

  const retry = async () => {
    setRetrying(true);
    const store = useDataStore.getState();
    store.setLoading(true);
    try {
      const data = await fetchInitialData();
      store.setBuildings(data.buildings);
      store.setParcels(data.parcels);
      store.setUtilities(data.utilities);
      store.setRoads(data.roads);
      store.setConflicts(data.conflicts);
      store.setError(null);
    } catch (err) {
      store.setError(String(err));
    } finally {
      store.setLoading(false);
      setRetrying(false);
    }
  };

  return (
    <div
      data-panel="data-error"
      role="alert"
      className="glass pointer-events-auto w-full max-w-[330px] rounded-lg border-danger/60 px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <span className="mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-dangerInk">
            Cadastre could not be loaded
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-[rgb(var(--muted))]">
            The scene is showing terrain and imagery only — no footprints,
            parcels, streets or utilities.
          </p>
          {/* The raw reason, truncated. A user reporting this needs something
              specific to quote, and hiding it behind a console message helps
              nobody. */}
          <p className="mt-1 break-words font-mono text-[9px] leading-snug text-[rgb(var(--muted-2))]">
            {error.slice(0, 160)}
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            className={[
              'mt-1.5 rounded px-2 py-0.5 text-[11px] transition-colors',
              retrying
                ? 'is-disabled text-[rgb(var(--muted))]'
                : 'border border-[rgb(var(--edge-strong))] text-[rgb(var(--ink))] tint-hover',
            ].join(' ')}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}
