# AERO-VIEW — 3D ULPIN Vertical Property Mapper

A three-dimensional cadastral viewer, one **project** per area of interest. The
demo project is **Siripuram, Visakhapatnam**; a second, independently generated
AOI (**Banjara Hills Ward, Hyderabad**) proves the pipeline isn't hardcoded to
one place. See [Projects](#projects--data).

Land records are normally drawn flat — one polygon per parcel. Rights are not
flat: a flat on the ninth floor, a parking bay in the basement and a share of
the ground beneath them are three different things stacked on one plot. This
app models the whole vertical stack, from the ground down and up:

```
parcel → building → floor → unit          (above ground)
       → utility corridor, basement       (below ground)
```

and it labels every value on screen with **where it came from** — real,
estimated, derived or synthetic — because a viewer must never be left unsure
which numbers were measured and which were guessed.

![City view](docs/shots/1-city.png)

## The problem

In this AOI, only **8% of buildings carry a real height** in OpenStreetMap.
Almost every storey count you see is an inference from footprint area and
building tag, not a measurement. A 3D cadastre that presented all of that as
equally authoritative would be lying by omission — so instead every figure is
badged with its provenance, in the UI, in the API responses and in the data
model itself, all the way down to per-attribute source tags on a building
record. See [Data & provenance](#data--provenance).

## Features

**Vertical cadastre**
- 3D viewer (CesiumJS) per project, with a gallery at `/` and each project at
  `/p/<slug>`
- Explode / isolate / slice controls to walk the stack: building → floor → unit
- Underground utility corridors (water, sewer, power, telecom, drainage,
  foundations), each in its own depth stratum
- **Topology Validation**: an on-demand 3D check (`ST_3DIntersects` /
  `ST_3DDistance`) for clashes, clearance breaches and airspace encroachments —
  the one place a conflict is reported, run when you ask for it, with findings
  listed, marked in the scene, and summarized in a banner the moment it finds
  something
- ISO 19152 (LADM) rights model: parties, BA-units, and the shares between them
  — a flat, its parking bay and its slice of the plot resolve as one record

**Context and data quality**
- Full provenance model: every value is tagged real / estimated / derived /
  synthetic, surfaced everywhere it's shown
- Hazard exposure grading (flood, cyclone) derived per-building from a real DEM
  surface, alongside NRSC/ISRO Bhuvan's own national-scale WMS overlays
- Section 22A restricted-lands overlay
- Multi-basemap picker (Esri World Imagery, Esri Wayback archive, Mapbox,
  CARTO dark, or none), plus a 2D GIS parcel view

**Access and records**
- Citizen and government sessions: a citizen sees only their own flat; a
  government official sees the full AOI with every control
- Manual editing of building attributes, with the same validation on the
  client and the server
- PDF certificate / deed generation for a unit

**Runs without a database.** Every API route tries PostGIS first and falls
back to committed JSON snapshots in `data/api/<slug>/`, so `npm run dev` alone
renders the full app — gallery included.

## Tech stack

| Layer | Choice |
|---|---|
| App | Next.js 15, React 19, TypeScript |
| 3D / GIS | CesiumJS |
| Database | PostgreSQL + PostGIS 3.4 + SFCGAL (solid geometry) |
| State | Zustand |
| Styling | Tailwind CSS |
| Data pipeline | stdlib Python 3.12+, optional GDAL/rasterio/pyproj for real DEM sampling |
| Cache (optional) | Redis, via `ioredis` |
| Auth | Hand-rolled HMAC-signed session cookies, `bcryptjs` |

## Getting started

```bash
npm install                # also copies Cesium assets into public/cesium
docker compose up -d       # PostGIS 16 + PostGIS 3.4 + SFCGAL
npm run seed               # fetch -> clip DEM -> estimate -> hazard -> seed -> utilities -> roads -> export
npm run dev                # http://localhost:3000
```

Sign in at `/login` — the form offers both roles, and outside production it
prints working demo credentials for a citizen (a resident of the demo tower)
and for government, so there's nothing to look up before you can see the app.

`npm run seed` is stdlib Python; only the DEM clip/sample step
(`scripts/dem.py`) needs third-party tools (`gdalwarp`, `rasterio` or
`gdallocationinfo`, `pyproj`). Without them it says so and every building keeps
a 12.0 m placeholder ground height. To seed with real elevation:

```bash
micromamba create -y -p ./.gdal-env -c conda-forge python=3.12 gdal rasterio pyproj
npm run seed:geo           # = .gdal-env/python scripts/seed.py
```

**The database is optional at runtime**, as above — every response carries an
`x-ulpin-backend: postgis|snapshot` header saying which path served it. If you
already have a PostGIS volume from before multi-project support, migrate it
rather than re-seeding (see `db/migrations/`, applied in order 001 → 007, then
`db/02_functions.sql`, then `SELECT * FROM ladm_backfill(1);`).

## Data & provenance

The provenance distinction is enforced in the data model, not just the prose —
every row carries a source tag, and the UI reads it rather than assuming.

| Layer | Source | Status |
|---|---|---|
| Building footprints, road centrelines | OpenStreetMap (ODbL) | **Real** |
| Storey counts, 8% | `building:levels` / `height` tags | **Real** |
| Storey counts, 90% | area + building-tag heuristic | **Estimated** |
| Storey counts, 4% | `data/surveyed_plans.json` | **Synthetic demo register** |
| Ground elevation, Siripuram | CartoDEM v3, NRSC/ISRO, sampled per footprint | **Real** |
| Ground elevation, Banjara Hills | no DEM tile supplied | **Placeholder** |
| LULC class, hazard zones | NRSC Bhuvan WMS, national scale | **Real**, external, context only |
| Flood / cyclone exposure grading | derived from the CartoDEM surface + coastline | **Derived**, relative within the AOI |
| Parcel boundaries | Voronoi plots around clustered footprints | **Derived, not surveyed** |
| Owners, tenure, encumbrances | generated | **Synthetic** |
| Utility alignments | offsets from road centrelines | **Representative, not as-built** |
| Building names, 59 of 384 | OSM `name` tag | **Real** |
| Building names, 325 of 384 | `lib/mock/`, seeded by building id | **Synthetic** |
| Manual edits | typed into the viewer | **Local, no authority** |

Full detail — exact counts, the hazard-grading formula, DEM datum handling —
lives in `architecture.md` and `HANDOFF.md`, alongside the file map.

### The identifier

```
AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
        e.g. AP-VSP-3D26-0042-007-05-03
```

> This is an unofficial vertical extension of the 14-digit ULPIN
> (Bhu-Aadhaar). It is not an official government identifier, is not issued
> by or registered with any revenue department, and carries no legal weight.

That sentence renders on the ULPIN card in the UI itself, not in a tooltip.

## Projects & data

Each project is one bounding-box AOI, registered in `data/api/projects.json`.
`data/raw_*.geojson` are the OSM extracts a project is built from;
`data/api/<slug>/` is what the app actually serves (committed snapshots,
regenerated by `scripts/05_export_static.py`); `data/projects/<slug>/` holds
per-project raw inputs (DEM tiles, manual edits, the flat register).

## Architecture

See `architecture.md` for the file-by-file map (every component, layer and
lib module, one line each) and `HANDOFF.md` for the engineering history behind
the less obvious decisions — why the underground layers reconcile against
sampled terrain instead of a stored datum, why LADM stores no geometry of its
own, and so on.

## Deployment

Deploys to Vercel (`vercel.json`: region `sin1`, 60 s function timeout on the
API routes and the project viewer page). Required in any multi-instance
deployment:

| Var | Why |
|---|---|
| `SESSION_SECRET` | signs the session cookie; without it, each serverless instance signs with its own random key and login breaks silently |
| `DATABASE_URL` | pooled Postgres connection (PostGIS + SFCGAL); omit it and the app serves the committed snapshots instead |

See `.env.example` for the full list, including optional imagery tokens and
the Redis cache URL.
