'use client';

import { useState } from 'react';
import { useViewStore } from '@/lib/store';

/**
 * Dismissible notice shown when no Cesium ion token is configured.
 *
 * The app still works -- it falls back to OSM raster imagery on an ellipsoid --
 * but satellite imagery and World Terrain are genuinely absent, and silently
 * showing a flat grey globe would look like a bug rather than a missing key.
 */
export default function IonNotice() {
  const ionFallback = useViewStore((s) => s.ionFallback);
  const [dismissed, setDismissed] = useState(false);

  if (!ionFallback || dismissed) return null;

  return (
    <div className="glass pointer-events-auto max-w-[330px] rounded-lg border-amber-500/40 px-3 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-[3px] inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <div>
          <div className="text-[11px] font-semibold text-amber-300">
            No Cesium ion token
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-[rgb(var(--muted))]">
            Falling back to OpenStreetMap raster imagery on an ellipsoid. Set{' '}
            <code className="font-mono text-[9px] text-[rgb(var(--ink))]">
              NEXT_PUBLIC_CESIUM_TOKEN
            </code>{' '}
            in <code className="font-mono text-[9px]">.env.local</code> for
            satellite imagery and World Terrain.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto rounded px-1 text-[13px] leading-none text-[rgb(var(--muted))] hover:text-[rgb(var(--ink))]"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
