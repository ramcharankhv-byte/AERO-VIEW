/**
 * Wording for the derived hazard-exposure grading.
 *
 * Cesium-free, and separate from lib/cesium/materials.ts (which owns the
 * colours) so the two panels that key this ramp -- the compact one under the
 * Context toggles in LayerPanel, and the full one in Legend -- cannot drift
 * apart in what they claim a class means. Colour comes from RISK_HEX; the
 * words come from here.
 */
import type { HazardKind, RiskClass } from './types';

export const HAZARD_LABEL: Record<HazardKind, string> = {
  flood: 'Flood exposure',
  cyclone: 'Cyclone exposure',
};

/** What each class means, in the terms that actually drove the score. */
export const RISK_MEANING: Record<HazardKind, Record<RiskClass, string>> = {
  flood: {
    low: 'high ground',
    moderate: 'gentle slope',
    high: 'low or hollow',
    severe: 'lowest, near coast',
  },
  cyclone: {
    low: 'sheltered, inland',
    moderate: 'partly exposed',
    high: 'exposed or tall',
    severe: 'ridge, near coast',
  },
};

/** The one-line statement of what the index is computed from. */
export const HAZARD_DRIVERS: Record<HazardKind, string> = {
  flood:
    'Derived from CartoDEM: ground height, depth below the local surroundings '
    + 'within 250 m, and distance to the shoreline.',
  cyclone:
    'Derived from CartoDEM: distance to the shoreline, how exposed the ground '
    + 'is above its surroundings, and building height.',
};

/**
 * The disclaimer that has to travel with the ramp wherever it is keyed.
 *
 * The classes are relative within one AOI and computed here; NRSC's own flood
 * and cyclone layers are national and put this whole neighbourhood in a single
 * class. Saying so is the difference between a derived index and a borrowed
 * authority.
 */
export const HAZARD_CAVEAT =
  'Relative within this AOI, not an NRSC hazard rating — the Bhuvan zone '
  + 'underneath is the national classification and covers the whole area in '
  + 'one class.';
