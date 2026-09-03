'use client';

import { useEffect } from 'react';

import { useDataStore, useDetailPending, useEditStore, useEnsureDetail, useViewStore, useBuildingNeighbours, useBuildingConflicts, useParcelSiblings } from '@/lib/store';
import BuildingEditForm from './detail/BuildingEditForm';
import UnsavedBanner from './detail/UnsavedBanner';
import { ROAD_CLASS_LABEL, UTILITY_LABEL } from '@/lib/cesium/materials';
import { levelLabel, parentOf } from '@/lib/ulpin';
import { orientedDims } from '@/lib/geo';
import type { AssetType, Provenance, RoadProps, UtilityProps } from '@/lib/types';
import UlpinCard from './UlpinCard';
import CountUp from './CountUp';
import { DERIVED_PARCEL_NOTE, MOCK_BUILDING_NOTE, ProvenanceRow } from './Provenance';

/**
 * One panel, four modes: property / floor / unit / utility.
 *
 * Every mode ends in a provenance row. That is a hard rule rather than a
 * nicety: a viewer must never be left unsure whether a number in front of them
 * was surveyed or guessed.
 */

function Row({
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
  source?: 'osm_tag' | 'generated' | 'derived';
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
function SourceChip({ source }: { source: 'osm_tag' | 'generated' | 'derived' }) {
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
      <div className="panel-title">{title}</div>
      <div className="mt-1">{children}</div>
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
function SkeletonBar({ w = 'w-20' }: { w?: string }) {
  return <span className={`skeleton inline-block h-[10px] rounded align-middle ${w}`} />;
}

const m2 = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`;
const m = (v: number) => `${v.toFixed(1)} m`;
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
  const selectedRoadId = useViewStore((s) => s.selectedRoadId);
  const underground = useViewStore((s) => s.underground);
  const selectBuilding = useViewStore((s) => s.selectBuilding);
  const selectUtility = useViewStore((s) => s.selectUtility);

  const editingId = useEditStore((s) => s.editingId);
  const beginEdit = useEditStore((s) => s.beginEdit);
  const savedRev = useEditStore((s) => s.savedRev);
  const clearSaved = useEditStore((s) => s.clearSaved);

  const buildings = useDataStore((s) => s.buildings);
  const utilities = useDataStore((s) => s.utilities);
  const roads = useDataStore((s) => s.roads);
  const conflicts = useDataStore((s) => s.conflicts);
  const loading = useDataStore((s) => s.loading);
  const detail = useEnsureDetail(activeBuildingId);
  const detailPending = useDetailPending(activeBuildingId);

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
  const buildingConflicts = useBuildingConflicts(activeBuildingId);
  const neighbours = useBuildingNeighbours(activeBuildingId, 50);

  // ---- street ------------------------------------------------------------
  // First in the cascade because the store guarantees that a non-null
  // selectedRoadId is always the most recent selection: every other select*
  // action clears it.
  if (selectedRoadId !== null) {
    const feat = roads?.features.find((f) => f.properties.id === selectedRoadId);
    const r = feat?.properties as RoadProps | undefined;
    if (r) {
      const derived = r.name_source === 'derived';
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
          {/* An OSM-tagged name is mapped fact; a derived one is this viewer's
              own label. The provenance row is where that distinction is made,
              exactly as it is for building heights. */}
          <ProvenanceRow
            source={derived ? 'estimated' : 'osm_tag'}
            note={
              derived
                ? 'Centreline geometry and classification are from OpenStreetMap. '
                  + `This street carries no OSM name; the label above was assigned by `
                  + `this viewer from its position relative to `
                  + `${r.derived_from ?? 'the surrounding area'}. It is NOT a municipal `
                  + `street name — quote ${r.ref} instead.`
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
      const related = conflicts.filter((c) => c.utility_id === u.id);
      return (
        <Panel title={UTILITY_LABEL[u.asset_type as AssetType]} kicker="Utility asset">
          <Row label="Asset ID" value={<span className="font-mono">#{u.id}</span>} />
          <Row label="Type" value={UTILITY_LABEL[u.asset_type as AssetType]} />
          <Row label="Depth" value={`${u.depth_m.toFixed(1)} m below datum`} />
          <Row label="Corridor radius" value={m(u.radius_m)} />
          <Row label="Authority" value={u.authority} />
          <Row
            label="Status"
            value={
              <span className={u.status === 'operational' ? '' : 'text-dangerInk'}>
                {u.status}
              </span>
            }
          />
          {related.length > 0 ? (
            <div className="mt-2 rounded border border-danger/50 bg-danger/10 p-2">
              <div className="text-[11px] font-semibold text-dangerInk">
                {related.length} basement conflict{related.length > 1 ? 's' : ''}
              </div>
              {related.map((c) => (
                <div key={c.id} className="mt-1 font-mono text-[10px] text-dangerInkInk/90">
                  {c.building_ulpin} · level {c.level_no}
                </div>
              ))}
            </div>
          ) : null}
          <ProvenanceRow
            source={'estimated'}
            note={
              'Alignment generated by offsetting OSM road centrelines. '
              + 'Representative of a service corridor, not an as-built utility record.'
            }
          />
        </Panel>
      );
    }
  }

  const bprops = buildings?.features.find(
    (f) => f.properties.id === activeBuildingId,
  )?.properties;

  // ---- nothing selected --------------------------------------------------
  // In underground mode with no corridor picked, the surface stack is not the
  // subject any more -- showing the previously selected unit here would be
  // stale context, so fall back to the area summary.
  // The boot fetch writes buildings, parcels, utilities and conflicts as four
  // separate stores, then clears `loading` -- so `loading` is the only signal
  // that all four have landed.
  const aoiReady = !loading && buildings !== null;

  if (!bprops || mode === 'city' || (underground && selectedUtilityId === null)) {
    return (
      <Panel title="Siripuram, Visakhapatnam" kicker="Area of interest">
        {/* All three figures wait on the same boot fetch, so they are gated
            together: counting conflicts up to zero while that array is still
            unset would animate a number that is not yet true. */}
        <Row
          label="Buildings"
          value={aoiReady ? <CountUp value={buildings.features.length} /> : '—'}
        />
        <Row
          label="Utility runs"
          value={aoiReady ? <CountUp value={utilities?.features.length ?? 0} /> : '—'}
        />
        <Row
          label="Flagged conflicts"
          value={aoiReady ? <CountUp value={conflicts.length} /> : '—'}
        />
        <Row label="CRS" value="EPSG:4326 · Z in metres" />
        <p className="mt-3 text-[11px] leading-snug text-[rgb(var(--muted))]">
          {underground
            ? 'Underground view. Click a utility corridor to inspect it.'
            : 'Click any building to open its vertical stack.'}
        </p>
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
      return (
        <Panel title={`Unit ${unit.unit_no}`} kicker="Titled unit">
          <UlpinCard ulpin={unit.ulpin} />
          <div className="mt-2">
            <Row label="Level" value={levelLabel(unit.level_no, bprops.floors - 1)} />
            <Row label="Carpet area" value={m2(unit.carpet_m2)} />
            <Row label="Built-up area" value={m2(unit.built_m2)} />
            <Row label="Volume" value={`${(unit.built_m2 * height).toFixed(0)} m³`} />
            <Row
              label="Z extent"
              value={`${unit.z_min.toFixed(2)} → ${unit.z_max.toFixed(2)} m`}
            />
            <Row label="Clear height" value={m(height)} />
            <Row label="Tenure" value={unit.tenure} />
            <Row
              label="Encumbrance"
              value={
                <span className={unit.encumbrance === 'None' ? '' : 'font-semibold text-ink'}>
                  {unit.encumbrance}
                </span>
              }
            />
            <Row
              label="Parent parcel"
              value={
                <span className="font-mono text-[11px]">
                  {detail.parcel?.ulpin ?? parentOf(unit.ulpin) ?? '—'}
                </span>
              }
            />
            <Row label="Registered owner" value={detail.parcel?.owner ?? '—'} />
          </div>
          <ProvenanceRow
            source={(floor?.detect_source ?? bprops.height_source) as Provenance}
            synthetic={synthetic}
            note={
              'Unit boundaries are a grid subdivision of the building footprint, '
              + 'not a registered floor plan. Tenure and encumbrance are synthetic.'
            }
          />
        </Panel>
      );
    }
  }

  // ---- floor -------------------------------------------------------------
  if (isolatedFloor !== null && detail) {
    const floor = detail.floors.find((f) => f.level_no === isolatedFloor);
    if (floor) {
      const units = detail.units.filter((u) => u.level_no === isolatedFloor);
      const gross = units.reduce((a, u) => a + u.built_m2, 0);
      return (
        <Panel
          title={`Level ${levelLabel(floor.level_no, bprops.floors - 1)}`}
          kicker={floor.level_no < 0 ? 'Basement level' : 'Floor level'}
        >
          <UlpinCard ulpin={floor.ulpin} />
          <div className="mt-2">
            <Row label="Level number" value={floor.level_no} />
            <Row
              label="Z extent"
              value={`${floor.z_min.toFixed(2)} → ${floor.z_max.toFixed(2)} m`}
            />
            <Row label="Slab height" value={m(floor.z_max - floor.z_min)} />
            <Row label="Units on level" value={units.length || '— (non-habitable)'} />
            {gross > 0 ? <Row label="Total built-up" value={m2(gross)} /> : null}
            <Row
              label="Parent building"
              value={<span className="font-mono text-[11px]">{bprops.ulpin}</span>}
            />
          </div>
          <ProvenanceRow source={floor.detect_source} synthetic={synthetic} />
        </Panel>
      );
    }
  }

  // ---- building ----------------------------------------------------------
  const editing = editingId === bprops.id;
  const totalUnits = detail?.units.length ?? 0;
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
        editing ? null : (
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
      <UlpinCard ulpin={bprops.ulpin} />

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
        <Row label="Ground elevation" value={m(bprops.ground_elev)} />
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

      {/* --- conflicts touching this building ----------------------------- */}
      <Section title="Encroachments">
        {buildingConflicts.length === 0 ? (
          <p className="text-[10px] text-[rgb(var(--muted))]">no encroachments</p>
        ) : (
          buildingConflicts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => selectUtility(c.utility_id)}
              className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-[2px] text-left tint-hover"
            >
              <span className="row-value text-left">
                {UTILITY_LABEL[c.asset_type as AssetType]}
                <span className="ml-1 text-[rgb(var(--muted))]">
                  · {c.authority} · level {c.level_no}
                </span>
              </span>
              <span className={`text-[10px] ${c.status === 'operational' ? 'text-dangerInk' : 'text-dangerInkInk/80'}`}>
                {c.status}
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

function Panel({
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
