'use client';

import { useEffect, useMemo, useState } from 'react';

import { useDataStore, useDetailPending, useEditStore, useEnsureDetail, useViewStore, useBuildingNeighbours, useParcelSiblings, useEnsureLulc, useLulcPending, useEnsureSite, useEnsureSurveyParcelDetail } from '@/lib/store';
import { useUiStore } from '@/lib/ui-store';
import { componentForRef } from '@/components/layers/InfraSiteLayer';
import { LULC_SOURCE_SHORT, lulcClassLabel } from '@/lib/bhuvan';
import { RISK_HEX, SECTION_22A_HEX } from '@/lib/cesium/materials';
import type { RiskClass } from '@/lib/types';
import type { ClashFinding } from '@/lib/topology';

/** The store's topology slice, named so the section component can take it. */
interface ViewTopology {
  running: boolean;
  ranAt: string | null;
  error: string | null;
  findings: ClashFinding[];
  selected: number | null;
}
import BuildingEditForm from './detail/BuildingEditForm';
import UnsavedBanner from './detail/UnsavedBanner';
import DeedButton from './detail/DeedButton';
import DetailTabs from './detail/DetailTabs';
import LadmTab from './detail/LadmTab';
import { ROAD_CLASS_LABEL, utilityAssetLabel } from '@/lib/cesium/materials';
import {
  UNDERGROUND_BY_KEY, categoryOfAssetType,
} from '@/lib/underground/categories';
import { resolveCategoryDepths } from '@/lib/underground/layout';
import { codesOf, generate, levelLabel, parentOf } from '@/lib/ulpin';
import { orientedDims, ringCentroid } from '@/lib/geo';
import { coreNoun, coreSpan } from '@/lib/cesium/cores';
import { depthBelowGround } from '@/lib/cesium/basement-lift';
import type {
  Provenance, RoadProps, SurveyParcelDetail, SurveyParcelProps, UtilityProps,
} from '@/lib/types';
import UlpinCard from './UlpinCard';
import Section22ACard from './Section22ACard';
import CountUp from './CountUp';
import { DERIVED_PARCEL_NOTE, MOCK_BUILDING_NOTE, ProvenanceRow } from './Provenance';

/**
 * One panel, five modes: parcel / property / floor / unit / utility.
 *
 * Every mode ends in a provenance row. That is a hard rule rather than a
 * nicety: a viewer must never be left unsure whether a number in front of them
 * was surveyed or guessed. The parcel mode carries the strongest version of
 * it, because a numbered polygon on a flat map is the single most convincing
 * thing this application draws and almost none of it is surveyed.
 */

/*
 * Row, SourceChip, Section and SkeletonBar are EXPORTED, unlike the rest of
 * the locals in this file.
 *
 * components/ui/detail/LadmTab.tsx renders inside this panel and must be
 * typographically indistinguishable from it -- same label/value baseline, same
 * divider, same source chip, same shimmer. Copying four small components to
 * avoid an export is how two things that must look identical stop looking
 * identical, which is the argument this codebase makes about duplicated
 * arithmetic applied to duplicated markup.
 */
export function Row({
  label,
  value,
  source,
}: {
  label: string;
  value: React.ReactNode;
  /**
   * Where THIS row's value came from.
   *
   * Per row, not per panel, because the two are genuinely mixed: 59 of these
   * buildings carry a name an OSM contributor mapped and 325 carry one this
   * viewer generated, and a blanket "some of this is synthetic" footnote would
   * leave the user unable to tell which they are looking at.
   */
  source?: 'osm_tag' | 'generated' | 'derived' | 'bhuvan' | 'reference';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="row-label shrink-0">{label}</span>
      <span className="row-value flex items-baseline justify-end gap-1.5 text-right">
        {value}
        {source ? <SourceChip source={source} /> : null}
      </span>
    </div>
  );
}

/** Marks a single value as mapped fact or as a demonstration value. */
export function SourceChip({
  source,
}: {
  source: 'osm_tag' | 'generated' | 'derived' | 'bhuvan' | 'reference';
}) {
  if (source === 'reference') {
    return (
      <span
        title="Published by a cited reference. Not surveyed here, and not computed by this viewer."
        className="chip shrink-0 border border-[rgb(var(--edge-strong))] text-[rgb(var(--muted))]"
      >
        cited
      </span>
    );
  }
  if (source === 'bhuvan') {
    return (
      <span
        title="ISRO Bhuvan SISDP land use / land cover, 1:10,000 (2016–19), read by WMS GetFeatureInfo at the footprint centroid. Context, not a cadastral attribute."
        className="chip shrink-0 border border-[rgb(var(--edge-strong))] text-[rgb(var(--muted))]"
      >
        isro
      </span>
    );
  }
  if (source === 'osm_tag') {
    return (
      <span
        title="Mapped in OpenStreetMap by a contributor"
        className="chip shrink-0 border border-[rgb(var(--edge-strong))] text-[rgb(var(--muted))]"
      >
        osm
      </span>
    );
  }
  return (
    <span
      title={
        source === 'derived'
          ? 'Computed from the sourced data, not measured'
          : 'Synthetic demonstration value — not a register entry'
      }
      className="chip shrink-0 border border-dashed border-[rgb(var(--edge-strong))] text-[rgb(var(--muted-2))]"
    >
      {source === 'derived' ? 'derived' : 'demo'}
    </span>
  );
}

/**
 * One derived hazard-exposure class, as a coloured chip.
 *
 * Colour comes from the same ramp the ground patch uses, so the panel and the
 * map cannot disagree about what "high" looks like. Inline, like every other
 * legend swatch, which is what the monochrome chrome audit exempts.
 */
