'use client';

import * as Cesium from 'cesium';

/**
 * Split a layer across a grid of data sources so the frustum can cull it.
 *
 * THE PROBLEM THIS SOLVES. Cesium batches every static entity in a data source
 * into as few primitives as it can -- which is the right default, and is why
 * 2,597 extruded footprints render in roughly one draw call. But culling
 * happens per PRIMITIVE, against that primitive's bounding volume. One
 * primitive spanning the whole AOI has a bounding volume spanning the whole
 * AOI, so it is always inside the frustum: fly down to inspect a single
 * building and the renderer still submits, transforms and depth-tests all
 * 2,597 of them. The zoomed-in view -- the one a user spends most of a session
 * in -- is exactly where the batching stops paying and starts costing.
 *
 * Cutting the layer into a coarse lon/lat grid of data sources gives each
 * bucket its own primitive with its own bounding volume, so the ones behind the
 * camera or off to the side are rejected with a single test. Nothing else
 * changes: entities are constructed identically, tagged identically and picked
 * identically, because a pick returns the entity, not the collection it lives
 * in.
 *
 * WHY COARSE. Every bucket is at least one more draw call, and an empty bucket
 * is pure overhead. The grid is sized so a full one still holds a few hundred
 * entities -- enough for batching to be worth doing -- rather than trying to be
 * a spatial index. This is a culling aid, not a tiling scheme; the tiling
 * scheme is 3D Tiles, and the note in docs/perf/findings.md says when that
 * becomes the right answer.
 *
 * A SECOND BENEFIT, which matters during boot. Adding entities to a data source
 * that is already displayed makes Cesium rebuild that data source's batched
 * geometry. Building 12,101 entities incrementally therefore rebuilds a growing
 * batch over and over. With buckets, each rebuild only covers the bucket
 * currently being filled, so the cost of arriving progressively stops scaling
 * with everything that has already arrived.
 */

/** Grid resolution. 4x4 over a ~1.3 km AOI is a few hundred entities a cell. */
const GRID = 4;

export interface BucketGrid {
  /** The data source a point belongs in. Creates it on first use. */
  forPoint(lon: number, lat: number): Cesium.CustomDataSource;
  /** Every data source created so far. */
  all(): Cesium.CustomDataSource[];
  /** Remove every bucket from the viewer and destroy its entities. */
  dispose(): void;
}

export interface BucketExtent {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Bounding box of a set of lon/lat points, with a hair of margin. */
export function extentOf(points: Iterable<readonly [number, number]>): BucketExtent {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  if (!Number.isFinite(west)) return { west: 0, south: 0, east: 0, north: 0 };
  return { west, south, east, north };
}

/**
 * Create a bucket grid over `extent`, adding data sources to `viewer` lazily.
 *
 * `name` is used as a prefix -- `buildings#5` -- so anything that looks layers
 * up by name (the visibility toggles) can still find them with a startsWith,
 * and so the data sources are identifiable in a debugger.
 */
export function createBucketGrid(
  viewer: Cesium.Viewer,
  name: string,
  extent: BucketExtent,
): BucketGrid {
  const buckets = new Map<number, Cesium.CustomDataSource>();
  const lonSpan = Math.max(1e-9, extent.east - extent.west);
  const latSpan = Math.max(1e-9, extent.north - extent.south);

  const indexFor = (lon: number, lat: number): number => {
    // Clamped rather than wrapped: a point exactly on the eastern or northern
    // edge would otherwise land in a column that does not exist.
    const col = Math.min(GRID - 1, Math.max(0,
      Math.floor(((lon - extent.west) / lonSpan) * GRID)));
    const row = Math.min(GRID - 1, Math.max(0,
      Math.floor(((lat - extent.south) / latSpan) * GRID)));
    return row * GRID + col;
  };

  return {
    forPoint(lon, lat) {
      const key = indexFor(lon, lat);
      let ds = buckets.get(key);
      if (!ds) {
        ds = new Cesium.CustomDataSource(`${name}#${key}`);
        buckets.set(key, ds);
        viewer.dataSources.add(ds);
      }
      return ds;
    },
    all() {
      return [...buckets.values()];
    },
    dispose() {
      for (const ds of buckets.values()) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
      }
      buckets.clear();
    },
  };
}
