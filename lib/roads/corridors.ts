/**
 * How wide a street is ON THE GROUND, per class, in metres.
 *
 * This is a DIFFERENT quantity from `ROAD_STYLE` in `lib/cesium/materials.ts`,
 * and conflating the two would be a quiet error. `ROAD_STYLE.width` is a
 * SCREEN-PIXEL line width: it decides how thick a centreline is drawn and is
 * constant as you zoom, because a 3 px residential street has to stay legible
 * at every camera height. The numbers here are real-world corridor widths in
 * metres, used to cut land out of a parcel. A screen width used as a metric
 * width would carve a 3 m strip out of a highway and a 7 m strip out of a lane.
 *
 * WHERE THESE COME FROM. The task that introduced them says to use "the class
 * widths already implied in scripts/utilities.sql". There are none:
 * `utilities.sql` carries per-asset DEPTHS and lateral OFFSETS (water -1.5 m at
 * +3.0 m, sewer -3.0 m at -3.5 m, and so on), which describe where a pipe sits
 * beside a centreline, not how much land the street occupies. So they are
 * stated here, once, instead. They are estimates of a typical Indian urban
 * cross-section -- carriageway plus shoulder and drain -- not a survey of any
 * particular street, which is why the parcels built from them are marked
 * `derived` and never `survey_dept`.
 *
 * STATED TWICE, ASSERTED ONCE. `scripts/survey_parcels.sql` carries the same
 * table as a VALUES list, because PostGIS cannot import a TypeScript module and
 * the clip has to happen in SQL where the geometry is. `lib/survey-parcel.test.ts`
 * reads both files and fails if the two ever disagree -- the same discipline
 * `lib/ulpin.test.ts` applies to `ulpin_fmt()`.
 *
 * NOT IN `materials.ts`, though the task suggests "materials.ts-adjacent",
 * because that module imports Cesium, which touches `window` at load, and this
 * one is imported by a `node --test` unit test that has no DOM.
 *
 * FOOTWAYS AND PATHS ARE ABSENT, deliberately. `RoadClass` covers the nine
 * classes `scripts/build_roads.mjs` keeps, and a pavement or park path is not a
 * corridor that separates one plot from the next -- it runs THROUGH plots.
 * Cutting parcels along footways would shred them for no cadastral reason.
 */
import type { RoadClass } from '@/lib/types';

/**
 * Full corridor width, metres, kerb to kerb plus verge.
 *
 * A parcel is cut back by HALF of this on each side of the centreline, which
 * is what `roadHalfWidthM` returns and what the SQL buffers by.
 */
export const ROAD_CORRIDOR_M: Record<RoadClass, number> = {
  motorway: 24,
  trunk: 20,
  primary: 18,
  secondary: 14,
  tertiary: 11,
  residential: 8,
  unclassified: 8,
  living_street: 7,
  service: 5,
};

/**
 * Half-width for a raw OSM `highway` tag value, metres, or `null` for a class
 * this layer does not treat as a street.
 *
 * Returns null rather than a default so an unrecognised tag is visibly not a
 * corridor instead of silently becoming a residential one. `survey_parcels.sql`
 * makes the same choice by inner-joining its VALUES list, which drops the row.
 */
export function roadHalfWidthM(cls: string): number | null {
  // OSM writes both `services` and `service` for the same thing.
  // scripts/build_roads.mjs:102 folds them together before roads.json is
  // written, and scripts/survey_parcels.sql folds them on its join, so this
  // does too -- the argument is documented as a RAW tag value and a caller
  // handing over an unfolded one should not silently get "not a street".
  const key = cls === 'services' ? 'service' : cls;
  const w = (ROAD_CORRIDOR_M as Record<string, number | undefined>)[key];
  return w === undefined ? null : w / 2;
}

/**
 * The sliver threshold, m². A clipped cell smaller than this is dissolved into
 * the neighbour it shares the longest boundary with rather than kept as a
 * parcel of its own.
 *
 * 25 m² is a 5 x 5 m square. Below that a cell is an artefact of two road
 * buffers meeting at an angle, not a plot anyone could stand a building on.
 */
export const SLIVER_MIN_SQM = 25;