function RiskChip({ cls }: { cls: RiskClass }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className="h-2 w-2.5 shrink-0 rounded-sm ring-1 ring-[rgb(var(--edge-strong))]"
        style={{ background: RISK_HEX[cls] }}
      />
      <span className="capitalize">{cls}</span>
    </span>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
      <div className="panel-title">{title}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * One expandable row of the parcel tree.
 *
 * The disclosure idiom is Legend.tsx's -- a +/- glyph, aria-expanded, local
 * state -- because it is the only one this application has and inventing a
 * second would leave two things that look like the same control and are not.
 * Indentation is a left border rather than padding so the nesting is visible
 * at 390 px, where three levels of padding would leave the unit codes with no
 * room to sit on one line.
 */
function TreeRow({
  code,
  title,
  meta,
  depth,
  open,
  onToggle,
  onSelect,
  children,
}: {
  code: string;
  title: string;
  meta?: string;
  depth: 0 | 1 | 2;
  /** Undefined for a leaf: no glyph, no button, nothing to open. */
  open?: boolean;
  onToggle?: () => void;
  onSelect?: () => void;
  children?: React.ReactNode;
}) {
  const expandable = open !== undefined && onToggle !== undefined;
  return (
    <div className={depth === 0 ? '' : 'ml-2 border-l border-[rgb(var(--edge))]/50 pl-2'}>
      <div className="flex items-baseline gap-1.5 py-[3px]">
        {expandable ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
            className="w-3 shrink-0 text-left text-[10px] text-[rgb(var(--muted))] tint-hover"
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {onSelect ? (
            <button
              type="button"
              onClick={onSelect}
              className="block w-full truncate text-left text-[11px] text-[rgb(var(--ink))] tint-hover"
            >
              {title}
            </button>
          ) : (
            <div className="truncate text-[11px] text-[rgb(var(--ink))]">{title}</div>
          )}
          <div className="truncate font-mono text-[9px] text-[rgb(var(--muted))]">
            {code}
            {meta ? ` · ${meta}` : ''}
          </div>
        </div>
      </div>
      {expandable && open ? children : null}
    </div>
  );
}

/**
 * The ULPIN tree under a survey parcel: building -> floors -> units.
 *
 * ITS OWN COMPONENT because it holds hooks. DetailPanel calls every hook it
 * has before its first conditional return -- the Rules of Hooks comment at the
 * top of it says so -- so per-row open/closed state cannot live there.
 *
 * Everything starts CLOSED. A parcel with four towers on it has some hundreds
 * of flats beneath it, and a tree that opens itself is a panel that scrolls
 * the thing you clicked off the screen.
 */
function ParcelTree({
  buildings,
  onSelectBuilding,
}: {
  buildings: SurveyParcelDetail['buildings'];
  onSelectBuilding: (id: number) => void;
}) {
  const [openB, setOpenB] = useState<ReadonlySet<number>>(new Set());
  const [openF, setOpenF] = useState<ReadonlySet<number>>(new Set());
  const flip = (
    set: ReadonlySet<number>,
    id: number,
  ): ReadonlySet<number> => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  if (buildings.length === 0) {
    return (
      <p className="py-1 text-[11px] text-[rgb(var(--muted))]">
        No buildings recorded on this parcel.
      </p>
    );
  }

  return (
    <div className="mt-0.5">
      {buildings.map(({ building: b, floors }) => (
        <TreeRow
          key={b.id}
          depth={0}
          code={b.ulpin}
          title={b.name ?? `Building ${b.id}`}
          meta={`${b.floors} floor${b.floors === 1 ? '' : 's'}`}
          open={openB.has(b.id)}
          onToggle={() => setOpenB((s) => flip(s, b.id))}
          // Selecting here does NOT leave the 2D view. It sets the building so
          // that turning 2D GIS off lands on it -- which is why the camera
          // director compares the selection it saved on the way in.
          onSelect={() => onSelectBuilding(b.id)}
        >
          {floors.map((f) => (
            <TreeRow
              key={f.id}
              depth={1}
              code={f.ulpin}
              title={`Level ${levelLabel(f.level_no)}`}
              meta={`z ${f.z_min.toFixed(2)}–${f.z_max.toFixed(2)} m`}
              open={openF.has(f.id)}
              onToggle={() => setOpenF((s) => flip(s, f.id))}
            >
              {f.units.length === 0 ? (
                <p className="ml-2 border-l border-[rgb(var(--edge))]/50 py-[3px] pl-2 text-[10px] text-[rgb(var(--muted))]">
                  No units recorded.
                </p>
              ) : (
                f.units.map((u) => (
                  // A citizen is served their neighbours' flats with the
                  // geometry and nothing else -- no ULPIN, no unit number
                  // (see UnitInfo.restricted in lib/types.ts). The row stays,
                  // because the flat is really there and the count must add
                  // up, and it says what it is instead of showing a blank.
                  <TreeRow
                    key={u.id}
                    depth={2}
                    code={u.ulpin ?? '—'}
                    title={u.unit_no ?? 'Not your flat'}
                  />
                ))
              )}
            </TreeRow>
          ))}
        </TreeRow>
      ))}
    </div>
  );
}

/**
 * Placeholder for a value that is still in flight.
 *
 * Sized in a way that cannot move the row: the label beside it is 11px text
 * with a taller line box than this 10px bar, so the row height is governed by
 * the label either way and the swap to real content shifts nothing.
 */
export function SkeletonBar({ w = 'w-20' }: { w?: string }) {
  return <span className={`skeleton inline-block h-[10px] rounded align-middle ${w}`} />;
}

/**
 * A settled/unsettled state, said once and plainly.
 *
 * `alert` is the only thing that changes the colour, and it is the palette's
 * one hue: this is the row a holder is scanning for. A "paid" chip stays
 * monochrome on purpose -- green would make the panel a traffic light and
 * bury the one state that needs finding.
 */
function StateChip({ label, alert }: { label: string; alert: boolean }) {
  return (
    <span
      className={
        alert
          ? 'chip shrink-0 border border-danger/60 bg-danger/10 font-semibold text-dangerInk'
          : 'chip shrink-0 border border-[rgb(var(--edge-strong))] text-[rgb(var(--muted))]'
      }
    >
      {label}
    </span>
  );
}

const m2 = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`;
const m = (v: number) => `${v.toFixed(1)} m`;
/** Rupees, grouped the Indian way -- 26,85,400, not 2,685,400. */
const inr = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
/** An ISO yyyy-mm-dd as "10 Feb 2022". Anything unparseable is passed through
 *  verbatim rather than rendered as "Invalid Date". */
function longDate(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
/** Is this due date behind us? Used only to say "Overdue" rather than "Due",
 *  so a day either side of midnight costs nothing. */
function isPast(iso: string): boolean {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && t < Date.now();
}
/**
 * How to title and describe a volume, by what it is.
 *
 * A level holds more than flats now: parking bays below grade, shops and an
 * atrium on a retail ground floor, and the lift and stair cores running the
 * height of the building. Calling all of them "Flat" was the first thing that
 * gave away that the model had outgrown the panel.
 *
 * `titled` is the part that matters beyond the wording. A shop and a flat have
 * a holder, a tenure and a charge; a staircase, an atrium and a corridor do
 * not, and a parking bay is appurtenant to a flat rather than separately held.
 * Printing "Held by: Not on record" against a lift shaft would be inventing a
 * missing record where there is no record to miss -- the same error the owner
 * fallback used to make in the other direction.
 */
const UNIT_KINDS: Record<string, { noun: string; kicker: string; titled: boolean }> = {
  flat:        { noun: 'Flat',         kicker: 'Titled unit',       titled: true },
  retail:      { noun: 'Shop',         kicker: 'Retail bay',        titled: true },
  anchor:      { noun: '',             kicker: 'Anchor tenancy',    titled: true },
  parking:     { noun: 'Parking slot', kicker: 'Appurtenant space', titled: false },
  circulation: { noun: '',             kicker: 'Common space',      titled: false },
  atrium:      { noun: '',             kicker: 'Common space',      titled: false },
  elevator:    { noun: 'Lift',         kicker: 'Structural core · common property', titled: false },
  stair:       { noun: 'Staircase',    kicker: 'Structural core · common property', titled: false },
  plant:       { noun: '',             kicker: 'Plant space',       titled: false },
};

/** The descriptor for a unit, defaulting to the flat behaviour. */
function unitKindOf(kind: string | undefined) {
  return UNIT_KINDS[kind ?? 'flat'] ?? UNIT_KINDS.flat;
}

/**
 * What to call this volume on the card.
 *
 * The seeded `label` wins where there is one -- 'Anchor Store', 'Public
 * Atrium', 'Central Elevator Shaft' are the names these spaces actually have.
 * Everything else falls back to "<noun> <code>", which is how a flat and a
 * shop are named on the door.
 */
function unitTitle(unit: {
  unit_no?: string; label?: string; kind?: string; restricted?: boolean;
}): string {
  if (unit.label) return unit.label;
  const noun = unitKindOf(unit.kind).noun;
  // A neighbour's volume, served with no code: named by what it is only.
  if (!unit.unit_no) return noun || 'Unit';
  return noun ? `${noun} ${unit.unit_no}` : unit.unit_no;
}

/**
 * The result of the last topology validation run.
 *
 * Rendered in the AOI-summary branch -- the state the panel is in when nothing
 * is selected, which is where a project-wide answer belongs. A per-building
 * card would have to filter, and a finding is about a PAIR of things that
 * often sit in two different buildings.
 *
 * "Ran, found nothing" is shown as its own state and not as an empty list.
 * It is the only reassuring answer this feature can give, and collapsing it
 * into the same blank as "never asked" would throw it away.
 */
function TopologyFindings({
  topology, onSelect,
}: {
  topology: ViewTopology;
  onSelect: (i: number | null) => void;
}) {
  if (!topology.ranAt && !topology.running && !topology.error) return null;

  const critical = topology.findings.filter((f) => f.severity === 'critical').length;
  const warnings = topology.findings.length - critical;

  return (
    <Section title="Topology validation">
      {topology.running ? (
        <p className="text-[11px] text-muted">Testing volumes in 3D…</p>
      ) : topology.error ? (
        <p className="text-[11px] text-[rgb(var(--danger))]">{topology.error}</p>
      ) : topology.findings.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-muted">
          No clashes and no clearance breaches. Every subsurface run tested
          clear of the basement and parking volumes it passes near, and no
          elevated structure occupies a building&rsquo;s airspace.
        </p>
      ) : (
        <>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {critical > 0 ? (
              <StateChip label={`${critical} encroachment${critical === 1 ? '' : 's'}`} alert />
            ) : null}
            {warnings > 0 ? (
              <StateChip
                label={`${warnings} clearance breach${warnings === 1 ? '' : 'es'}`}
                alert={false}
              />
            ) : null}
          </div>
          <ul className="space-y-1">
            {topology.findings.map((f, i) => {
              const sel = topology.selected === i;
              return (
                <li key={`${f.kind}-${String(f.a.id)}-${f.b.type}-${String(f.b.id)}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(sel ? null : i)}
                    aria-pressed={sel}
                    className={[
                      'w-full rounded px-1.5 py-1 text-left transition-colors',
                      sel ? 'is-active' : 'tint-hover',
                    ].join(' ')}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[11px] text-[rgb(var(--ink))]">
                        {f.b.label}
                      </span>
                      <span
                        className={[
                          'shrink-0 font-mono text-[10px]',
                          f.severity === 'critical'
                            ? 'text-[rgb(var(--danger))]' : 'text-[rgb(var(--muted))]',
                        ].join(' ')}
                      >
                        {f.separation_m === 0
                          ? 'overlap'
                          : `${f.separation_m.toFixed(2)} m`}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted">
                      {f.a.label}
                    </span>
                    {sel ? (
                      <span className="mt-1 block space-y-0.5 text-[10px] text-muted">
                        <span className="block leading-snug">{f.note}</span>
                        <span className="block font-mono">
                          {f.lat.toFixed(6)}, {f.lon.toFixed(6)} · Z {f.z.toFixed(2)} m
                        </span>
                        <span className="block font-mono">
                          Z extent {f.b.z_min.toFixed(2)} → {f.b.z_max.toFixed(2)} m
                        </span>
                        {f.b.ulpin ? (
                          <span className="block font-mono">{f.b.ulpin}</span>
                        ) : null}
                        {f.required_m !== undefined ? (
                          <span className="block">
                            Required clearance {f.required_m.toFixed(2)} m
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-muted">
            Found with ST_3DIntersects and ST_3DDistance over the project&rsquo;s
            solids. Coordinates are EPSG:4326; Z is orthometric (EGM96).
          </p>
        </>
      )}
    </Section>
  );
}

/** Streets run from tens of metres to kilometres; switch units rather than
 *  printing "2369.7 m". */
const km = (v: number) =>
  (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${Math.round(v)} m`);

export default function DetailPanel() {
  // All hooks at the top, before any conditional return. Adding a hook
  // below an early return breaks the Rules of Hooks and React will throw
  // a render-order error as soon as the component takes a different path.
  const mode = useViewStore((s) => s.mode);
  const activeBuildingId = useViewStore((s) => s.activeBuildingId);
  const isolatedFloor = useViewStore((s) => s.isolatedFloor);
  const selectedUnitId = useViewStore((s) => s.selectedUnitId);
  const selectedUtilityId = useViewStore((s) => s.selectedUtilityId);
  const activeSiteId = useViewStore((s) => s.activeSiteId);
  const selectedComponent = useViewStore((s) => s.selectedComponent);
  const selectSite = useViewStore((s) => s.selectSite);
  const clearAmbient = useViewStore((s) => s.clearAmbient);
  const selectedRoadId = useViewStore((s) => s.selectedRoadId);
  // Which tab the panel is showing. In lib/ui-store.ts, not useViewStore:
  // lib/url-state.ts serialises only DELIBERATE state, and which tab a reader
  // happens to have open describes this window rather than the view.
  const detailTab = useUiStore((s) => s.detailTab);
  const underground = useViewStore((s) => s.underground);
  const session = useViewStore((s) => s.session);
  // The deed prints the project's slug into its QR target and its geoid
  // separation into the datum note, so it needs the whole row, not the slug.
  const project = useViewStore((s) => s.project);
  const topology = useViewStore((s) => s.topology);
  const selectFinding = useViewStore((s) => s.selectFinding);
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const gis2d = useViewStore((s) => s.gis2d);
  const activeSurveyParcelId = useViewStore((s) => s.activeSurveyParcelId);
  const surveyParcels = useDataStore((s) => s.surveyParcels);
  const activeSection22aId = useViewStore((s) => s.activeSection22aId);
  const selectSection22A = useViewStore((s) => s.selectSection22A);
  const section22a = useDataStore((s) => s.section22a);
  const parcelDoc = useEnsureSurveyParcelDetail(
    gis2d ? activeSurveyParcelId : null,
  );

  const editingId = useEditStore((s) => s.editingId);
  const beginEdit = useEditStore((s) => s.beginEdit);
  const savedRev = useEditStore((s) => s.savedRev);
  const clearSaved = useEditStore((s) => s.clearSaved);

  const buildings = useDataStore((s) => s.buildings);
  const utilities = useDataStore((s) => s.utilities);
  const roads = useDataStore((s) => s.roads);
  const loading = useDataStore((s) => s.loading);
  const detail = useEnsureDetail(activeBuildingId);
  const detailPending = useDetailPending(activeBuildingId);
  // ISRO Bhuvan LULC at the footprint centroid. Fetched on selection, cached
  // per building, and never waited on: the row below shimmers, nothing else.
  const lulcLayer = useViewStore((s) => s.project?.bhuvan_layers?.lulc ?? null);
  const lulc = useEnsureLulc(activeBuildingId, lulcLayer);
  const lulcPending = useLulcPending(activeBuildingId);

  /**
   * Per-category display depth offsets, from the same pure function the
   * underground layer builds its geometry with.
   *
   * Memoised on the collection, not on the selection: it is one pass over the
   * runs and it does not change when the user picks a different pipe.
   */
  // Already cached by the layer that opened the site; this is a read, not a
  // second fetch.
  const siteSpec = useEnsureSite(activeSiteId);

  /**
   * The revenue codes to mint the parcel identifier under.
   *
   * Read off an identifier the SERVER already minted rather than from the
   * project record or from ulpin.ts's defaults, which are AP/VSP: a Hyderabad
   * parcel would otherwise be labelled AP-VSP-3D26-0042 on a card that also
   * carries the disclaimer, which is a specific and expensive kind of wrong.
   * Null before the buildings land, and generate() then falls back to its own
   * defaults -- but the panel cannot be reached before then, because the
   * parcel layer is built from a collection that arrives after this one.
   */
  const parcelCodes = useMemo(
    () => codesOf(buildings?.features[0]?.properties.ulpin ?? ''),
    [buildings],
  );

  const categoryAdjust = useMemo(
    () => resolveCategoryDepths(utilities?.features ?? []),
    [utilities],
  );

  // Derived context selectors -- also called unconditionally, even when
  // they return an empty array (no active selection).
  // The "saved" confirmation clears itself; it is an acknowledgement, not a
  // state the panel should sit in.
  useEffect(() => {
    if (savedRev === null) return;
    const t = setTimeout(clearSaved, 2600);
    return () => clearTimeout(t);
  }, [savedRev, clearSaved]);

  const siblings = useParcelSiblings(activeBuildingId);
  // Topology findings touching this building, on either side of the pair --
  // replaces the old seeded-`conflict`-table lookup. Topology Validation is
  // now the only place a conflict is reported, so this is a live-check
  // result, not a permanent record; see the three-state render below.
  const buildingFindings = useMemo(
    () => topology.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => f.a.building_id === activeBuildingId
        || f.b.building_id === activeBuildingId),
    [topology.findings, activeBuildingId],
  );
  const neighbours = useBuildingNeighbours(activeBuildingId, 50);

  // ---- Section 22A restricted land ---------------------------------------
  // FIRST in the cascade, ahead of the survey parcel and the street.
  //
  // Safe at the head because every other selection setter clears
  // `activeSection22aId` -- selectBuilding, selectUnit, selectRoad,
  // selectUtility, setActiveSurveyParcel and clearAmbient all do, exactly as
  // they clear `selectedRoadId`. So this branch can only be reached when a 22A
  // entry is the most recent thing the user chose, and it can never mask a
  // building they have just clicked.
  if (activeSection22aId !== null) {
    const feature = section22a?.features.find(
      (f) => f.properties.id === activeSection22aId,
    );
    if (feature) {
      return (
        <Panel
          title={`Survey no. ${feature.properties.survey_no}`}
          kicker="Section 22A"
        >
          <Section22ACard props={feature.properties} />
        </Panel>
      );
    }
  }

  // ---- survey parcel -----------------------------------------------------
  // Second in the cascade, ahead of the street. In the 2D GIS view the Picker
  // resolves nothing else, so nothing else can be the most recent selection --
  // and the building the tree may have set must NOT take the panel over, or
  // clicking a row would replace the tree you clicked it in.
  if (gis2d && activeSurveyParcelId !== null) {
    const feature = surveyParcels?.features.find(
      (f) => (f.properties as SurveyParcelProps).id === activeSurveyParcelId,
    );
    const sp = feature?.properties as SurveyParcelProps | undefined;
    if (sp) {
      const surveyed = sp.provenance === 'survey_dept';
      // Is this plot in the 22A register? Only asked once the register has been
      // loaded, which happens only if the user switched the layer on -- so the
      // absence of this row means "not checked", never "not restricted", and
      // the card says nothing either way when the layer is off.
      const listed = section22a?.features.find(
        (f) => f.properties.parcel_id === sp.id,
      );
      return (
        <Panel title={`Parcel ${sp.label}`} kicker="Parcel">
          {/* The provenance line comes FIRST here, not last as it does in
              every other mode. Elsewhere the reader is looking at a building
              they can see and the question is how good the numbers are; here
              the question is what the polygon IS, and answering it after the
              identifier card would be answering it too late. */}
          <p className="row-label leading-snug">
            {surveyed
              ? `Survey parcel · ${sp.source ?? 'source not recorded'}`
              : 'Derived parcel (unofficial) · Voronoi clipped to OSM roads'}
          </p>

          {/* The 22A flag, above the identifier: if this plot may not be
              transacted, that outranks its number. A button rather than a
              badge, because the register entry is a card of its own and the
              reader who sees this will want it. */}
          {listed ? (
            <button
              type="button"
              onClick={() => selectSection22A(listed.properties.id)}
              className="mt-2 flex w-full items-center gap-2 rounded border border-danger/60 px-2 py-1.5 text-left tint-hover"
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-[2px] ring-1 ring-[rgb(var(--edge-strong))]"
                style={{ background: SECTION_22A_HEX }}
              />
              <span className="text-[12px] font-semibold text-dangerInk">
                Section 22A — Restricted
              </span>
              <span className="ml-auto text-[11px] text-[rgb(var(--muted))]">→</span>
            </button>
          ) : null}

          <div className="mt-2">
            {/* The parcel-level identifier, on the card that carries the
                disclaimer. Built with generate() rather than concatenated, so
                it round-trips through parse() by construction -- which is what
                scripts/check_gis2d.mjs asserts. */}
            <UlpinCard ulpin={generate(Number(sp.label), undefined, undefined,
              undefined, parcelCodes ?? undefined)} />
          </div>

          <div className="mt-2">
            <Row
              label="Extent"
              value={`${Math.round(sp.extent_sqm).toLocaleString()} m²`}
              source={surveyed ? undefined : 'derived'}
            />
            <Row label="Buildings" value={sp.building_count} />
            {surveyed && sp.ts_no ? <Row label="TS number" value={sp.ts_no} /> : null}
            {surveyed && sp.lpm_no ? <Row label="LPM number" value={sp.lpm_no} /> : null}
            {surveyed && sp.ulpin_14 ? (
              <Row label="Bhu-Aadhaar" value={sp.ulpin_14} />
            ) : null}
            {surveyed && sp.classification ? (
              <Row label="Classification" value={sp.classification} />
            ) : null}
            {surveyed && sp.source_date ? (
              <Row label="Register dated" value={sp.source_date} />
            ) : null}
          </div>

          <Section title="On this parcel">
            {parcelDoc.pending && !parcelDoc.doc ? (
              <div className="space-y-1 py-1">
                <SkeletonBar w="w-40" />
                <SkeletonBar w="w-28" />
              </div>
            ) : parcelDoc.doc ? (
              <ParcelTree
                buildings={parcelDoc.doc.buildings}
                onSelectBuilding={selectBuilding}
              />
            ) : (
              <p className="py-1 text-[11px] text-[rgb(var(--muted))]">
                The register for this parcel could not be read.
              </p>
            )}
          </Section>

          <p className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            {surveyed
              ? 'Boundary and register numbers as supplied by the issuing '
                + 'department. Everything below the building level -- floors '
                + 'and units -- is still generated by this application.'
              : `${DERIVED_PARCEL_NOTE} The number shown on the map is a `
                + 'per-project ordinal assigned by this application. It is '
                + 'NOT a survey number, a TS number, an LPM number or a '
                + '14-digit Bhu-Aadhaar, and no such number is held for this '
                + 'area of interest.'}
          </p>
        </Panel>
      );
    }
  }

  // ---- street ------------------------------------------------------------
  // Ahead of everything but the parcel, because the store guarantees that a
  // non-null selectedRoadId is always the most recent selection: every other
  // select* action clears it.
  if (selectedRoadId !== null) {
    const feat = roads?.features.find((f) => f.properties.id === selectedRoadId);
    const r = feat?.properties as RoadProps | undefined;
    if (r) {
      const derived = r.name_source === 'derived';
      const referenced = r.name_source === 'reference';
      return (
        <Panel title={r.name} kicker="Street">
          <Row
            label="Street ID"
            value={<span className="font-mono">{r.ref}</span>}
          />
          <Row label="Classification" value={ROAD_CLASS_LABEL[r.cls] ?? r.cls} />
          <Row label="Length" value={km(r.length_m)} />
          {r.alt_name ? <Row label="Also known as" value={r.alt_name} /> : null}
          <Row label="One-way" value={r.oneway ? 'Yes' : 'No'} />
          {r.lanes !== null ? <Row label="Lanes" value={r.lanes} /> : null}
          {r.surface ? (
            <Row label="Surface" value={<span className="capitalize">{r.surface}</span>} />
          ) : null}
          {r.osm_ids.length > 0 ? (
            <>
              <Row
                label="Merged from"
                value={`${r.segments} OSM way${r.segments === 1 ? '' : 's'}`}
              />
              <Row
                label="OSM ways"
                value={
                  <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
                    {r.osm_ids.slice(0, 3).join(', ')}
                    {r.osm_ids.length > 3 ? ` +${r.osm_ids.length - 3}` : ''}
                  </span>
                }
              />
            </>
          ) : (
            <Row label="Segments" value={r.segments} source="derived" />
          )}
          {/* Three provenances, three different claims. An OSM-tagged name is
              mapped fact; a referenced one is a name a cited source publishes
              but nobody surveyed here; a derived one is this viewer's own
              label and must never be quoted as a municipal street name. The
              provenance row is where that distinction is made, exactly as it
              is for building heights. */}
          <ProvenanceRow
            source={derived || referenced ? 'estimated' : 'osm_tag'}
            note={
              derived
                ? 'Centreline geometry and classification are from OpenStreetMap. '
                  + `This street carries no OSM name; the label above was assigned by `
                  + `this viewer from its position relative to `
                  + `${r.derived_from ?? 'the surrounding area'}. It is NOT a municipal `
                  + `street name — quote ${r.ref} instead.`
                : referenced
                  ? `Name published by ${r.derived_from ?? 'a cited reference'}. `
                    + 'The centreline itself is DERIVED for this demonstration '
                    + 'from the site specification — it is not a surveyed '
                    + 'alignment, and the length above is measured off it.'
                  : 'Street name, classification and centreline mapped in '
                    + 'OpenStreetMap by a contributor. Length is computed '
                    + 'geodesically from that centreline.'
            }
          />
        </Panel>
      );
    }
  }

  // ---- utility -----------------------------------------------------------
  if (selectedUtilityId !== null) {
    const feat = utilities?.features.find((f) => f.properties.id === selectedUtilityId);
    const u = feat?.properties as UtilityProps | undefined;
    if (u) {
      const related = topology.findings.filter(
        (f) => f.a.type === 'utility' && f.a.id === u.id,
      );
      const category = categoryOfAssetType(u.asset_type);
      const layer = category ? UNDERGROUND_BY_KEY[category] : null;

      // Recomputed here from the same inputs and the same pure function the
      // layer uses, rather than plumbed across from it. A layer never writes
      // to a store, so there is nowhere for it to publish this; and two calls
      // to resolveCategoryDepths over one dataset cannot disagree.
      const shift = categoryAdjust[category ?? 'water'] ?? 0;
      const drawnDepth = u.depth_m + shift;
      const displaced = Math.abs(shift) > 0.05;
      const lane = layer?.lane ?? 0;

      return (
        <Panel title={utilityAssetLabel(u.asset_type)} kicker="Underground asset">
          <Row
            label="Asset ID"
            value={<span className="font-mono">{u.ref ?? `#${u.id}`}</span>}
          />
          <Row label="Type" value={layer ? layer.label : u.asset_type} />
          <Row label="Recorded depth" value={`${u.depth_m.toFixed(1)} m below ground`} />
          {u.diameter_mm !== undefined ? (
            <Row label="Diameter" value={`${u.diameter_mm} mm`} />
          ) : null}
          {u.material !== undefined ? <Row label="Material" value={u.material} /> : null}
          <Row label="Corridor radius" value={m(u.radius_m)} />
          <Row label="Authority" value={u.authority} />
          {u.connected_area !== undefined ? (
            <Row label="Connected area" value={u.connected_area} />
          ) : null}
          {u.installed_on !== undefined ? (
            <Row label="Installed" value={longDate(u.installed_on)} />
          ) : null}
          <Row
            label="Status"
            value={
              <span className={u.status === 'operational' ? '' : 'text-dangerInk'}>
                {u.status}
              </span>
            }
          />

          {/*
            The display offset, stated rather than hidden.

            The viewer moves buried services apart so that six networks in one
            view stay legible -- a per-category corridor, and a depth nudge on
            the rare category that would otherwise sit inside the one above.
            Neither touches the record: the rows above are what the data says,
            and this is what the screen is doing to it. Shown only when there
            is something to disclose.
          */}
          {displaced || lane !== 0 ? (
            <div className="mt-2 rounded border border-[rgb(var(--edge))] bg-[rgb(var(--surface-2))] p-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--muted))]">
                Drawn for clarity
              </div>
              {displaced ? (
                <div className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">
                  Shown at {drawnDepth.toFixed(1)} m to clear the layer above.
                </div>
              ) : null}
              {lane !== 0 ? (
                <div className="mt-1 text-[11px] leading-snug text-[rgb(var(--ink))]">
                  Shown {Math.abs(lane).toFixed(1)} m to the{' '}
                  {lane > 0 ? 'right' : 'left'} of its recorded centreline.
                </div>
              ) : null}
              <div className="mt-1 text-[10px] leading-snug text-[rgb(var(--muted))]">
                The stored coordinates are unchanged.
              </div>
            </div>
          ) : null}

          {related.length > 0 ? (
            <div className="mt-2 rounded border border-danger/50 bg-danger/10 p-2">
              <div className="text-[11px] font-semibold text-dangerInk">
                {related.length} topology finding{related.length > 1 ? 's' : ''}
              </div>
              {related.map((f, i) => (
                <div key={`${f.kind}-${i}`} className="mt-1 font-mono text-[10px] text-dangerInk/90">
                  {f.b.label}
                </div>
              ))}
            </div>
          ) : null}

          <ProvenanceRow
            source={u.provenance === 'surveyed' ? 'surveyed_plan' : 'estimated'}
            synthetic={u.provenance === 'demonstration'}
            note={
              u.provenance === 'demonstration'
                ? 'DEMONSTRATION DATA. No utility survey was consulted. The '
                  + 'alignment, depth and attributes are illustrative and must '
                  + 'not be quoted as a record of what is buried here.'
                : 'Alignment generated by offsetting OSM road centrelines. '
                  + 'Representative of a service corridor, not an as-built '
                  + 'utility record.'
            }
          />
        </Panel>
      );
    }
  }

  // A building the user picked outranks the site card: they asked about that
  // building, and a site is a place rather than a selection.
  const bpropsSelected = activeBuildingId !== null && mode !== 'city';

  // ---- infrastructure component ------------------------------------------
  //
  // Above the site card, below the cadastral stack: picking a pillar is an
  // ambient selection like picking a street, and it describes what the panel
  // shows without changing what mode the scene is in.
  if (selectedComponent && siteSpec) {
    const spec = siteSpec.components.find((c) => c.ref === selectedComponent.ref
      || (c.repeat?.refPattern
        && selectedComponent.ref.startsWith(c.repeat.refPattern.split('%')[0])));
    const placed = componentForRef(selectedComponent.ref);
    if (spec || placed) {
      const label = placed?.label ?? spec?.label ?? 'Component';
      const meta = placed?.meta ?? spec?.meta ?? {};
      return (
        <Panel
          title={label}
          kicker="Infrastructure component"
          action={
            <button
              type="button"
              onClick={() => clearAmbient()}
              className="rounded px-1.5 py-[1px] text-[10px] text-[rgb(var(--ink))] tint-hover"
            >
              Clear
            </button>
          }
        >
          <Row label="Infrastructure" value={siteSpec.name} />
          <Row label="Component" value={label} />
          <Row
            label="ID"
            value={<span className="font-mono">{selectedComponent.ref}</span>}
            source="derived"
          />
          {Object.entries(meta).map(([k, v]) => (
            <Row key={k} label={k} value={String(v)} source="derived" />
          ))}
          <Row label="Status" value="Active" />
          <ProvenanceRow
            source="estimated"
            synthetic
            note={siteSpec.derivedNote}
          />
        </Panel>
      );
    }
  }

  // ---- infrastructure site ------------------------------------------------
  //
  // Shown while a site is open and nothing more specific is picked. The rows
  // above the rule are SOURCED and each names where it came from; everything
  // the model adds is in the component cards and is marked derived there.
  if (activeSiteId && siteSpec && !bpropsSelected) {
    return (
      <Panel
        title={siteSpec.name}
        kicker="Infrastructure"
        action={
          <button
            type="button"
            onClick={() => selectSite(null)}
            className="rounded px-1.5 py-[1px] text-[10px] text-[rgb(var(--ink))] tint-hover"
          >
            Close
          </button>
        }
      >
        <Row
          label="Type"
          value={siteSpec.kind === 'railway_station' ? 'Railway infrastructure' : 'Road infrastructure'}
        />
        {siteSpec.facts.map((f) => (
          <Row
            key={f.label}
            label={f.label}
            value={String(f.value)}
            source={f.source === 'osm_tag' ? 'osm_tag' : 'reference'}
          />
        ))}
        <Row label="Status" value="Active" />
        <Row label="Modelled parts" value={siteSpec.components.length} source="derived" />

        {/*
          The line that keeps the card honest. Everything above it is either a
          published figure with its source named, or a count of our own model;
          this says which is which in words, because a chip alone does not
          carry "no drawing was consulted".
        */}
        <ProvenanceRow source="estimated" synthetic note={siteSpec.derivedNote} />
      </Panel>
    );
  }

  const bprops = buildings?.features.find(
    (f) => f.properties.id === activeBuildingId,
  )?.properties;

  // ---- nothing selected --------------------------------------------------
  // In underground mode with NOTHING picked, the surface stack is not the
  // subject any more, so fall back to the area summary.
  //
  // A selected flat is the exception. A citizen boots with their own flat
  // selected, and when this fallback ignored that, the one panel they came
  // for -- the register behind their own door -- went unreachable the moment
  // underground was on. (Underground is no longer switched on for them at
  // boot, so it is now only reachable by toggling it themselves; the rule
  // holds either way.) A deliberate selection outranks a view mode.
  // The boot fetch writes buildings, parcels and utilities as three separate
  // stores, then clears `loading` -- so `loading` is the only signal that all
  // three have landed.
  const aoiReady = !loading && buildings !== null;

  if (
    !bprops
    || mode === 'city'
    || (underground && selectedUtilityId === null && selectedUnitId === null)
  ) {
    return (
      // The title is the project's own name, read off the FeatureCollection's
      // `aoi` field -- the same source the StatusBar uses, so the two cannot
      // disagree. It was hardcoded, which meant every project's summary panel
      // claimed to be Siripuram.
      <Panel
        title={buildings?.aoi ?? 'Area of interest'}
        kicker="Area of interest"
      >
        {/* Both figures wait on the same boot fetch, so they are gated
            together. Conflicts are not counted here -- Topology Validation,
            below, is the one place that question is asked and answered. */}
        <Row
          label="Buildings"
          value={aoiReady ? <CountUp value={buildings.features.length} /> : '—'}
        />
        <Row
          label="Utility runs"
          value={aoiReady ? <CountUp value={utilities?.features.length ?? 0} /> : '—'}
        />
        <Row label="CRS" value="EPSG:4326 · Z in metres" />
        <p className="mt-3 text-[11px] leading-snug text-[rgb(var(--muted))]">
          {underground
            ? 'Underground view. Click a utility corridor to inspect it.'
            : 'Click any building to open its vertical stack.'}
        </p>

        {/* Project-wide, so it belongs on the panel's project-wide state.
            Renders nothing at all until the validation has been run once. */}
        <TopologyFindings topology={topology} onSelect={selectFinding} />
      </Panel>
    );
  }

  const synthetic = Boolean(bprops.survey_synthetic);

  // ---- unit --------------------------------------------------------------
  if (selectedUnitId !== null && detail) {
    const unit = detail.units.find((x) => x.id === selectedUnitId);
    const floor = detail.floors.find((f) => f.id === unit?.floor_id);
    if (unit) {
      const height = unit.z_max - unit.z_min;
      const isOwn = session.role === 'citizen'
        && session.floor === unit.level_no
        && session.unit === unit.unit_no;
      // A flat the server redacted. UnitsLayer leaves these untagged so a
      // click cannot select one, but the panel says plainly why it is empty
      // rather than rendering a card full of dashes.
      if (unit.restricted) {
        const bay = unit.kind === 'parking';
        return (
          <Panel title={unitTitle(unit)} kicker={bay ? 'Not your bay' : 'Not your flat'}>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              {bay
                ? 'This bay is in your building, but it is allocated to another '
                  + 'flat. You can see where it is; its number, identifier and '
                  + 'allocation are only served to the flat it belongs to and '
                  + 'to the revenue department.'
                : 'This flat is in your building, but its record is not yours '
                  + 'to read. You can see where it is and how big it is; its '
                  + 'number, ULPIN, owner, areas and tenure are only served to '
                  + 'the person who holds it and to the revenue department.'}
            </p>
          </Panel>
        );
      }
      const ring = (unit.ring?.coordinates as number[][][] | undefined)?.[0];
      const centre = ring && ring.length > 1 ? ringCentroid(ring) : null;
      const kindInfo = unitKindOf(unit.kind);

      // ---- a vertical core ------------------------------------------------
      // A lift shaft or a staircase. It has no identifier, no holder, no
      // tenure and no certificate: it is building fabric, held in common,
      // and the card says what it is and how far it runs -- the whole shaft,
      // which is what the viewer is drawing, not the one storey of it that
      // happened to be under the cursor.
      const core = unit.core_ref ? coreSpan(detail.units, unit.core_ref) : null;
      if (core) {
        const top = bprops.floors - 1;
        const noun = coreNoun(core.kind);
        const shaftM = core.z_max - core.z_min;
        const footprint = ring && ring.length > 3 ? orientedDims(ring) : null;
        return (
          <Panel title={noun} kicker="Structural core · common property">
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {core.label ?? `${noun} core`}. Held in common by the owners'
              association; not separately titled, so it carries no 3D ULPIN,
              no holder and no certificate.
            </p>
            <Section title="The shaft">
              <Row
                label="Serves"
                value={`${levelLabel(core.lowest, top)} to ${levelLabel(core.highest, top)} · ${core.levels} levels`}
                source="derived"
              />
              <Row label="Shaft height" value={m(shaftM)} source="derived" />
              {footprint ? (
                <Row
                  label="Footprint"
                  value={`${footprint.lengthM.toFixed(1)} × ${footprint.widthM.toFixed(1)} m`}
                  source="derived"
                />
              ) : null}
              <Row
                label="Z extent"
                value={`${core.z_min.toFixed(2)} → ${core.z_max.toFixed(2)} m`}
              />
              <Row label="Selected at" value={`Level ${levelLabel(unit.level_no, top)}`} />
            </Section>
            <ProvenanceRow
              source={(floor?.detect_source ?? bprops.height_source) as Provenance}
              synthetic={synthetic}
              note={
                'The core is stored as one segment per level it passes through, '
                + 'and drawn here as one shaft. Its position is taken from the '
                + 'surveyed plan; nothing about it is a registered right.'
              }
            />
          </Panel>
        );
      }
      // Every segment of the same core, so the panel can report the span the
      // shaft actually covers instead of describing one storey of it as if
      // that were the whole thing.
      const coreSegments = unit.core_ref
        ? detail.units.filter((u) => u.core_ref === unit.core_ref)
        : [];
      // A parking bay: which flat's title it is a term of. The bay carries
      // no owner (it is not separately titled); the FLAT's register names
      // the bay, so the answer is a reverse lookup over the flats served.
      const reservedFor = unit.kind === 'parking' && unit.ulpin
        ? detail.units.find((u) => u.parking_ulpin === unit.ulpin) ?? null
        : null;
      // The bay this flat's title allocates, for the Parking section.
      const bay = kindInfo.titled && unit.parking_ulpin
        ? detail.units.find((u) => u.ulpin === unit.parking_ulpin) ?? null
        : null;
      const bills = unit.bills ?? [];
      const billsDue = bills.filter((b) => !b.paid);
      const taxDue = unit.tax ? Math.max(0, unit.tax.demand_inr - unit.tax.paid_inr) : 0;
      return (
        <Panel
          title={unitTitle(unit)}
          kicker={isOwn ? 'Your flat' : kindInfo.kicker}
        >
          {unit.ulpin ? <UlpinCard ulpin={unit.ulpin} /> : null}

          {/* Directly under the identifier it exports, so the two read as one
              thing: this is the ULPIN, and this is how you take it away. */}
          <DeedButton
            unit={unit}
            detail={detail}
            project={project}
            title={unitTitle(unit)}
            kicker={isOwn ? 'Your flat' : kindInfo.kicker}
            titled={kindInfo.titled}
          />

          {/*
            THE STRIP SITS UNDER THE IDENTIFIER AND THE EXPORT, not above
            them. The ULPIN and the deed button are true of the volume in
            either tab -- they are what this thing IS and how you take it
            away -- so putting them inside a tab would make the export
            disappear when a reader went to look at the rights they were
            about to export.

            Both panels stay MOUNTED and are hidden with the `hidden`
            attribute, which is Sheet.tsx's idiom: unmounting would re-run
            the effects behind them, and `hidden` also keeps the inactive
            text out of innerText, which is what the acceptance harness
            reads.
          */}
          <DetailTabs />

          <div
            id="detail-panel-details"
            role="tabpanel"
            hidden={detailTab !== 'details'}
          >
          {/* The three answers a holder opens this panel for, ahead of any of
              the rows: is it mine outright, is the tax settled, do I owe
              anyone this month. Red is the only hue in this palette and it is
              reserved for exactly this -- a state the reader must not miss. */}
          {unit.ownership || unit.tax || bills.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {unit.ownership ? (
                <StateChip
                  alert={false}
                  label={unit.ownership === 'mortgaged' ? 'Mortgaged' : 'Owned outright'}
                />
              ) : null}
              {unit.tax ? (
                <StateChip
                  alert={taxDue > 0}
                  label={
                    taxDue === 0
                      ? 'Tax paid'
                      : unit.tax.paid_inr > 0
                        ? `Tax part-paid · ${inr(taxDue)} due`
                        : `Tax due · ${inr(taxDue)}`
                  }
                />
              ) : null}
              {bills.length > 0 ? (
                <StateChip
                  alert={billsDue.length > 0}
                  label={
                    billsDue.length === 0
                      ? 'Bills clear'
                      : `${billsDue.length} bill${billsDue.length > 1 ? 's' : ''} unpaid`
                  }
                />
              ) : null}
            </div>
          ) : null}

          <Section title="Where it is">
            {unit.address ? <Row label="Address" value={unit.address} /> : null}
            <Row label="Level" value={levelLabel(unit.level_no, bprops.floors - 1)} />
            {unit.facing ? <Row label="Facing" value={unit.facing} /> : null}
            {/* The FLAT's own centroid, not the building's. Computed from the
                unit ring the server already sent, so it needs no new field and
                it moves when the geometry does. */}
            {centre ? (
              <Row
                label="Coordinates"
                source="derived"
                value={
                  <span className="font-mono text-[11px]">
                    {centre.lat.toFixed(6)}, {centre.lon.toFixed(6)}
                  </span>
                }
              />
            ) : null}
            <Row
              label="Z extent"
              value={`${unit.z_min.toFixed(2)} → ${unit.z_max.toFixed(2)} m`}
            />
            {bprops.ulpin ? (
              <Row
                label="Parent building"
                value={<span className="font-mono text-[11px]">{bprops.ulpin}</span>}
              />
            ) : null}
            {detail.parcel || bprops.ulpin ? (
              <Row
                label="Parent parcel"
                value={
                  <span className="font-mono text-[11px]">
                    {detail.parcel?.ulpin ?? (unit.ulpin ? parentOf(unit.ulpin) : null) ?? '—'}
                  </span>
                }
              />
            ) : null}
          </Section>

          {/*
            THE BAY THIS TITLE CARRIES. Every flat in the demo tower has one,
            allocated in the register and bundled into the flat's LA_BAUnit as
            an appurtenant member; this is the same fact, where a holder
            looks for it. The bay's own identifier is printed because the
            certificate prints it, and the two must agree.
          */}
          {kindInfo.titled && unit.parking_ulpin ? (
            <Section title="Parking">
              <Row label="Bay" value={unit.parking_label ?? bay?.label ?? unit.parking_ulpin} />
              <Row
                label="Bay 3D ULPIN"
                value={<span className="font-mono text-[11px]">{unit.parking_ulpin}</span>}
              />
              <Row
                label="Bay level"
                value={(() => {
                  const lvl = bay?.level_no ?? unit.parking_level;
                  return lvl === undefined ? '—' : `Level ${levelLabel(lvl, bprops.floors - 1)}`;
                })()}
              />
              {bay?.built_m2 !== undefined ? (
                <Row label="Bay area" value={m2(bay.built_m2)} />
              ) : null}
              <Row label="Held as" value="Appurtenant to this flat" />
            </Section>
          ) : null}

          <Section title={kindInfo.titled ? 'The unit' : 'The space'}>
            <Row label="Carpet area" value={m2(unit.carpet_m2 ?? 0)} />
            <Row label="Built-up area" value={m2(unit.built_m2 ?? 0)} />
            <Row label="Clear height" value={m(height)} />
            <Row label="Volume" value={`${((unit.built_m2 ?? 0) * height).toFixed(0)} m³`} />
            {/*
              A core is one row per level it passes through -- floor_id is NOT
              NULL, and the exploded stack and the section cut are both
              per-level. So the SEGMENT is what was clicked and the SHAFT is
              what the reader means, and the panel has to say both.
            */}
            {coreSegments.length > 1 ? (
              <Row
                label="Shaft extent"
                value={`${levelLabel(
                  Math.min(...coreSegments.map((u) => u.level_no)), bprops.floors - 1,
                )} to ${levelLabel(
                  Math.max(...coreSegments.map((u) => u.level_no)), bprops.floors - 1,
                )} · ${coreSegments.length} levels`}
                source="derived"
              />
            ) : null}
          </Section>

          {/*
            SUPPRESSED for a volume with no register behind it. A staircase, a
            lift shaft, an atrium and a circulation passage have no holder, no
            tenure and no charge, and a parking bay is appurtenant to a flat
            rather than separately titled. Rendering the rows with "Not on
            record" in them would present the absence of a record as a gap in
            one, which is the same wrong answer the parcel-owner fallback used
            to give from the other direction.
          */}
          {!kindInfo.titled ? (
            <Section title="Tenure">
              <Row label="Held as" value={unit.tenure ?? '—'} />
              {unit.kind === 'parking' ? (
                <Row
                  label="Reserved for"
                  value={reservedFor
                    ? `Flat ${reservedFor.unit_no}${reservedFor.owner ? ` · ${reservedFor.owner}` : ''}`
                    : 'Not allocated'}
                />
              ) : null}
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                {unit.kind === 'parking'
                  ? 'Allocated parking, appurtenant to a flat rather than '
                    + 'separately titled. It has no ULPIN holder of its own.'
                  : 'Common or structural space. It is not separately titled, '
                    + 'so there is no holder, tenure or charge to report.'}
              </p>
            </Section>
          ) : null}

          {kindInfo.titled ? (
          <Section title="Title and charge">
            {/*
              The FLAT's holder, falling back to unknown rather than to the
              parcel's owner. The parcel belongs to the developer, so the old
              fallback confidently attributed every flat in the tower to
              Sampath Estates -- a wrong answer stated as a right one.
            */}
            <Row label="Held by" value={unit.owner ?? 'Not on record'} />
            <Row label="Tenure" value={unit.tenure ?? '—'} />
            {unit.ownership ? (
              <Row
                label="Held as"
                value={
                  unit.ownership === 'mortgaged'
                    ? 'Owned, with a bank charge'
                    : 'Owned outright'
                }
              />
            ) : null}
            {unit.registered_on ? (
              <Row label="Registered on" value={longDate(unit.registered_on)} />
            ) : null}
            {unit.title_deed ? (
              <Row
                label="Title deed"
                value={<span className="font-mono text-[11px]">{unit.title_deed}</span>}
              />
            ) : null}
            <Row
              label="Encumbrance"
              value={
                <span className={unit.encumbrance === 'None' ? '' : 'font-semibold text-ink'}>
                  {unit.encumbrance ?? '—'}
                </span>
              }
            />
            <Row label="Parcel owner" value={detail.parcel?.owner ?? '—'} />
          </Section>
          ) : null}

          {unit.mortgage ? (
            <Section title="Mortgage">
              <Row label="Bank" value={unit.mortgage.bank} />
              <Row label="Branch" value={unit.mortgage.branch} />
              <Row
                label="Loan account"
                value={<span className="font-mono text-[11px]">{unit.mortgage.loan_no}</span>}
              />
              <Row label="Sanctioned" value={inr(unit.mortgage.sanctioned_inr)} />
              <Row
                label="Outstanding"
                value={
                  <span className="font-semibold text-ink">
                    {inr(unit.mortgage.outstanding_inr)}
                  </span>
                }
              />
              <Row label="EMI" value={`${inr(unit.mortgage.emi_inr)} / month`} />
              <Row label="Charge from" value={longDate(unit.mortgage.charge_from)} />
              <Row label="Charge closes" value={longDate(unit.mortgage.closes_on)} />
            </Section>
          ) : null}

          {unit.tax ? (
            <Section title={`Property tax ${unit.tax.year}`}>
              <Row label="Authority" value={unit.tax.authority} />
              <Row
                label="Assessment no."
                value={<span className="font-mono text-[11px]">{unit.tax.assessment_no}</span>}
              />
              <Row label="Demand" value={inr(unit.tax.demand_inr)} />
              <Row label="Paid" value={inr(unit.tax.paid_inr)} />
              {taxDue > 0 ? (
                <Row
                  label="Outstanding"
                  value={<span className="font-semibold text-dangerInk">{inr(taxDue)}</span>}
                />
              ) : null}
              {unit.tax.paid_on ? (
                <Row label="Last paid" value={longDate(unit.tax.paid_on)} />
              ) : null}
              <Row
                label={taxDue > 0 ? 'Payable by' : 'Due date'}
                value={
                  <span className={taxDue > 0 && isPast(unit.tax.due_on) ? 'text-dangerInk' : ''}>
                    {longDate(unit.tax.due_on)}
                  </span>
                }
              />
            </Section>
          ) : null}

          {bills.length > 0 ? (
            <Section title="Bills">
              {bills.map((b) => (
                <div key={`${b.kind}-${b.account}`} className="py-[3px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="row-label shrink-0 capitalize">{b.kind}</span>
                    <span className="row-value flex items-baseline justify-end gap-1.5 text-right">
                      {inr(b.amount_inr)}
                      <StateChip
                        alert={!b.paid}
                        label={b.paid ? 'Paid' : isPast(b.due_on) ? 'Overdue' : 'Due'}
                      />
                    </span>
                  </div>
                  <div className="text-[10px] leading-snug text-[rgb(var(--muted))]">
                    {b.authority} · {b.period} ·{' '}
                    <span className="font-mono">{b.account}</span> ·{' '}
                    {b.paid && b.paid_on
                      ? `paid ${longDate(b.paid_on)}`
                      : `due ${longDate(b.due_on)}`}
                  </div>
                </div>
              ))}
            </Section>
          ) : null}

          <ProvenanceRow
            source={(floor?.detect_source ?? bprops.height_source) as Provenance}
            synthetic={synthetic}
            note={
              'Unit boundaries are a grid subdivision of the building footprint, '
              + 'not a registered floor plan. Tenure, encumbrance, mortgage, tax '
              + 'and bills come from a demonstration register in '
              + 'data/projects/<slug>/flat-register.json: shaped like the real '
              + 'thing, sourced from nothing. No figure here is quotable.'
            }
          />
          </div>

          <div
            id="detail-panel-ladm"
            role="tabpanel"
            hidden={detailTab !== 'ladm'}
          >
            {/*
              `suId` is null until the tab is actually showing, which is what
              makes the LADM request happen on tab OPEN rather than on
              selection. Clicking through twenty flats costs nothing; the one
              a reader asks about costs one request.
            */}
            <LadmTab suId={detailTab === 'ladm' ? unit.ulpin ?? null : null} />
          </div>
        </Panel>
      );
    }
  }

  // ---- floor -------------------------------------------------------------
  if (isolatedFloor !== null && detail) {
    const floor = detail.floors.find((f) => f.level_no === isolatedFloor);
    if (floor) {
      const units = detail.units.filter((u) => u.level_no === isolatedFloor);
      // Redacted flats contribute nothing: a citizen's floor total covers the
      // flats they may see, and inferring a neighbour's area from a total
      // would undo the redaction the server just applied.
      const gross = units.reduce((a, u) => a + (u.built_m2 ?? 0), 0);
      // What is on the level, by kind, in words: '4 flats · lift · stairs'.
      const onLevel = (() => {
        const n = (k: string) => units.filter((u) => (u.kind ?? 'flat') === k).length;
        const parts: string[] = [];
        if (n('flat')) parts.push(`${n('flat')} flat${n('flat') === 1 ? '' : 's'}`);
        if (n('parking')) parts.push(`${n('parking')} parking bays`);
        if (n('retail') + n('anchor')) parts.push(`${n('retail') + n('anchor')} shops`);
        if (n('circulation') && floor.level_no >= 0) parts.push('lobby');
        if (n('circulation') && floor.level_no < 0) parts.push('drive aisles');
        if (n('plant')) parts.push('plant room');
        if (n('elevator')) parts.push('lift');
        if (n('stair')) parts.push('stairs');
        return parts.length ? parts.join(' · ') : '— (non-habitable)';
      })();
      const basement = floor.level_no < 0;
      return (
        <Panel
          title={`Level ${levelLabel(floor.level_no, bprops.floors - 1)}`}
          kicker={basement ? 'Basement level' : 'Floor level'}
        >
          {floor.ulpin ? <UlpinCard ulpin={floor.ulpin} /> : null}
          {basement && !underground ? (
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Shown lifted above ground so the plan can be read. The ring
              marks true ground level; the depth below is from the stored
              heights, which are unchanged.
            </p>
          ) : null}
          <div className="mt-2">
            <Row label="Level number" value={floor.level_no} />
            {basement ? (
              <Row
                label="Depth below ground"
                value={m(depthBelowGround(bprops.ground_elev, floor.z_min))}
              />
            ) : null}
            <Row
              label="Z extent"
              value={`${floor.z_min.toFixed(2)} → ${floor.z_max.toFixed(2)} m`}
            />
            <Row label="Slab height" value={m(floor.z_max - floor.z_min)} />
            <Row label="On this level" value={onLevel} />
            {gross > 0 ? <Row label="Total built-up" value={m2(gross)} /> : null}
            {bprops.ulpin ? (
              <Row
                label="Parent building"
                value={<span className="font-mono text-[11px]">{bprops.ulpin}</span>}
              />
            ) : null}
          </div>
          <ProvenanceRow source={floor.detect_source} synthetic={synthetic} />
        </Panel>
      );
    }
  }

  // ---- building ----------------------------------------------------------
  const editing = editingId === bprops.id;
  // Anonymous callers keep the button: the viewer is reachable without a
  // session in dev, and hiding it there would be a change to how the app
  // already behaves for them. Only a citizen is known to be refused.
  const canEdit = session.role !== 'citizen';
  const totalUnits = detail?.units.length ?? 0;

  // A CITIZEN'S BUILDING CARD names the building and their flat, and stops.
  // The server served them one floor and two volumes (their flat and its
  // bay), so every total below -- units, areas, encumbrances, the parcel --
  // would either be wrong or be a leak, and the tower's own identifier is
  // not theirs to read.
  if (session.role === 'citizen') {
    const mine = detail?.units.find(
      (u) => u.level_no === session.floor && u.unit_no === session.unit,
    );
    return (
      <Panel title={bprops.name ?? `${bprops.use_type} building`} kicker="Your building">
        <div className="mt-1">
          {bprops.address ? <Row label="Address" value={bprops.address} /> : null}
          <Row label="Storeys" value={`${bprops.floors} above ground`} />
          <Row label="Basements" value={bprops.basements} />
          <Row
            label="Your flat"
            value={session.unit
              ? `Flat ${session.unit} · Level ${levelLabel(session.floor ?? 0, bprops.floors - 1)}`
              : '—'}
          />
        </div>
        <p className="mt-3 text-[11px] leading-snug text-[rgb(var(--muted))]">
          {mine
            ? 'Use the level ladder to look at any floor. Your flat is the one '
              + 'that opens: its record, its parking bay and its certificate. '
              + 'Other flats are shown as shapes only.'
            : 'Your flat is being located…'}
        </p>
      </Panel>
    );
  }

  /** '20 storeys · 3 basements · 80 flats · 80 bays · lift + stairs'. */
  const composition = (() => {
    if (!detail) return null;
    const n = (k: string) => detail.units.filter((u) => (u.kind ?? 'flat') === k).length;
    const parts = [`${bprops.floors} storeys`];
    if (bprops.basements) parts.push(`${bprops.basements} basement${bprops.basements === 1 ? '' : 's'}`);
    if (n('flat')) parts.push(`${n('flat')} flats`);
    if (n('retail') + n('anchor')) parts.push(`${n('retail') + n('anchor')} shops`);
    if (n('parking')) parts.push(`${n('parking')} parking bays`);
    const cores = [n('elevator') ? 'lift' : null, n('stair') ? 'stairs' : null].filter(Boolean);
    if (cores.length) parts.push(cores.join(' + '));
    return parts.join(' · ');
  })();
  // Footprint dimensions: oriented bbox in metres. The buildings
  // FeatureCollection carries no footprint property -- only the per-building
  // detail document does -- so read the ring from there, not from bprops.
  const dims = (() => {
    try {
      const ring = detail?.building.footprint.coordinates?.[0];
      if (!ring) return null;
      return orientedDims(ring);
    } catch { return null; }
  })();
  // Floor area breakdown: total + above-ground vs basement.
  const areaBreakdown = (() => {
    if (!detail) return null;
    let total = 0, above = 0, below = 0, aboveCount = 0, belowCount = 0;
    for (const u of detail.units) {
      // Redacted flats are counted in neither the area nor the tally: the
      // caller was not told their size, and a count they are absent from is
      // the honest summary of what the caller can actually see.
      if (u.built_m2 === undefined) continue;
      total += u.built_m2;
      if (u.level_no >= 0) { above += u.built_m2; aboveCount++; }
      else { below += u.built_m2; belowCount++; }
    }
    return { total, above, below, aboveCount, belowCount };
  })();
  // Encumbrance breakdown by category.
  const encBreakdown = (() => {
    if (!detail) return null;
    const counts: Record<string, number> = { None: 0, Mortgage: 0, Lien: 0, Disputed: 0 };
    for (const u of detail.units) {
      const e = u.encumbrance;
      if (e === undefined) continue;    // redacted: not disclosed, not 'None'
      if (e === 'None') counts.None++;
      else if (e.startsWith('Mortgage')) counts.Mortgage++;
      else if (e.startsWith('Lien')) counts.Lien++;
      else if (e.startsWith('Disputed')) counts.Disputed++;
    }
    return counts;
  })();

  return (
    <Panel
      title={bprops.name ?? `${bprops.use_type} building`}
      kicker="Building"
      action={
        // Only gov may edit. The PATCH already refuses a citizen with a 403
        // (refuseMutation), so this is not the guard -- it just stops offering
        // a button whose only outcome for this user is an error.
        editing || !canEdit ? null : (
          <button
            type="button"
            onClick={() => beginEdit(bprops.id)}
            disabled={detailPending}
            title={
              detailPending
                ? 'Waiting for the building record to load'
                : 'Edit this building record'
            }
            className={[
              'shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors',
              detailPending
                ? 'is-disabled text-[rgb(var(--muted))]'
                : 'border border-[rgb(var(--edge-strong))] text-[rgb(var(--ink))] tint-hover',
            ].join(' ')}
          >
            Edit
          </button>
        )
      }
    >
      <UnsavedBanner activeId={bprops.id} />
      {bprops.ulpin ? <UlpinCard ulpin={bprops.ulpin} /> : null}
      {composition ? (
        <p className="mt-2 text-[11px] leading-snug text-[rgb(var(--muted))]">
          {composition}
        </p>
      ) : null}

      {savedRev !== null ? (
        <p role="status" className="mt-2 rounded border border-[rgb(var(--edge-strong))] bg-[rgb(var(--surface-2))] px-2 py-1 text-[11px] text-[rgb(var(--ink))]">
          Saved · revision {savedRev}
        </p>
      ) : null}

      {editing ? <BuildingEditForm building={bprops} /> : null}

      <div className="mt-2">
        {/* Register attributes. Sourced fields (storeys, height, ULPIN) sit
            below unmarked; anything this viewer generated carries a chip. */}
        {bprops.building_ref ? (
          <Row
            label="Building ID"
            value={<span className="font-mono">{bprops.building_ref}</span>}
            source="derived"
          />
        ) : null}
        <Row label="Use type" value={<span className="capitalize">{bprops.use_type}</span>} />
        {bprops.building_type ? (
          <Row label="Building type" value={bprops.building_type} source="generated" />
        ) : null}
        {bprops.address ? (
          <Row
            label="Address"
            value={bprops.address}
            source={bprops.address_source === 'osm_tag' ? 'osm_tag' : 'generated'}
          />
        ) : null}
        <Row label="Height" value={m(bprops.height_m)} />
        <Row label="Storeys" value={`${bprops.floors} above ground`} />
        <Row label="Basements" value={bprops.basements} />
        <Row
          label="Ground elevation"
          value={
            <span>
              {m(bprops.ground_elev)}
              <span className="ml-1 text-[rgb(var(--muted))]">
                {bprops.ground_source === 'dsm_dem' ? '· CartoDEM 1″' : '· placeholder'}
              </span>
            </span>
          }
        />
        {bprops.flood_risk || bprops.cyclone_risk ? (
          <>
            {bprops.flood_risk ? (
              <Row
                label="Flood exposure"
                source="derived"
                value={<RiskChip cls={bprops.flood_risk} />}
              />
            ) : null}
            {bprops.cyclone_risk ? (
              <Row
                label="Cyclone exposure"
                source="derived"
                value={<RiskChip cls={bprops.cyclone_risk} />}
              />
            ) : null}
            {typeof bprops.coast_dist_m === 'number' ? (
              <Row
                label="Distance to coast"
                source="derived"
                value={`${(bprops.coast_dist_m / 1000).toFixed(2)} km`}
              />
            ) : null}
          </>
        ) : null}
        {lulcLayer ? (
          lulcPending ? (
            <Row label="LULC" value={<SkeletonBar w="w-28" />} />
          ) : lulc && lulc !== 'none' ? (
            <Row
              label="LULC"
              source="bhuvan"
              value={
                <span>
                  {lulcClassLabel(lulc)}
                  <span className="ml-1 text-[rgb(var(--muted))]">— {LULC_SOURCE_SHORT}</span>
                </span>
              }
            />
          ) : (
            <Row
              label="LULC"
              source="bhuvan"
              value={
                <span className="text-[rgb(var(--muted))]">
                  {lulc === 'none' ? 'no class at this point' : 'unavailable'}
                  {` — ${LULC_SOURCE_SHORT}`}
                </span>
              }
            />
          )
        ) : null}
        {bprops.built_up_m2 !== undefined ? (
          <Row label="Built-up area" value={m2(bprops.built_up_m2)} source="derived" />
        ) : null}
        {bprops.occupancy_units !== undefined ? (
          <Row
            label="Occupancy"
            value={
              <span>
                {bprops.occupancy_units} / {bprops.occupancy_total_units} units
                {bprops.occupancy_persons
                  ? ` · ~${bprops.occupancy_persons} residents`
                  : ''}
              </span>
            }
            source="generated"
          />
        ) : null}
        {bprops.owner_org ? (
          <Row label="Owner / organisation" value={bprops.owner_org} source="generated" />
        ) : null}
        {bprops.status ? (
          <Row label="Status" value={bprops.status} source="generated" />
        ) : null}
        {/* Read-only by requirement, and marked as such: these are the
            building's identity, not attributes of it. */}
        {bprops.lat !== undefined ? (
          <Row
            label="Coordinates"
            value={
              <span className="font-mono text-[11px]" title="Read-only">
                {bprops.lat.toFixed(5)}, {bprops.lon?.toFixed(5)}
              </span>
            }
          />
        ) : null}
        {/* Everything above comes from the buildings FeatureCollection, which
            is already in hand the moment the building is picked. Only the rows
            below wait on /api/building/:id, so only they shimmer -- blanking
            out facts we already hold would be a worse answer than a slow one. */}
        {detailPending ? (
          <>
            <Row label="Units" value={<SkeletonBar w="w-8" />} />
            <Row label="Parent parcel" value={<SkeletonBar w="w-28" />} />
            <Row label="Registered owner" value={<SkeletonBar w="w-24" />} />
            <Row label="Parcel area" value={<SkeletonBar w="w-16" />} />
          </>
        ) : (
          <>
            <Row label="Units" value={totalUnits || '—'} />
            <Row
              label="Parent parcel"
              value={
                <span className="font-mono text-[11px]">{detail?.parcel?.ulpin ?? '—'}</span>
              }
            />
            <Row label="Registered owner" value={detail?.parcel?.owner ?? '—'} />
            {detail?.parcel ? (
              <Row label="Parcel area" value={m2(detail.parcel.area_m2)} />
            ) : null}
          </>
        )}
      </div>

      {/* Editing the storey count does not regenerate floor and unit records:
          those are cadastral child rows, and fabricating them would be a far
          larger invention than a name. Derived from the data rather than from
          edit state, so it stays true after the form closes and after a
          reload -- which is when it actually matters. */}
      {detail && detail.floors.length > 0
        && detail.floors.filter((f) => f.level_no >= 0).length !== bprops.floors ? (
          <p className="mt-2 rounded border border-[rgb(var(--edge-strong))] bg-[rgb(var(--surface-2))] p-2 text-[10px] leading-snug text-[rgb(var(--muted))]">
            Storey count was edited to {bprops.floors}. The floor and unit records
            below still reflect the {detail.floors.filter((f) => f.level_no >= 0).length}{' '}
            surveyed levels — an attribute edit does not regenerate them.
          </p>
        ) : null}

      {/* --- footprint dimensions ----------------------------------------- */}
      {/* Reserved while pending: this section pops into existence when the
          detail lands, and reserving its height is what stops the panel below
          it from jumping. */}
      {detailPending ? (
        <Section title="Footprint">
          <Row label="Dimensions" value={<SkeletonBar w="w-32" />} />
          <Row label="Footprint area" value={<SkeletonBar w="w-16" />} />
        </Section>
      ) : dims ? (
        <Section title="Footprint">
          <Row
            label="Dimensions"
            value={
              <span>
                {dims.lengthM.toFixed(1)} × {dims.widthM.toFixed(1)} m
                <span className="ml-1 text-[rgb(var(--muted))]">
                  · {Math.round(dims.longAxisDeg)}° long axis
                </span>
              </span>
            }
          />
          <Row
            label="Footprint area"
            value={m2(dims.lengthM * dims.widthM)}
          />
        </Section>
      ) : null}

      {/* --- floor area breakdown ---------------------------------------- */}
      {areaBreakdown && totalUnits > 0 ? (
        <Section title="Floor area">
          <Row label="Total built-up" value={m2(areaBreakdown.total)} />
          <Row
            label="Above ground"
            value={`${m2(areaBreakdown.above)} · ${areaBreakdown.aboveCount} units`}
          />
          {areaBreakdown.below > 0 ? (
            <Row
              label="Basement"
              value={`${m2(areaBreakdown.below)} · ${areaBreakdown.belowCount} units`}
            />
          ) : null}
        </Section>
      ) : null}

      {/* --- encumbrance breakdown --------------------------------------- */}
      {encBreakdown && totalUnits > 0 ? (
        <Section title="Encumbrance">
          <Row label="Clear (None)" value={encBreakdown.None} />
          <Row
            label="Mortgaged"
            value={<span className={encBreakdown.Mortgage ? 'font-semibold text-ink' : ''}>{encBreakdown.Mortgage}</span>}
          />
          <Row
            label="Lien"
            value={<span className={encBreakdown.Lien ? 'font-semibold text-ink' : ''}>{encBreakdown.Lien}</span>}
          />
          <Row
            label="Disputed"
            value={<span className={encBreakdown.Disputed ? 'text-dangerInk' : ''}>{encBreakdown.Disputed}</span>}
          />
        </Section>
      ) : null}

      {/* --- parcel siblings --------------------------------------------- */}
      {siblings.length > 0 ? (
        <Section title="On the same parcel">
          {siblings.map((sib) => (
            <button
              key={sib.id}
              type="button"
              onClick={() => selectBuilding(sib.id)}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-[2px] text-left tint-hover"
            >
              <span className="row-label">building {sib.id}</span>
              <span className="row-value font-mono text-[10px]">{sib.ulpin}</span>
            </button>
          ))}
        </Section>
      ) : null}

      {/* --- topology findings touching this building ---------------------
        Three states, matching TopologyFindings' own reassurance rule: "not
        asked yet" must never collapse into the same "no encroachments" the
        panel gives a building that was actually checked and found clear.
      */}
      <Section title="Encroachments">
        {!topology.ranAt ? (
          <p className="text-[10px] leading-snug text-[rgb(var(--muted))]">
            Not checked — run Topology Validation from the Layers panel.
          </p>
        ) : buildingFindings.length === 0 ? (
          <p className="text-[10px] text-[rgb(var(--muted))]">no encroachments</p>
        ) : (
          buildingFindings.map(({ f, i }) => (
            <button
              key={`${f.kind}-${i}`}
              type="button"
              onClick={() => selectFinding(topology.selected === i ? null : i)}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-[2px] text-left tint-hover"
            >
              <span className="row-value text-left">
                {f.b.label}
                <span className="ml-1 text-[rgb(var(--muted))]">· {f.a.label}</span>
              </span>
              <span
                className={`text-[10px] ${f.severity === 'critical' ? 'text-dangerInk' : 'text-dangerInk/80'}`}
              >
                {f.separation_m === 0 ? 'overlap' : `${f.separation_m.toFixed(2)} m`}
              </span>
            </button>
          ))
        )}
      </Section>

      {/* --- neighbours within 50 m -------------------------------------- */}
      {neighbours.length > 0 ? (
        <Section title="Neighbours within 50 m">
          {neighbours.map(({ b, distanceM }) => (
            <button
              key={b.id}
              type="button"
              onClick={() => selectBuilding(b.id)}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-[2px] text-left tint-hover"
            >
              <span className="row-value text-left font-mono text-[10px]">
                {b.ulpin}
                <span className="ml-1 text-[rgb(var(--muted))]">
                  · {b.use_type}
                </span>
              </span>
              <span className="text-[10px] text-[rgb(var(--muted))]">
                {distanceM.toFixed(1)} m
              </span>
            </button>
          ))}
        </Section>
      ) : null}

      <ProvenanceRow source={bprops.height_source} synthetic={synthetic} />
      <p className="mt-2 text-[9px] leading-snug text-[rgb(var(--muted))]">
        {DERIVED_PARCEL_NOTE} {MOCK_BUILDING_NOTE}
      </p>
    </Panel>
  );
}

export function Panel({
  title,
  kicker,
  action,
  children,
}: {
  title: string;
  kicker: string;
  /** Optional control in the header, e.g. the Edit button. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-panel="detail" className="glass rounded-lg p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="panel-title">{kicker}</div>
          {/* `capitalize` is wrong for a proper name -- it would render
              "AU Library" as "Au Library" -- so it is not applied here. */}
          <h2 className="mt-0.5 truncate text-[15px] font-semibold text-[rgb(var(--ink))]">
            {title}
          </h2>
        </div>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
