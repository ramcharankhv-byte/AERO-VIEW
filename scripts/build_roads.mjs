/**
 * Derive data/api/roads.json from data/raw_highways.geojson.
 *
 * WHY THIS IS A BUILD STEP AND NOT A REQUEST-TIME TRANSFORM
 * --------------------------------------------------------
 * 1. There is no `road` table in db/01_schema.sql. scripts/utilities.sql builds
 *    one as an UNLOGGED temp table and drops it again, so unlike buildings and
 *    parcels there is no PostGIS path for lib/db.ts to prefer. A committed
 *    artefact is honest about that.
 * 2. The STR-### identities and the derived street names get frozen in git and
 *    are reviewable in a diff. Computed per request, a one-line change to the
 *    merge heuristic would silently renumber every street in every shared URL.
 * 3. It matches the existing data/api/*.json convention.
 *
 * WHAT IS REAL AND WHAT IS DERIVED
 * --------------------------------
 * Real: the centreline geometry, the highway class, the OSM `name` tag where
 * one exists, oneway/lanes/surface. Derived: the merge into logical streets,
 * the STR-### reference, the geodesic length, and the NAME of any street OSM
 * never named. `name_source` records which of the last two applies to each
 * street, and the UI reports it. Nothing here overwrites an OSM name.
 *
 * Usage: node scripts/build_roads.mjs [--slug=<project>] [--name="AOI name"]
 *
 * With no arguments this is the demo project, reading the committed extract at
 * data/raw_highways.geojson and writing data/api/siripuram/roads.json. Any
 * other slug reads data/projects/<slug>/raw_highways.geojson and writes
 * data/api/<slug>/roads.json -- the same layout scripts/project.py uses, so
 * this and the Python half of the pipeline agree about where a project's files
 * live without either importing the other.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const argv = process.argv.slice(2);
const opt = (key, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : fallback;
};
const SLUG = opt('slug', 'siripuram');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(SLUG)) {
  console.error(`build_roads: --slug must be lower-case letters, digits and hyphens; got ${SLUG}`);
  process.exit(1);
}
// The demo project's raw extract predates per-project directories and is
// committed where it has always been; moving it would be a rename of committed
// data for no gain. Every other project keeps its inputs together.
const WORK_DIR = SLUG === 'siripuram'
  ? path.join(ROOT, 'data')
  : path.join(ROOT, 'data', 'projects', SLUG);
const AOI_NAME = opt('name', SLUG === 'siripuram' ? 'Siripuram, Visakhapatnam' : SLUG);
const SRC = path.join(WORK_DIR, 'raw_highways.geojson');
const OUT_DIR = path.join(ROOT, 'data', 'api', SLUG);
const OUT = path.join(OUT_DIR, 'roads.json');

/**
 * Classes carried into the viewer.
 *
 * This is the set scripts/utilities.sql:31-33 already treats as "roads worth
 * carrying services", plus `service` -- in Siripuram many service ways are the
 * internal access lanes of the AU campus and the apartment blocks, i.e.
 * genuinely the street a building fronts onto. `footway` is excluded; see the
 * note on RoadClass in lib/types.ts.
 */
const KEEP = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'residential', 'unclassified', 'living_street', 'service',
]);

/** Streets shorter than this are dropped -- AFTER merging, not before. */
const MIN_LENGTH_M = 40;
/** A derived name will not anchor to a named street further away than this. */
const ANCHOR_MAX_M = 250;

// --- geodesy ---------------------------------------------------------------
// Same haversine and same earth radius as lib/geo.ts:107 (R = 6371008.8).
// Duplicated rather than imported because this is a .mjs build script and the
// helper is TypeScript; eight lines is cheaper than a build step for scripts/.
const R = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const lineLength = (line) => {
  let t = 0;
  for (let i = 1; i < line.length; i++) t += haversine(line[i - 1], line[i]);
  return t;
};

