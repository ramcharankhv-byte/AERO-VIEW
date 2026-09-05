/**
 * Geometry helpers shared by every Cesium layer.
 *
 * The centroid loop lived inline in eight places; keeping one definition here
 * means "centre of a footprint" means the same thing everywhere, and CesiumRoot
 * stops having to know the loop body.
 */

/** Lon/lat centroid of a closed linear ring. Skips the trailing duplicate vertex. */
export function ringCentroid(ring: number[][]): { lon: number; lat: number } {
  const n = Math.max(1, ring.length - 1);
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    x += ring[i][0];
    y += ring[i][1];
  }
  return { lon: x / n, lat: y / n };
}

/**
 * Centroid plus the ring's greatest radius in metres, used by the camera to
 * choose a standoff. Equirectangular at the ring's latitude is accurate to
 * well under a metre for the AOI.
 */
export function ringCentreWithRadius(
  ring: number[][],
): { lon: number; lat: number; radius: number } {
  const { lon, lat } = ringCentroid(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  let radius = 12;
  for (let i = 0; i < ring.length - 1; i++) {
    const dx = (ring[i][0] - lon) * mPerDegLon;
    const dy = (ring[i][1] - lat) * mPerDegLat;
    radius = Math.max(radius, Math.hypot(dx, dy));
  }
  return { lon, lat, radius };
}

/** Closed ring to the flat [lon,lat,lon,lat,...] Cesium expects. */
export function flatLonLat(ring: number[][]): number[] {
  const flat: number[] = [];
  for (let i = 0; i < ring.length - 1; i++) {
    flat.push(ring[i][0], ring[i][1]);
  }
  return flat;
}

/** A vertical run of a utility: one lon/lat, two heights. */
export interface Riser {
  lon: number;
  lat: number;
  z0: number;
  z1: number;
}

/** What a utility centreline can actually be drawn as. */
export interface RunGeometry {
  /**
   * [lon,lat,height,...] for a PolylineVolume, with no two consecutive
   * vertices sharing a horizontal position. Fewer than two positions means
   * there is no sweepable line and the caller should draw only the risers.
   */
  tube: number[];
  /** The vertical sections, which a PolylineVolume cannot represent. */
  risers: Riser[];
}

/**
 * Horizontal collapse threshold, in degrees. ~1 mm at this latitude.
 *
 * Sized against Cesium, not against the data. PolylineVolumeGeometry first
 * runs `arrayRemoveDuplicates` with `Cartesian3.equalsEpsilon`, whose
 * EPSILON10 relative tolerance is about 0.6 mm at ECEF magnitudes, so points
 * further apart than that survive into the sweep. Anything at or below this
 * threshold is what Cesium would treat as coincident once projected, and is
 * exactly what has to be merged here. Deliberately far tighter than the
 * centimetre-scale jitter present throughout the snapshots -- those points
 * are distinct to Cesium and must stay distinct here.
 */
const HORIZ_EPS_DEG = 1e-8;

/**
 * Split a utility centreline into the parts Cesium can actually sweep.
 *
 * WHY THIS EXISTS. `PolylineVolumeGeometry` sweeps a cross-section along a
 * line in the local horizontal frame, so a run's DIRECTION has to be
 * horizontally well defined. Cesium computes the first segment's direction
 * before its main loop and normalises it with no guard:
 *
 *     forward = normalize(subtract(next, position))
 *
 * `scaleToSurface` has already projected both positions onto the geodetic
 * surface and stashed their heights separately, so two vertices that share a
 * lon/lat -- a riser, a vertical drop into a trench -- collapse to the same
 * surface point no matter how far apart they are in Z. Subtracting them gives
 * a zero vector, and normalising that throws
 * "developer error: normalized result is not a number", killing the whole
 * geometry batch. The in-loop guard Cesium does have covers the interior
 * vertices only, never index 0.
 *
 * So the vertical parts are separated out here and handed back as risers for
 * the caller to draw as cylinders, which is the correct primitive for a
 * vertical run anyway. Nothing is discarded: a riser is still drawn, at its
 * true position and depth, just not as a swept volume.
 */
export function planRunGeometry(
  coords: number[][],
  heightOf: (c: number[]) => number,
): RunGeometry {
  const tube: number[] = [];
  const risers: Riser[] = [];
  if (!Array.isArray(coords) || coords.length === 0) return { tube, risers };

  let i = 0;
  while (i < coords.length) {
    const lon = coords[i][0];
    const lat = coords[i][1];
    // Walk the group of consecutive vertices sharing this horizontal position.
    let j = i;
    let zMin = heightOf(coords[i]);
    let zMax = zMin;
    while (
      j + 1 < coords.length
      && Math.abs(coords[j + 1][0] - lon) <= HORIZ_EPS_DEG
      && Math.abs(coords[j + 1][1] - lat) <= HORIZ_EPS_DEG
    ) {
      j++;
      const z = heightOf(coords[j]);
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    // A group of two or more at one lon/lat is a vertical run.
    if (j > i && zMax - zMin > 0) risers.push({ lon, lat, z0: zMin, z1: zMax });
    // One vertex per horizontal position carries into the tube, at the height
    // the line leaves the group with -- the run continues from there.
    tube.push(lon, lat, heightOf(coords[j]));
    i = j + 1;
  }

  // A single horizontal position is a purely vertical line: no tube at all.
  if (tube.length < 6) return { tube: [], risers };
  return { tube, risers };
}

/**
 * Oriented bounding box of a footprint ring, in metres.
 *
 * Used by the gabled roof (to find the ridge direction) and by the DetailPanel
 * "footprint dimensions" row. The principal axis is computed from the points
 * directly, which is robust to non-convex and slightly rotated buildings in a
 * way that the min-area rectangle in EPSG:32644 would not be.
 */
export function orientedDims(
  ring: number[][],
): { lengthM: number; widthM: number; longAxisDeg: number } {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
  // Skip the trailing duplicate vertex, if any.
  const n = Math.max(1, ring.length - 1);

  // Covariance of the metric-centred point cloud.
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const x = (ring[i][0] - cLon) * mPerDegLon;
    const y = (ring[i][1] - cLat) * mPerDegLat;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  sxx /= n; sxy /= n; syy /= n;

  // Principal axis = eigenvector of the larger eigenvalue.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const longAxisRad = theta;

  // Project points onto (cos,sin) and (-sin,cos) to get length/width extents.
  const cosT = Math.cos(longAxisRad);
  const sinT = Math.sin(longAxisRad);
  let minL = Infinity, maxL = -Infinity, minW = Infinity, maxW = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = (ring[i][0] - cLon) * mPerDegLon;
    const y = (ring[i][1] - cLat) * mPerDegLat;
    const l = x * cosT + y * sinT;
    const w = -x * sinT + y * cosT;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
    if (w < minW) minW = w;
    if (w > maxW) maxW = w;
  }
  const lengthM = Math.max(0, maxL - minL);
  const widthM = Math.max(0, maxW - minW);
  // Always report the larger axis as "length" so the UI shows "long × short".
  const longAxisDeg = (lengthM >= widthM ? longAxisRad : longAxisRad + Math.PI / 2) * 180 / Math.PI;
  return {
    lengthM: Math.max(lengthM, widthM),
    widthM: Math.min(lengthM, widthM),
    longAxisDeg,
  };
}

/** Great-circle distance in metres between two lon/lat points. */
export function haversineM(
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// ---------------------------------------------------------------------------
// Floor-view geometry: inset and section.
//
// Both helpers are pure and Cesium-free so they can be unit-tested under
// `node --test` without a WebGL context. They work in a local metric frame
// centred on the ring (equirectangular at the ring's latitude, accurate to
// well under a millimetre over a building footprint) and hand lon/lat back.
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** True when the last vertex repeats the first, as GeoJSON rings do. */
function isClosed(ring: number[][]): boolean {
  const n = ring.length;
  return n > 2 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
}

/** Twice the signed area of a metric point list. Positive = counter-clockwise. */
function signedArea2(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a;
}

/**
 * Shrink a closed ring inward by `metres`, in XY only.
 *
 * Every edge is offset `metres` along its inward normal and consecutive offset
 * lines are intersected, which is an exact inset for the convex rings the unit
 * grid produces -- two flats that share a wall end up separated by a seam
 * 2 x `metres` wide, evenly wide along its whole length. A radial scale toward
 * the centroid would leave that gap wider at the corners than in the middle,
 * which is exactly where a section cut reads it.
 *
 * Nothing here touches Z, and nothing is written back: the DB geometry and the
 * API are untouched. This is a render-time transform.
 *
 * Degenerate results (a unit narrower than twice the inset, a sliver that folds
 * through itself) fall back to a uniform 15% radial shrink, so a pathological
 * footprint loses seam accuracy rather than turning inside out.
 */
export function insetRing(ring: number[][], metres: number): number[][] {
  const closed = isClosed(ring);
  const n = closed ? ring.length - 1 : ring.length;
  if (metres <= 0 || n < 3) return ring.map((p) => [p[0], p[1]]);

  const { lon: cLon, lat: cLat } = ringCentroid(closed ? ring : [...ring, ring[0]]);
  const mLon = mPerDegLon(cLat);
  const toM = (p: number[]): [number, number] => [
    (p[0] - cLon) * mLon,
    (p[1] - cLat) * M_PER_DEG_LAT,
  ];

  const src: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) src.push(toM(ring[i]));

  const area = signedArea2(src);
  if (area === 0) return ring.map((p) => [p[0], p[1]]);
  // Interior is to the left of every edge for a counter-clockwise ring.
  const inward = area > 0 ? 1 : -1;

  /** Each edge, offset inward by `metres`, as a point plus a direction. */
  const lines: Array<{ px: number; py: number; dx: number; dy: number }> = [];
  for (let i = 0; i < n; i++) {
    const [x0, y0] = src[i];
    const [x1, y1] = src[(i + 1) % n];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return radialShrink(ring, closed, cLon, cLat);
    lines.push({
      px: x0 + ((-dy / len) * inward) * metres,
      py: y0 + ((dx / len) * inward) * metres,
      dx,
      dy,
    });
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    const cross = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(cross) < 1e-9) {
      // Collinear neighbours: the offset vertex IS the intersection, to the
      // precision at which the cross product can still resolve one.
      out.push([b.px, b.py]);
      continue;
    }
    const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / cross;
    out.push([a.px + a.dx * t, a.py + a.dy * t]);
  }

  // An inset polygon is strictly smaller than its source and wound the same
  // way. Anything else means the offset lines crossed over each other -- a flat
  // narrower than twice the inset folds through its own centre, which a sign
  // test alone would miss because a point reflection preserves winding.
  const newArea = signedArea2(out);
  const shrank = Math.sign(newArea) === Math.sign(area)
    && Math.abs(newArea) < Math.abs(area)
    && Math.abs(newArea) >= 0.15 * Math.abs(area);
  if (!shrank) return radialShrink(ring, closed, cLon, cLat);

  const degrees = out.map(([x, y]) => [cLon + x / mLon, cLat + y / M_PER_DEG_LAT]);
  if (closed) degrees.push([degrees[0][0], degrees[0][1]]);
  return degrees;
}

