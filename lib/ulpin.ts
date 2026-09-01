/**
 * ULPIN — vertical extension format.
 *
 *     AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
 *
 * Right-truncated for coarser entities, so a parcel is the first four groups,
 * a building five, and so on. Floor codes: '00' ground, '01'..'99' above,
 * 'B1'..'B9' basements.
 *
 * IMPORTANT: this is an UNOFFICIAL vertical extension of the 14-digit ULPIN
 * (Bhu-Aadhaar) land parcel identifier. It is NOT an official government
 * identifier and is not issued by, registered with, or recognised by any
 * revenue department. See DISCLAIMER below, which the UI renders verbatim.
 *
 * Mirrors ulpin_fmt() in db/02_functions.sql byte for byte.
 */

export const ULPIN_PREFIX = 'AP-VSP-3D26';

export const DISCLAIMER =
  'Unofficial vertical extension of the 14-digit ULPIN (Bhu-Aadhaar). ' +
  'Not an official government identifier.';

export interface UlpinParts {
  parcel: number;
  building?: number;
  floor?: number;
  unit?: number;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** Encode a level number as its two-character floor code. */
export function floorCode(level: number): string {
  return level < 0 ? `B${Math.abs(level)}` : pad(level, 2);
}

/** Decode a two-character floor code back to a signed level number. */
export function parseFloorCode(code: string): number {
  return code.startsWith('B') ? -Number(code.slice(1)) : Number(code);
}

/**
 * Build a ULPIN, truncating at the first omitted level.
 * generate(42)          -> AP-VSP-3D26-0042
 * generate(42, 7)       -> AP-VSP-3D26-0042-007
 * generate(42, 7, -2)   -> AP-VSP-3D26-0042-007-B2
 * generate(42, 7, 5, 3) -> AP-VSP-3D26-0042-007-05-03
 */
export function generate(
  parcel: number,
  building?: number,
  floor?: number,
  unit?: number,
): string {
  let out = `${ULPIN_PREFIX}-${pad(parcel, 4)}`;
  if (building === undefined || building === null) return out;
  out += `-${pad(building, 3)}`;
  if (floor === undefined || floor === null) return out;
  out += `-${floorCode(floor)}`;
  if (unit === undefined || unit === null) return out;
  return `${out}-${pad(unit, 2)}`;
}

/** Parse a ULPIN back into its parts, or null if it is not one of ours. */
export function parse(ulpin: string): UlpinParts | null {
  if (typeof ulpin !== 'string') return null;
  const t = ulpin.trim().toUpperCase();
  const m = t.match(
    /^AP-VSP-3D26-(\d{4})(?:-(\d{3})(?:-(B\d|\d{2})(?:-(\d{2}))?)?)?$/,
  );
  if (!m) return null;
  const parts: UlpinParts = { parcel: Number(m[1]) };
  if (m[2] !== undefined) parts.building = Number(m[2]);
  if (m[3] !== undefined) parts.floor = parseFloorCode(m[3]);
  if (m[4] !== undefined) parts.unit = Number(m[4]);
  return parts;
}

/** Which cadastral level a ULPIN addresses. */
export function levelOf(ulpin: string): 'parcel' | 'building' | 'floor' | 'unit' | null {
  const p = parse(ulpin);
  if (!p) return null;
  if (p.unit !== undefined) return 'unit';
  if (p.floor !== undefined) return 'floor';
  if (p.building !== undefined) return 'building';
  return 'parcel';
}

/** The ULPIN of the containing entity, or null at parcel level. */
export function parentOf(ulpin: string): string | null {
  const p = parse(ulpin);
  if (!p) return null;
  if (p.unit !== undefined) return generate(p.parcel, p.building, p.floor);
  if (p.floor !== undefined) return generate(p.parcel, p.building);
  if (p.building !== undefined) return generate(p.parcel);
  return null;
}

/** Human label for a floor level, matching the ladder rungs. */
export function levelLabel(level: number, topLevel?: number): string {
  if (level < 0) return `B${Math.abs(level)}`;
  if (level === 0) return 'G';
  if (topLevel !== undefined && level === topLevel) return 'R';
  return String(level);
}

export const PROVENANCE_LABEL: Record<string, string> = {
  osm_tag: 'OSM tag (mapped)',
  surveyed_plan: 'Surveyed plan',
  dsm_dem: 'DSM/DEM derived',
  estimated: 'Estimated',
};

/** Estimated data is explicitly not authoritative; the UI colours it apart. */
export const PROVENANCE_IS_AUTHORITATIVE: Record<string, boolean> = {
  osm_tag: true,
  surveyed_plan: true,
  dsm_dem: false,
  estimated: false,
};