// --- read + normalise ------------------------------------------------------
const raw = JSON.parse(readFileSync(SRC, 'utf-8'));
const ways = [];
for (const f of raw.features) {
  const p = f.properties ?? {};
  // OSM writes both `services` and `service`; they mean the same thing here.
  const cls = p.highway === 'services' ? 'service' : p.highway;
  if (!KEEP.has(cls)) continue;
  if (f.geometry?.type !== 'LineString') continue;
  const coords = f.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) continue;

  // OSM lists the local name first in an "A;B" pair, so the first token is the
  // name and the second is kept as an alternate rather than thrown away.
  const rawName = typeof p.name === 'string' ? p.name.trim() : '';
  const parts = rawName ? rawName.split(';').map((x) => x.trim()).filter(Boolean) : [];

  ways.push({
    osm_id: Number(p.osm_id ?? String(f.id ?? '').replace(/\D/g, '')) || 0,
    cls,
    name: parts[0] ?? '',
    alt_name: parts[1] ?? null,
    coords,
    oneway: p.oneway === 'yes' || p.oneway === '-1',
    lanes: p.lanes != null && !Number.isNaN(Number(p.lanes)) ? Number(p.lanes) : null,
    surface: typeof p.surface === 'string' ? p.surface : null,
  });
}

// --- merge into logical streets --------------------------------------------
// Named ways group by name. Unnamed ways group by connectivity, restricted to
// the same class so a residential street cannot absorb a service driveway.
const key7 = (c) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`;

const parent = new Map();
const find = (x) => {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
};
const union = (a, b) => {
  const ra = find(a); const rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
};

const groupKey = new Map(); // way index -> group key
ways.forEach((w, i) => { parent.set(i, i); });

// Connectivity, unnamed same-class ways only.
const endpoints = new Map(); // "cls|coordkey" -> [way index]
ways.forEach((w, i) => {
  if (w.name) return;
  for (const c of [w.coords[0], w.coords[w.coords.length - 1]]) {
    const k = `${w.cls}|${key7(c)}`;
    if (!endpoints.has(k)) endpoints.set(k, []);
    endpoints.get(k).push(i);
  }
});
for (const idxs of endpoints.values()) {
  for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
}

ways.forEach((w, i) => {
  groupKey.set(i, w.name ? `name:${w.name}` : `comp:${find(i)}`);
});

const groups = new Map();
ways.forEach((w, i) => {
  const k = groupKey.get(i);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(w);
});

// --- assemble streets ------------------------------------------------------
/** The dominant class of a merged street, by total length. */
function dominantClass(members) {
  const byClass = new Map();
  for (const m of members) {
    byClass.set(m.cls, (byClass.get(m.cls) ?? 0) + lineLength(m.coords));
  }
  return [...byClass.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const centroidOf = (parts) => {
  let x = 0; let y = 0; let n = 0;
  for (const line of parts) for (const c of line) { x += c[0]; y += c[1]; n++; }
  return [x / n, y / n];
};

let streets = [];
for (const members of groups.values()) {
  const parts = members.map((m) => m.coords);
  const length_m = parts.reduce((t, l) => t + lineLength(l), 0);
  if (length_m < MIN_LENGTH_M) continue;
  const named = members.find((m) => m.name);
  streets.push({
    name: named?.name ?? '',
    alt_name: members.find((m) => m.alt_name)?.alt_name ?? null,
    cls: dominantClass(members),
    parts,
    length_m,
    segments: members.length,
    osm_ids: members.map((m) => m.osm_id).filter(Boolean).sort((a, b) => a - b),
    oneway: members.every((m) => m.oneway),
    lanes: members.find((m) => m.lanes != null)?.lanes ?? null,
    surface: members.find((m) => m.surface)?.surface ?? null,
    centroid: centroidOf(parts),
  });
}

// --- names for the streets OSM never named ---------------------------------
/**
 * A derived name is anchored to the nearest NAMED street and given the suffix
 * its class implies, in the naming convention Visakhapatnam actually uses.
 *
 * This is not a fabricated municipal name and the UI does not present it as
 * one: name_source is 'derived', derived_from names the anchor, and the panel
 * carries a note saying so. The identifier a user can safely quote is the
 * STR-### reference, which claims nothing.
 */
const SUFFIX = {
  motorway: 'Main Road', trunk: 'Main Road', primary: 'Main Road',
  secondary: 'Main Road', tertiary: 'Road',
  residential: 'Cross', living_street: 'Cross', unclassified: 'Cross',
  service: 'Service Lane',
};
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

const namedStreets = streets.filter((s) => s.name);
const unnamed = streets.filter((s) => !s.name);

/** Minimum vertex-to-vertex distance between two streets. Cheap at this size. */
function minDistance(a, b) {
  let best = Infinity;
  for (const la of a.parts) {
    for (const ca of la) {
      for (const lb of b.parts) {
        for (const cb of lb) {
          const d = haversine(ca, cb);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

// Group the unnamed streets by (anchor, suffix) so the ordinals run 1..n
// within each family rather than globally.
const families = new Map();
for (const st of unnamed) {
  let anchor = null;
  let bestD = ANCHOR_MAX_M;
  for (const ns of namedStreets) {
    const d = minDistance(st, ns);
    if (d < bestD) { bestD = d; anchor = ns; }
  }
  st._anchor = anchor ? anchor.name : 'Siripuram';
  const fam = `${st._anchor}|${SUFFIX[st.cls]}`;
  if (!families.has(fam)) families.set(fam, []);
  families.get(fam).push(st);
}
for (const [fam, members] of families) {
  const [anchorName, suffix] = fam.split('|');
  // Ordered west-to-east then south-to-north, so "1st Cross" is genuinely the
  // first one encountered rather than an artefact of file order.
  members.sort((a, b) => (a.centroid[0] - b.centroid[0]) || (a.centroid[1] - b.centroid[1]));
  // "Chinna Waltair Main Road" + "Main Road" would read "... 1st Main Road".
  // When the anchor already ends in the suffix's head noun, drop that trailing
  // phrase from the anchor so the result reads the way a street sign would.
  // No regex: escaping a backslash through this file twice already
  // produced a pattern that silently never matched. endsWith says
  // exactly what is meant and cannot be mis-escaped.
  const suffixHead = suffix.split(' ').pop();
  let base = anchorName;
  for (const tail of [' Main ' + suffixHead, ' ' + suffixHead]) {
    if (base.endsWith(tail)) { base = base.slice(0, -tail.length); break; }
  }
  members.forEach((st, i) => {
    st.name = `${base} ${ordinal(i + 1)} ${suffix}`;
    st.name_source = 'derived';
    st.derived_from = anchorName === 'Siripuram' ? null : anchorName;
  });
}
for (const st of namedStreets) {
  st.name_source = 'osm_name';
  st.derived_from = null;
}

// --- stable ids ------------------------------------------------------------
// Sorted by the smallest OSM way id they contain, so the numbering depends
// only on the source data and not on any ordering inside this script.
streets.sort((a, b) => (a.osm_ids[0] ?? 1e18) - (b.osm_ids[0] ?? 1e18));

const round7 = (c) => [Number(c[0].toFixed(7)), Number(c[1].toFixed(7))];
const features = streets.map((st, i) => {
  const id = i + 1;
  return {
    type: 'Feature',
    id,
    // MultiLineString: a merged street is frequently disjoint on the ground
    // (a dual carriageway, or a name that reappears past a junction).
    geometry: {
      type: 'MultiLineString',
      coordinates: st.parts.map((l) => l.map(round7)),
    },
    properties: {
      id,
      ref: `STR-${String(id).padStart(3, '0')}`,
      name: st.name,
      alt_name: st.alt_name,
      name_source: st.name_source,
      derived_from: st.derived_from,
      cls: st.cls,
      length_m: Number(st.length_m.toFixed(1)),
      segments: st.segments,
      osm_ids: st.osm_ids,
      oneway: st.oneway,
      lanes: st.lanes,
      surface: st.surface,
    },
  };
});

const doc = {
  type: 'FeatureCollection',
  aoi: AOI_NAME,
  _disclaimer:
    'Centreline geometry, highway class and any name marked name_source="osm_name" '
    + 'are from OpenStreetMap (ODbL). Street references (STR-###), merged lengths, '
    + 'and every name marked name_source="derived" are computed by '
    + 'scripts/build_roads.mjs and are NOT municipal street names.',
  features,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(doc), 'utf-8');

const byClass = new Map();
for (const f of features) byClass.set(f.properties.cls, (byClass.get(f.properties.cls) ?? 0) + 1);
const osmNamed = features.filter((f) => f.properties.name_source === 'osm_name').length;
console.log(`data/api/${SLUG}/roads.json: ${features.length} streets `
  + `(${osmNamed} OSM-named, ${features.length - osmNamed} derived), `
  + `${(JSON.stringify(doc).length / 1024).toFixed(0)} KB`);
console.log('  by class: '
  + [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('  total length: '
  + `${(features.reduce((t, f) => t + f.properties.length_m, 0) / 1000).toFixed(2)} km`);
