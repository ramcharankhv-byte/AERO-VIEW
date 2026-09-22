'use client';

import { useMemo, useState } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import {
  MATERIALS, RISK_HEX, ROAD_COLOR, ROAD_STYLE, SECTION_22A_HEX,
  SURVEY_PARCEL_VIEW,
} from '@/lib/cesium/materials';
import {
  SECTION_22A_DISCLAIMER, SECTION_22A_MOCK_NOTE,
} from '@/lib/section22a/types';
import {
  UNDERGROUND_LAYERS, categoryOfAssetType, type UtilityCategory,
} from '@/lib/underground/categories';
import { PROVENANCES } from '@/lib/stats';
import { buildLegendUrl, LULC_NOTE } from '@/lib/bhuvan';
import {
  HAZARD_CAVEAT, HAZARD_DRIVERS, HAZARD_LABEL, RISK_MEANING,
} from '@/lib/hazard';
import { RISK_ORDER } from '@/lib/types';
import type { RiskClass, RoadClass } from '@/lib/types';
import { ProvenanceBadge } from './Provenance';

/**
 * The three street weights worth keying.
 *
 * Not all nine classes: the key exists to explain that line weight encodes
 * hierarchy, which three examples do better than an exhaustive list.
 */
const ROAD_KEY: { cls: RoadClass; label: string }[] = [
  { cls: 'primary', label: 'Arterial' },
  { cls: 'tertiary', label: 'Collector' },
  { cls: 'service', label: 'Service lane' },
];

/**
 * The colour keys: provenance always, utility corridors underground.
 *
 * The provenance key is not gated on a selection. Which heights were surveyed
 * and which were guessed is the point of the system, so the badge language has
 * to be readable before the user has clicked anything -- otherwise the colours
 * on screen are a code with no key.
 */
