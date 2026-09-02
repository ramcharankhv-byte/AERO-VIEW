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

export default function TopBar() {
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
    <div className="glass pointer-events-auto flex h-11 items-center gap-3 rounded-lg px-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold tracking-tight text-[rgb(var(--ink))]">
          3D ULPIN
        </span>
        <span className="hidden text-[10px] text-[rgb(var(--muted))] sm:inline">
          Vertical Property Mapper
        </span>
      </div>

      <div className="relative ml-2 w-[300px]">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          placeholder="Search ULPIN, address or owner…"
          className="h-7 w-full rounded border border-[rgb(var(--edge))] bg-black/25 px-2 text-[12px] text-[rgb(var(--ink))] placeholder:text-[rgb(var(--muted))] focus:border-[rgb(var(--accent))] focus:outline-none"
        />
        {open && hits.length > 0 ? (
          <div className="glass absolute left-0 top-8 z-30 max-h-64 w-full overflow-y-auto rounded-md p-1">
            {hits.map((h) => (
              <button
                key={h.buildingId}
                type="button"
                onMouseDown={() => choose(h.buildingId)}
                className="block w-full rounded px-2 py-1 text-left hover:bg-white/10"
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

      <div className="ml-auto flex items-center gap-1">
        <MenuButton label="Layers" hint="Use the panel on the left" />
        <MenuButton label="Tools" hint="Use the dock at the bottom" />
        {/* MenuButton has no pressed state, so this uses the active idiom from
            ActionBar and NavDock rather than inventing a third one. */}
        <button
          type="button"
          onClick={() => setStatsOpen(!statsOpen)}
          aria-pressed={statsOpen}
          title="Area statistics"
          className={[
            'rounded px-2 py-1 text-[11px] transition-colors',
            statsOpen
              ? 'bg-[rgb(var(--accent))] text-black'
              : 'text-[rgb(var(--ink))] hover:bg-white/10',
          ].join(' ')}
        >
          Stats
        </button>
        <MenuButton label="Measurements" disabled />
        <MenuButton label="Share" disabled />
      </div>
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  hint,
}: {
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? `${label} — not implemented` : hint}
      className={[
        'rounded px-2 py-1 text-[11px] transition-colors',
        disabled
          ? 'is-disabled text-[rgb(var(--muted))]'
          : 'text-[rgb(var(--ink))] hover:bg-white/10',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