/** Fallback for footprints an edge offset would fold: 15% toward the centroid. */
function radialShrink(
  ring: number[][], closed: boolean, cLon: number, cLat: number,
): number[][] {
  const n = closed ? ring.length - 1 : ring.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    out.push([
      cLon + (ring[i][0] - cLon) * 0.85,
      cLat + (ring[i][1] - cLat) * 0.85,
    ]);
  }
  if (closed) out.push([out[0][0], out[0][1]]);
  return out;
}

/**
 * A vertical section plane: a point in lon/lat plus a horizontal unit normal
 * expressed in the local metric frame (nx east, ny north).
 *
 * Cesium's ClippingPlaneCollection attaches only to a Globe, a Model or a
 * Cesium3DTileset. An entity's PolygonGraphics is drawn through a Primitive,
 * which has no clippingPlanes property at all, and every sliceable surface in
 * this app -- floor plates, floor shells, unit volumes, stack slabs -- is
 * entity geometry. So the section is cut on the CPU against this plane, and
 * the plane is defined once, here, so no two layers can disagree about where
 * the cut is.
 */
export interface HalfPlane {
  lon: number;
  lat: number;
  /** Unit normal in metres-east / metres-north. Geometry on the +side is cut away. */
  nx: number;
  ny: number;
}

