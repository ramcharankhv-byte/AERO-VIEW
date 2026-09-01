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