export default function Legend() {
  const underground = useViewStore((s) => s.underground);
  const mode = useViewStore((s) => s.mode);
  const utilities = useDataStore((s) => s.utilities);
  const roads = useDataStore((s) => s.roads);
  const showRoads = useViewStore((s) => s.layers.roads);
  const buildings = useDataStore((s) => s.buildings);
  const showLulc = useViewStore((s) => s.layers.bhuvanLulc);
  const showFlood = useViewStore((s) => s.layers.bhuvanFlood);
  const showCyclone = useViewStore((s) => s.layers.bhuvanCyclone);
  // One hazard is graded at a time; flood wins, as in HazardRiskLayer.
  const hazard = showFlood ? 'flood' : showCyclone ? 'cyclone' : null;
  const lulcLayer = useViewStore((s) => s.project?.bhuvan_layers?.lulc ?? null);
  // The GetLegendGraphic image failed to load: say so rather than leave a gap.
  const [legendFailed, setLegendFailed] = useState(false);

  // Local, not store state: this is a disclosure toggle on one panel, with no
  // bearing on the scene and nothing else to coordinate with.
  //
  // Null means "follow the mode": open in city view, where the key explains the
  // massing the user is looking at, and closed once a building is selected and
  // the DetailPanel is carrying the provenance instead. An explicit click wins
  // over that default from then on.
  const [override, setOverride] = useState<boolean | null>(null);
  const provenanceOpen = override ?? mode === 'city';

  const gis2d = useViewStore((s) => s.gis2d);
  const surveyParcels = useDataStore((s) => s.surveyParcels);
  const show22a = useViewStore((s) => s.layers.section22a);
  const section22a = useDataStore((s) => s.section22a);
  const register = section22a?.register ?? null;
  // Read from the data, not assumed. Every row this repository ships is
  // derived; the day scripts/import_survey_parcels.py loads a real register,
  // this key has to stop calling it derived without anyone remembering to
  // come back and edit it.
  const surveyProvenance = (surveyParcels?.features[0]?.properties as
    { provenance?: string } | undefined)?.provenance ?? 'derived';

  // Counted per DISPLAY category, not per stored asset_type, so the section
  // below and the underground panel agree about what "Electrical" contains.
  // Memoised on the collections: the legend re-renders on every selection,
  // and recounting the whole cadastre for a click is wasted work.
  const counts = useMemo(() => {
    const m = new Map<UtilityCategory, number>();
    for (const f of utilities?.features ?? []) {
      const cat = categoryOfAssetType(f.properties.asset_type);
      if (cat) m.set(cat, (m.get(cat) ?? 0) + 1);
    }
    return m;
  }, [utilities]);

  // Counted, not written down: the mix is a property of the loaded data.
  const { provCounts, synthetic } = useMemo(() => {
    const pc = new Map<string, number>();
    let syn = 0;
    for (const f of buildings?.features ?? []) {
      const src = f.properties.height_source;
      pc.set(src, (pc.get(src) ?? 0) + 1);
      if (f.properties.survey_synthetic) syn++;
    }
    return { provCounts: pc, synthetic: syn };
  }, [buildings]);

  return (
    <div data-panel="legend" className="glass pointer-events-auto w-full rounded-lg p-2.5">
      <button
        type="button"
        onClick={() => setOverride(!provenanceOpen)}
        aria-expanded={provenanceOpen}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="panel-title">Provenance key</span>
        <span className="text-[10px] text-[rgb(var(--muted))]">
          {provenanceOpen ? '−' : '+'}
        </span>
      </button>

      {provenanceOpen ? (
        <div className="mt-1.5 space-y-1">
          {PROVENANCES.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <ProvenanceBadge source={p} />
              <span className="ml-auto font-mono text-[10px] text-[rgb(var(--muted))]">
                {provCounts.get(p) ?? 0}
              </span>
            </div>
          ))}
          {/* Its own row because it is its own claim: the badge reads
              "Surveyed plan (demo)" and is not authoritative, which the plain
              surveyed_plan row above does not say. */}
          <div className="flex items-center gap-2">
            <ProvenanceBadge source="surveyed_plan" synthetic />
            <span className="ml-auto font-mono text-[10px] text-[rgb(var(--muted))]">
              {synthetic}
            </span>
          </div>
          <p className="pt-1 text-[9px] leading-snug text-[rgb(var(--muted))]">
            Counts are buildings by height source. Only OSM tag and Surveyed plan
            are authoritative.
          </p>
        </div>
      ) : null}

      {/* The 2D cadastral layer's one line weight, and what it is NOT.
          Present only while that view is on, like every other section here.
          The swatch is inline-styled, which is the data-swatch exemption
          scripts/shoot.mjs's chrome audit relies on -- though this one is grey
          either way, because the parcel layer carries no hue to key. */}
      {gis2d ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">Cadastral parcels</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="flex h-2 w-4 shrink-0 items-center">
              <span
                className="w-full rounded-full"
                style={{
                  height: `${SURVEY_PARCEL_VIEW.OUTLINE_PX}px`,
                  background: MATERIALS.surveyParcelOutline.toCssColorString(),
                }}
              />
            </span>
            <span className="flex-1 text-[11px] text-[rgb(var(--ink))]">
              {surveyProvenance === 'survey_dept'
                ? 'Survey parcel boundary'
                : 'Derived parcel boundary'}
            </span>
            <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
              {surveyParcels?.features.length ?? 0}
            </span>
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            {surveyProvenance === 'survey_dept'
              ? 'Boundaries as supplied by the issuing survey department; the '
                + 'panel names the source and its date.'
              : 'Unofficial. Voronoi plots around clustered OpenStreetMap '
                + 'footprints, clipped to road corridors. The number in each '
                + 'plot is a per-project ordinal, NOT a survey number, a TS '
                + 'number or a Bhu-Aadhaar.'}
          </p>
        </div>
      ) : null}

      {/* Section 22A, keyed only while the layer is on.
          The swatch is inline-styled -- the data-swatch exemption
          scripts/shoot.mjs's chrome audit relies on -- so the key carries the
          same crimson the map does. It is drawn as a hatched block over a
          heavy rule because that is exactly what is on the ground: a marking
          inside a strong boundary.

          THE COUNTS ARE TWO NUMBERS, NOT ONE. A register entry this project
          cannot place is still a prohibition, and a legend that printed only
          what it drew would quietly under-report the list. */}
      {show22a ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">22A restricted land</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3 w-4 shrink-0 rounded-[2px]"
              style={{
                // The hatch and the boundary, drawn the way the map draws them:
                // stripes inside a heavy rule. An inset shadow rather than a
                // border, so the 4 px swatch keeps its full width for the fill.
                background: `repeating-linear-gradient(45deg, ${SECTION_22A_HEX}88 0 2px, transparent 2px 5px)`,
                boxShadow: `inset 0 0 0 1.5px ${SECTION_22A_HEX}`,
              }}
            />
            <span className="flex-1 text-[11px] text-[rgb(var(--ink))]">
              Restricted / prohibited parcel
            </span>
            <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
              {section22a?.features.length ?? 0}
            </span>
          </div>
          {register && register.unlocated_count > 0 ? (
            <div className="mt-1 flex items-center gap-2">
              <span aria-hidden="true" className="h-3 w-4 shrink-0" />
              <span className="flex-1 text-[11px] text-[rgb(var(--muted))]">
                Listed, but not located in this area
              </span>
              <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
                {register.unlocated_count}
              </span>
            </div>
          ) : null}
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            {register && !register.authoritative
              ? `${SECTION_22A_MOCK_NOTE} ${SECTION_22A_DISCLAIMER}`
              : `Source: ${register?.source_label ?? 'unknown'}`
                + `${register?.retrieved_on ? `, read ${register.retrieved_on}` : ''}. `
                + SECTION_22A_DISCLAIMER}
          </p>
        </div>
      ) : null}

      {/* Streets are keyed only when they are on screen and there is no
          underground view competing for the space. */}
      {showRoads && !underground && (roads?.features.length ?? 0) > 0 ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">Streets</div>
          <div className="mt-1.5 space-y-1">
            {ROAD_KEY.map(({ cls, label }) => (
              <div key={cls} className="flex items-center gap-2">
                <span className="flex h-2 w-4 shrink-0 items-center">
                  <span
                    className="w-full rounded-full"
                    style={{
                      height: `${Math.max(1, ROAD_STYLE[cls].width - 1)}px`,
                      background: ROAD_COLOR[cls].toCssColorString(),
                    }}
                  />
                </span>
                <span className="flex-1 text-[11px] text-[rgb(var(--ink))]">{label}</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            Line weight is the road hierarchy. Centrelines from OpenStreetMap;
            street references and unnamed-street labels are derived.
          </p>
        </div>
      ) : null}

      {/* The derived hazard grading. Keyed whenever the ground is painted,
          because a four-class ramp with no key is a code with no meaning --
          and because the reader has to be told, here and not in a tooltip,
          that these classes are computed from the terrain rather than read
          off an NRSC product. */}
      {hazard ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">{HAZARD_LABEL[hazard]} (derived)</div>
          <div className="mt-1.5 space-y-1">
            {[...RISK_ORDER].reverse().map((cls: RiskClass) => (
              <div key={cls} className="flex items-center gap-2">
                {/* Inline colour: the chrome audit reads computed styles and
                    exempts inline ones, which is what lets a key be coloured
                    inside a monochrome panel. */}
                <span
                  className="h-2 w-4 shrink-0 rounded-sm ring-1 ring-[rgb(var(--edge-strong))]"
                  style={{ background: RISK_HEX[cls] }}
                />
                <span className="flex-1 text-[11px] capitalize text-[rgb(var(--ink))]">
                  {cls}
                </span>
                <span className="text-[10px] text-[rgb(var(--muted))]">
                  {RISK_MEANING[hazard][cls]}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            {HAZARD_DRIVERS[hazard]} {HAZARD_CAVEAT}
          </p>
        </div>
      ) : null}

      {/* ISRO Bhuvan land use, keyed only while the overlay is on. The key is
          the server's own GetLegendGraphic: the class colours are Bhuvan's,
          not ours, so nothing here is invented. Bounded and scrolling: a 1:10k
          LULC legend runs to dozens of classes, and the column must not push
          past the viewport at phone sizes. */}
      {showLulc && lulcLayer ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">Land use (ISRO Bhuvan)</div>
          {legendFailed ? (
            <p className="mt-1.5 text-[10px] text-[rgb(var(--muted))]">
              Legend unavailable from Bhuvan.
            </p>
          ) : (
            <div className="mt-1.5 max-h-44 overflow-y-auto rounded bg-[rgb(var(--tint)/0.06)] p-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={buildLegendUrl(lulcLayer)}
                alt="Bhuvan LULC legend"
                className="h-auto max-w-full"
                loading="lazy"
                onError={() => setLegendFailed(true)}
              />
            </div>
          )}
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            {LULC_NOTE}
          </p>
        </div>
      ) : null}

      {underground ? <DepthSection counts={counts} /> : null}
    </div>
  );
}

/**
 * The strata, in section.
 *
 * Answers the question the underground mode is for -- what is under this
 * ground, and in what order -- in the one form a checkbox list cannot: a
 * vertical scale. Only the categories the user has switched on are drawn, so
 * it stays a reading of the current scene rather than a catalogue.
 *
 * Every number here is read from lib/underground/categories.ts. The depths
 * used to be a hardcoded map in this file, which had already drifted from the
 * generator's and from the data's.
 */
function DepthSection({ counts }: { counts: Map<UtilityCategory, number> }) {
  const enabled = useViewStore((s) => s.undergroundLayers);
  const shown = UNDERGROUND_LAYERS.filter((l) => enabled[l.key]);

  /**
   * Row positions, in pixels.
   *
   * Two things had to be got right and both were wrong. The scale ran to the
   * deepest BAND FLOOR, so switching foundations on (which reach 12 m) squashed
   * the five shallow services -- all within 3 m of each other -- into a couple
   * of pixels. And nothing stopped two rows landing on the same line, so their
   * labels sat on top of each other, which is the exact defect this panel
   * exists to avoid elsewhere.
   *
   * So the scale runs to the deepest NOMINAL shown, and rows are then pushed
   * apart to a minimum spacing. The diagram stays a true ordering with roughly
   * true proportions, and stays readable when two strata are 40 cm apart.
   */
  const H = 116;
  const TOP = 16;
  const MIN_GAP = 13;
  const deepest = shown.reduce((d, l) => Math.min(d, l.band.nominal), -3);
  const rows = shown.map((l) => ({
    layer: l,
    y: TOP + (l.band.nominal / deepest) * (H - TOP - 10),
  }));
  for (let i = 1; i < rows.length; i++) {
    rows[i].y = Math.max(rows[i].y, rows[i - 1].y + MIN_GAP);
  }
  const height = rows.length ? Math.max(H, rows[rows.length - 1].y + 12) : H;

  return (
    <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
      <div className="panel-title">Depth section</div>

      {shown.length === 0 ? (
        <p className="mt-1.5 text-[10px] leading-snug text-[rgb(var(--muted))]">
          No utility layers selected.
        </p>
      ) : (
        <div className="relative mt-1.5" style={{ height }}>
          {/* Ground line. */}
          <div
            className="absolute inset-x-0 border-t border-[rgb(var(--edge-strong))]"
            style={{ top: TOP }}
          />
          <div
            className="absolute left-0 text-[9px] uppercase tracking-wide text-[rgb(var(--muted))]"
            style={{ top: 2 }}
          >
            Ground
          </div>

          {rows.map(({ layer: l, y }) => (
            <div
              key={l.key}
              className="absolute inset-x-0 flex items-center gap-1.5"
              style={{ top: y }}
            >
              <span
                className="h-[3px] w-5 shrink-0 rounded-full ring-1 ring-[rgb(var(--edge-strong))]"
                style={{ background: l.colour }}
              />
              <span className="flex-1 truncate text-[10px] text-[rgb(var(--ink))]">
                {l.label}
              </span>
              <span className="font-mono text-[9px] text-[rgb(var(--muted))]">
                {l.band.nominal.toFixed(1)} m
              </span>
              <span className="w-5 shrink-0 text-right font-mono text-[9px] text-[rgb(var(--muted))]">
                {counts.get(l.key) ?? 0}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 border-t border-[rgb(var(--edge))]/50 pt-2">
        <span className="pulse-conflict h-2 w-4 shrink-0 rounded-full bg-danger" />
        <span className="text-[11px] text-dangerInk">Topology finding</span>
      </div>
      <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
        Strata are drawn at their recorded depth below the local ground surface,
        each in its own corridor so that several can be read at once. Selecting
        one reports where it really is.
      </p>
    </div>
  );
}