/**
 * The section plane for a footprint.
 *
 * `axis` names the direction the plane's normal points: 'ew' cuts along a
 * north-south line and opens an east-west section, 'ns' the other way round.
 * `offsetPct` is -100..100 across the footprint's own extent along that normal,
 * so the control reads the same on a 9 m house and a 60 m block.
 */
export function slicePlane(
  ring: number[][], axis: 'ns' | 'ew', offsetPct: number,
): HalfPlane {
  const { lon, lat } = ringCentroid(ring);
  const mLon = mPerDegLon(lat);
  const nx = axis === 'ew' ? 1 : 0;
  const ny = axis === 'ew' ? 0 : 1;

  let half = 1;
  for (let i = 0; i < ring.length; i++) {
    const dx = (ring[i][0] - lon) * mLon;
    const dy = (ring[i][1] - lat) * M_PER_DEG_LAT;
    half = Math.max(half, Math.abs(dx * nx + dy * ny));
  }
  const d = (Math.max(-100, Math.min(100, offsetPct)) / 100) * half;
  return {
    lon: lon + (d * nx) / mLon,
    lat: lat + (d * ny) / M_PER_DEG_LAT,
    nx,
    ny,
  };
}

/**
 * Sutherland-Hodgman clip of a closed ring against a half-plane, keeping the
 * side the normal points AWAY from.
 *
 * A half-plane is convex, so a single pass is exact for convex and concave
 * rings alike (a concave ring the plane crosses twice keeps a zero-width
 * bridge between the surviving parts, which at floor-plate scale reads as the
 * section line it is). Returns [] when the ring is cut away entirely --
 * callers hide the entity rather than hand Cesium a degenerate polygon.
 */
