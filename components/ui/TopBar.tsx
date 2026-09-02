'use client';

import { useMemo, useState } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import { parse } from '@/lib/ulpin';
import { copyViewLink } from '@/lib/url-state';

/**
 * Brand, area name, search and the tool menus.
 *
 * Search resolves a ULPIN, an address fragment or an owner name down to a
 * building and selects it. Share copies the shareable view URL (the address
 * bar already tracks the full view state via lib/url-state.ts). Layers/Tools
 * toggle the panels they name rather than merely pointing at them.
 * Measurements is rendered visibly disabled: the brief asks for it to be
 * present but inert, and hiding it would misrepresent what the build does.
 */

interface Hit {
  buildingId: number;
  primary: string;
  secondary: string;
}

export default function TopBar() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const buildings = useDataStore((s) => s.buildings);
  const parcels = useDataStore((s) => s.parcels);
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const leftPanelOpen = useViewStore((s) => s.leftPanelOpen);
  const setLeftPanelOpen = useViewStore((s) => s.setLeftPanelOpen);
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const statsOpen = useViewStore((s) => s.statsOpen);
  const setStatsOpen = useViewStore((s) => s.setStatsOpen);

  // The area name tracks the selection so the header always answers "where am
  // I": AOI at city level, the selected building's address/name deeper in.
  const areaName = useMemo(() => {
    if (mode === 'city' || activeBuildingId === null || !buildings) {
      return 'Siripuram · Visakhapatnam';
    }
    const b = buildings.features.find((f) => f.properties.id === activeBuildingId)
      ?.properties;
    if (!b) return 'Siripuram · Visakhapatnam';
    return b.name ?? b.address ?? `Building ${b.id}`;
  }, [mode, activeBuildingId, buildings]);

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
        b.ulpin, b.name ?? '', b.address ?? '', owner, String(b.id),
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
    <div className="glass pointer-events-auto flex h-11 min-h-11 items-center gap-3 rounded-lg px-3">
      {/* Brand + area name. The pin marks the AOI; the name swaps to the
          selected building once one is active. */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[rgb(var(--accent))]/15 text-[13px]"
          aria-hidden
        >
          📍
        </span>
        <div className="min-w-0 leading-tight">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[13px] font-semibold tracking-tight text-[rgb(var(--ink))]">
              3D ULPIN
            </span>
            <span className="hidden text-[9px] font-medium uppercase tracking-[0.14em] text-[rgb(var(--muted))] md:inline">
              Vertical Property Mapper
            </span>
          </div>
          <div className="truncate text-[10px] text-[rgb(var(--accent))]">
            {areaName}
          </div>
        </div>
      </div>

      {/* Search. Flexes on small screens; hidden hits panel is width-bound. */}
      <div className="relative ml-auto w-full max-w-[300px] min-w-[120px] lg:ml-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 140)}
          placeholder="Search ULPIN, address, owner…"
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
        <button
          type="button"
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          title={leftPanelOpen ? 'Hide the layers panel' : 'Show the layers panel'}
          aria-pressed={leftPanelOpen}
          className={[
            'hidden rounded px-2 py-1 text-[11px] transition-colors sm:block',
            leftPanelOpen
              ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]'
              : 'text-[rgb(var(--ink))] hover:bg-white/10',
          ].join(' ')}
        >
          Layers
        </button>
        <button
          type="button"
          onClick={() => setLeftPanelOpen(true)}
          title="Camera gestures and reset live in the dock at the bottom"
          className="hidden rounded px-2 py-1 text-[11px] text-[rgb(var(--ink))] transition-colors hover:bg-white/10 sm:block"
        >
          Tools
        </button>
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
        <MenuButton
          label={shared ? 'Copied ✓' : 'Share'}
          hint="Copy a link to this exact view"
          onClick={async () => {
            const ok = await copyViewLink();
            setShared(ok);
            setTimeout(() => setShared(false), 1400);
          }}
        />
      </div>
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  hint,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
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
