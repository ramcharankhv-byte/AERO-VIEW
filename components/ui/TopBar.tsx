'use client';

import { useMemo, useState } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import { parse } from '@/lib/ulpin';

/**
 * Brand, search and the tool menus.
 *
 * Search resolves a ULPIN, an address fragment or an owner name down to a
 * building and selects it. Measurements and Share are rendered visibly
 * disabled: the brief asks for them to be present but inert, and hiding them
 * would misrepresent what the build actually does.
 */

interface Hit {
  buildingId: number;
  primary: string;
  secondary: string;
}

export default function TopBar({
  /** Phone layout: the tool menus go, the search stays. */
  compact = false,
  /**
   * Medium layout: the "Layers" button becomes a real disclosure for the
   * drawer. Until now it carried only a `title` hint and did nothing when
   * clicked, which was a button lying about being a menu.
   */
  onLayersClick,
  layersOpen = false,
  /**
   * Override for the Stats control.
   *
   * On a phone Stats is a sheet tab rather than a floating panel, so the
   * button has to drive the tab. Without this it wrote `statsOpen` and the
   * sheet's tab-sync effect overwrote it on the same tick -- a button that
   * looked live and did nothing.
   */
  onStatsClick,
  statsActive,
}: {
  compact?: boolean;
  onLayersClick?: () => void;
  layersOpen?: boolean;
  onStatsClick?: () => void;
  statsActive?: boolean;
} = {}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const buildings = useDataStore((s) => s.buildings);
  const parcels = useDataStore((s) => s.parcels);
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const statsOpen = useViewStore((s) => s.statsOpen);
  const setStatsOpen = useViewStore((s) => s.setStatsOpen);

  const hits = useMemo<Hit[]>(() => {
    const term = query.trim().toLowerCase();
    if (term.length < 2 || !buildings) return [];

    const ownerByParcel = new Map<number, string>();
    for (const p of parcels?.features ?? []) {
      ownerByParcel.set(p.properties.id, p.properties.owner);
    }

    const parsed = parse(term.toUpperCase());
    const out: Hit[] = [];

    for (const f of buildings.features) {
      const b = f.properties;
      const owner = ownerByParcel.get(b.parcel_id) ?? '';
      const haystack = [
        b.ulpin, b.name ?? '', b.address ?? '', owner,
        // The register fields are what a user actually has to hand: "BLD-1193"
        // off a report, or "GVMC" when looking for what a body owns.
        b.building_ref ?? '', b.owner_org ?? '', b.building_type ?? '',
      ].join(' ').toLowerCase();

      // An exact parcel match from a parsed ULPIN beats a substring match.
      const ulpinMatch = parsed ? b.parcel_id === parsed.parcel : false;
      if (ulpinMatch || haystack.includes(term)) {
        out.push({
          buildingId: b.id,
          primary: b.name ?? b.address ?? b.ulpin,
          secondary: owner ? `${b.ulpin} · ${owner}` : b.ulpin,
        });
      }
      if (out.length >= 8) break;
    }
    return out;
  }, [query, buildings, parcels]);

  const choose = (id: number) => {
    selectBuilding(id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div data-panel="topbar" className="glass pointer-events-auto flex h-11 items-center gap-2 rounded-lg px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold tracking-tight text-[rgb(var(--ink))]">
          3D ULPIN
        </span>
        <span className="hidden text-[10px] text-[rgb(var(--muted))] lg:inline">
          Vertical Property Mapper
        </span>
      </div>

      <div className={`relative ml-1 min-w-0 flex-1 ${compact ? '' : 'sm:ml-2 sm:max-w-[300px]'}`}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          placeholder="Search ULPIN, address or owner…"
          className="h-7 w-full rounded border border-[rgb(var(--edge))] bg-[rgb(var(--surface-2))] px-2 text-[12px] text-[rgb(var(--ink))] placeholder:text-[rgb(var(--muted))] focus:border-[rgb(var(--accent))]"
        />
        {open && hits.length > 0 ? (
          <div className="glass absolute left-0 top-8 z-30 max-h-64 w-full overflow-y-auto rounded-md p-1">
            {hits.map((h) => (
              <button
                key={h.buildingId}
                type="button"
                onMouseDown={() => choose(h.buildingId)}
                className="block w-full rounded px-2 py-1 text-left tint-hover"
              >
                <div className="truncate text-[12px] capitalize text-[rgb(var(--ink))]">
                  {h.primary}
                </div>
                <div className="truncate font-mono text-[10px] text-[rgb(var(--muted))]">
                  {h.secondary}
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {open && query.trim().length >= 2 && hits.length === 0 ? (
          <div className="glass absolute left-0 top-8 z-30 w-full rounded-md px-2 py-1.5 text-[11px] text-[rgb(var(--muted))]">
            No match
          </div>
        ) : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {compact ? null : (
          <>
            <MenuButton
              label="Layers"
              hint={onLayersClick ? 'Show or hide the layer panel' : 'Use the panel on the left'}
              onClick={onLayersClick}
              expanded={onLayersClick ? layersOpen : undefined}
              controls={onLayersClick ? 'layer-drawer' : undefined}
            />
            <MenuButton label="Tools" hint="Use the dock at the bottom" />
          </>
        )}
        {/* MenuButton has no pressed state, so this uses the active idiom from
            ActionBar and NavDock rather than inventing a third one. */}
        <button
          type="button"
          onClick={onStatsClick ?? (() => setStatsOpen(!statsOpen))}
          aria-pressed={statsActive ?? statsOpen}
          title="Area statistics"
          className={[
            'rounded px-2 py-1 text-[11px] transition-colors',
            (statsActive ?? statsOpen)
              ? 'is-active'
              : 'text-[rgb(var(--ink))] tint-hover',
          ].join(' ')}
        >
          Stats
        </button>
        {compact ? null : (
          <>
            <MenuButton label="Measurements" disabled />
            <MenuButton label="Share" disabled />
          </>
        )}
      </div>
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  hint,
  onClick,
  expanded,
  controls,
}: {
  label: string;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
      title={disabled ? `${label} — not implemented` : hint}
      className={[
        'rounded px-2 py-1 text-[11px] transition-colors',
        disabled
          ? 'is-disabled text-[rgb(var(--muted))]'
          : 'text-[rgb(var(--ink))] tint-hover',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