export function clipRingToHalfPlane(ring: number[][], plane: HalfPlane): number[][] {
  const closed = isClosed(ring);
  const n = closed ? ring.length - 1 : ring.length;
  if (n < 3) return [];
  const mLon = mPerDegLon(plane.lat);

  /** Signed distance in metres. Negative is the side that survives. */
  const dist = (p: number[]): number =>
    (p[0] - plane.lon) * mLon * plane.nx + (p[1] - plane.lat) * M_PER_DEG_LAT * plane.ny;

  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const cur = ring[i];
    const nxt = ring[(i + 1) % n];
    const dCur = dist(cur);
    const dNxt = dist(nxt);
    if (dCur <= 0) out.push([cur[0], cur[1]]);
    if ((dCur <= 0) !== (dNxt <= 0)) {
      const t = dCur / (dCur - dNxt);
      out.push([cur[0] + (nxt[0] - cur[0]) * t, cur[1] + (nxt[1] - cur[1]) * t]);
    }
  }
  if (out.length < 3) return [];
  // A plane grazing an edge leaves a zero-area sliver -- three or four points
  // strung along one line. Cesium will happily accept it and draw nothing, but
  // then `survives()` would report a section that is not on screen, so it is
  // reported as cut away here instead.
  const mLat = M_PER_DEG_LAT;
  const metric = out.map((p): [number, number] =>
    [(p[0] - plane.lon) * mLon, (p[1] - plane.lat) * mLat]);
  if (Math.abs(signedArea2(metric)) < 1e-4) return [];

  if (closed) out.push([out[0][0], out[0][1]]);
  return out;
}
