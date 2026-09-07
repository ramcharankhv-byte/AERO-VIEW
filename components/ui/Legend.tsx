'use client';

import { useState } from 'react';
import { useDataStore, useViewStore } from '@/lib/store';
import {
  MATERIALS, RISK_HEX, ROAD_COLOR, ROAD_STYLE, SURVEY_PARCEL_VIEW,
  USE_TYPE_LABEL, USE_WALL_HEX,
} from '@/lib/cesium/materials';
import {
  UNDERGROUND_LAYERS, categoryOfAssetType, type UtilityCategory,
} from '@/lib/underground/categories';
import { PROVENANCES } from '@/lib/stats';
import { buildLegendUrl, LULC_NOTE } from '@/lib/bhuvan';
import {
  HAZARD_CAVEAT, HAZARD_DRIVERS, HAZARD_LABEL, RISK_MEANING,
} from '@/lib/hazard';
import { RISK_ORDER } from '@/lib/types';
import type { RiskClass, RoadClass, UseType } from '@/lib/types';
import { ProvenanceBadge } from './Provenance';

/**
 * The three street weights worth keying.
 *
 * Not all nine classes: the key exists to explain that line weight encodes
 * hierarchy, which three examples do better than an exhaustive list.
 */
/**
 * The order the use-type key is read in: commonest first for this AOI, so the
 * colour a viewer is looking at is the one at the top. Not alphabetical --
 * `commercial` would lead a key for a ward that is 99% residential.
 */
const USE_ORDER: UseType[] = ['residential', 'commercial', 'institutional', 'industrial'];

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
  const showBuildings = useViewStore((s) => s.layers.buildings);
  const buildingStyle = useViewStore((s) => s.buildingStyle);
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
  // Read from the data, not assumed. Every row this repository ships is
  // derived; the day scripts/import_survey_parcels.py loads a real register,
  // this key has to stop calling it derived without anyone remembering to
  // come back and edit it.
  const surveyProvenance = (surveyParcels?.features[0]?.properties as
    { provenance?: string } | undefined)?.provenance ?? 'derived';

  // Counted per DISPLAY category, not per stored asset_type, so the section
  // below and the underground panel agree about what "Electrical" contains.
  const counts = new Map<UtilityCategory, number>();
  for (const f of utilities?.features ?? []) {
    const cat = categoryOfAssetType(f.properties.asset_type);
    if (cat) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }

  // Counted, not written down: the mix is a property of the loaded data.
  const useCounts = new Map<UseType, number>();
  for (const f of buildings?.features ?? []) {
    const u = f.properties.use_type;
    useCounts.set(u, (useCounts.get(u) ?? 0) + 1);
  }

  const provCounts = new Map<string, number>();
  let synthetic = 0;
  for (const f of buildings?.features ?? []) {
    const src = f.properties.height_source;
    provCounts.set(src, (provCounts.get(src) ?? 0) + 1);
    if (f.properties.survey_synthetic) synthetic++;
  }

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

      {/* What the four façade colours mean.
          Keyed whenever the masses are on screen: at city scale the surface of
          a building IS its use type, and a four-colour code with no key is a
          code with no meaning. Suppressed underground (the masses are dimmed
          to a tenth there and the strata key needs the space) and in Photoreal
          (Google's mesh is photography, and none of these colours is on it).

          Counted from the loaded data rather than written down, like the
          provenance key above: a use type that does not occur in this project
          is not offered as if it did. Every swatch sets its colour INLINE --
          scripts/shoot.mjs's chrome audit fails a coloured element inside a
          panel unless it does, which is exactly the data-swatch exemption. */}
      {showBuildings && !underground && buildingStyle !== 'photoreal' && useCounts.size > 0 ? (
        <div className="mt-2 border-t border-[rgb(var(--edge))]/50 pt-2">
          <div className="panel-title">Building use</div>
          <div className="mt-1.5 space-y-1">
            {USE_ORDER.filter((u) => useCounts.has(u)).map((u) => (
              <div key={u} className="flex items-center gap-2">
                <span
                  className="h-2 w-4 shrink-0 rounded-sm ring-1 ring-[rgb(var(--edge-strong))]"
                  style={{ background: USE_WALL_HEX[u] }}
                />
                <span className="flex-1 text-[11px] text-[rgb(var(--ink))]">
                  {USE_TYPE_LABEL[u]}
                </span>
                <span className="font-mono text-[10px] text-[rgb(var(--muted))]">
                  {useCounts.get(u)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
            Façade colour and window pattern are drawn from the use type; they
            are illustrative, not a photograph of the building.
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
        <span className="text-[11px] text-dangerInk">Basement conflict</span>
      </div>
      <p className="mt-1.5 text-[9px] leading-snug text-[rgb(var(--muted))]">
        Strata are drawn at their recorded depth below the local ground surface,
        each in its own corridor so that several can be read at once. Selecting
        one reports where it really is.
      </p>
    </div>
  );
}
