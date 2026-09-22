# CLAUDE.md — AERO-VIEW (3D ULPIN Cadastral Viewer)

## Project Overview

A three-dimensional cadastral viewer modeling **parcel → building → floor → unit** vertically, plus underground utility corridors. Demo project: **Siripuram, Visakhapatnam** (`AP-VSP-3D26-*`); second project: **Banjara Hills, Hyderabad** (`TS-HYD-3D26-*`).

The app is a **Next.js 15** + **Cesium** + **React 19** application. It uses **PostgreSQL + PostGIS** (optional; falls back to committed JSON snapshots) and **Redis** for caching.

**Key philosophical rule:** every number on screen carries provenance — whether it's real (surveyed), derived (computed), or synthetic (demo). Never let fabricated data borrow the authority of real data.

---

## Common Commands

```bash
# Development
npm install                  # installs deps + copies Cesium assets to public/cesium
docker compose up -d         # starts PostGIS 16 + Redis
npm run db:schema            # apply schema (only if volume already existed)
npm run dev                  # http://localhost:3000

# Data pipelines
npm run seed                 # full seed: fetch OSM → clip DEM → estimate → hazard → seed → utilities → roads → export
npm run seed:geo             # same but with GDAL toolchain for real ground elevation

# Testing & verification
npx tsc --noEmit             # TypeScript type check
npm test                     # run all unit tests (node --test)
npm run verify:ui            # UI smoke test
npm run check:rwd            # screenshot regression (multiple viewports)

# Database migrations (for existing volumes)
docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 -f - < db/migrations/001_multi_project.sql
# ... subsequent migrations 002–007 as needed
```

---

## Architecture

### Data Flow

```
OSM / Surveyed Plans / DEM / Bhuvan WMS
          ↓
    scripts/seed.py (Python pipeline)
          ↓
    data/api/<slug>/ (GeoJSON snapshots)
          ↓
    lib/db.ts (unifies PostGIS + snapshot fallback)
          ↓
    app/api/p/[slug]/* (Next.js API routes)
          ↓
    components/layers/* (Cesium rendering)
```

**Dual backend:** Every API route answers from **PostGIS first**, falling back to committed JSON in `data/api/<slug>/`. Both paths return identical structures. The response header `x-ulpin-backend: postgis|snapshot` tells which path served it.

### Directory Map

| Path | Purpose |
|------|---------|
| `app/` | Next.js pages (`/`, `/login`, `/p/[slug]`) + API routes (`/api/p/[slug]/*`) |
| `components/globe/` | CesiumRoot (viewer setup), CameraDirector, Picker, Scene |
| `components/layers/` | Layer components: Buildings, FloorStack, Units, Parcels, Roads, Utilities, Conflict, BhuvanOverlay, HazardRisk |
| `components/ui/` | TopBar, LayerPanel, DetailPanel, FloorLadder, ElevationRuler, ActionBar, NavDock, StatusBar, Legend, UlpinCard |
| `lib/` | Core logic: `db.ts`, `store.ts`, `types.ts`, `ulpin.ts`, `hazard.ts`, `ladm.ts`, `geo.ts`, `bhuvan.ts` |
| `lib/cesium/` | Cesium helpers: materials, textures, terrain, sunlight, section plane, basement-lift, building queue |
| `lib/data/` | Schemas (`building-schema.ts`), edits handler |
| `lib/mock/` | Synthetic name/owner generators (deterministic, seeded by building id) |
| `db/` | SQL: `01_schema.sql`, `02_functions.sql`, migrations `001–007` |
| `data/api/<slug>/` | Per-project GeoJSON snapshots served when DB is down |
| `data/projects/<slug>/` | Project inputs: OSM cache, DEM tiles, survey registers, `edits.json` (gitignored) |
| `scripts/` | Python seed pipeline, JS utility scripts (`build_roads.mjs`, `check_*.mjs`, etc.) |

### Critical Design Rules

1. **One store, few writers.** Zustand store holds `{mode, activeBuildingId, isolatedFloor, selectedUnitId, layers, explodeT, theme, underground, …}`. Only `Picker` and UI controls write to it. Layer components are readers.

2. **All camera motion lives in `CameraDirector`.** No `flyTo`, `zoomTo`, or `lookAt` anywhere else.

3. **Colours defined once.** `lib/cesium/materials.ts` is the single source of truth for all visual colors.

4. **Every DetailPanel entity shows provenance.** The user must always know whether a value is real, derived, or synthetic.

5. **Building IDs are globally unique; ULPINs are per-project.** A second project restarts parcel numbering at 0001 — the state/district prefix (`AP-VSP-3D26` vs `TS-HYD-3D26`) keeps them distinct.

6. **Metric geometry built in SQL, not Python.** PostGIS+SFCGAL does extrusion, unit subdivision, utility offsetting, and conflict detection. Python scripts only fetch and attribute. Construction happens in **EPSG:32644** (UTM 44N), transformed back to **EPSG:4326**.

### ULPIN Format

```
AP-VSP-3D26-<parcel4>-<bldg3>-<floor2>-<unit2>
         e.g. AP-VSP-3D26-0042-007-05-03
```

- Floor codes: `00` = ground, `01`–`99` = above, `B1`–`B9` = basements
- Right-truncated for coarser entities (parcel, building)
- This is an **unofficial** vertical extension of 14-digit ULPIN (Bhu-Aadhaar) — never present it as government-issued

### ISO 19152 (LADM) Compliance

Migration 007 adds tables for the four core LADM classes:

| Table | ISO Class | Purpose |
|-------|-----------|---------|
| `la_party` | `LA_Party` | holders, associations, banks, utilities |
| `la_ba_unit` | `LA_BAUnit` | administrative bundle (flat + parking + share) |
| `la_ba_unit_member` | — | membership shares |
| `la_spatial_unit` | `LA_SpatialUnit` | links spatial unit to existing row |
| `la_rrr` | `LA_RRR` | rights, restrictions, responsibilities |

- Registry data (mortgages, taxes, parking allocation) stays in `flat-register.json`, projected into `LA_RRR` on read
- `ladm_backfill(project_id)` refills LADM tables from existing data — idempotent, safe to re-run
- Rights are **redacted per caller**: gov sees everything; citizens see only their own flat's bundle

### Synthetic vs Real Data

| Source | Status |
|--------|--------|
| OSM footprints, road centrelines | **Real** |
| Building storeys (8% with tags) | **Real** (`osm_tag`) |
| Building storeys (90% estimated) | **Estimated** (`estimated`) |
| Ground elevation (Siripuram) | **Real** — CartoDEM v3, EGM96 orthometric |
| Ground elevation (Banjara Hills) | **Placeholder** — 12.0 m default |
| Flood/cyclone zones (Bhuvan) | **Real** external, but national-scale |
| Flood/cyclone exposure grading | **Derived** locally, not an NRSC rating |
| Parcel boundaries | **Derived** (Voronoi around footprints) |
| Owners, tenure, encumbrances | **Synthetic** demo |
| Section 22A register | **Demonstration register** — never claim authority |
| Manual edits | **Local, no authority** |

The `detect_source` field threads through every API response and the DetailPanel renders a provenance badge. Never let fabricated data borrow the authority of real data.

---

## Data Files Reference

| File | Content |
|------|---------|
| `data/api/projects.json` | Project registry (gallery data) |
| `data/api/<slug>/buildings.json` | Building footprints GeoJSON |
| `data/api/<slug>/detail.json` | Building + floor + unit detail (keyed by building ID) |
| `data/api/<slug>/parcels.json` | Parcel boundaries |
| `data/api/<slug>/utilities.json` | Utility corridor centrelines |
| `data/api/<slug>/conflicts.json` | Flagged 3D intersection violations |
| `data/api/<slug>/roads.json` | Merged street centrelines |
| `data/api/<slug>/section-22a.json` | Restricted lands register |
| `data/projects/<slug>/flat-register.json` | Mortgage, tax, parking allocation per flat |
| `data/projects/<slug>/dem.tif` | Clipped DEM tile (committed; `dem_raw.tif` is gitignored) |
| `data/projects/<slug>/edits.json` | Manual edits (gitignored) |

---

## Adding New Data (Example: Siripuram 3D Cadastre)

When replacing or adding building data from external GeoJSON:

1. **Cross-check** existing `data/api/<slug>/buildings.json` and `detail.json` against new data
2. **Preserve** existing building metadata (name, ground_elev, risk scores) unless deliberately replacing
3. **Add floor-level units** to `detail.json` under new building IDs (use offset IDs like `10000 + building_id` to avoid collision)
4. **Mark as provisional** (`provisional: true`, `survey_synthetic: true`) when data来源 is synthetic/demo
5. **Verify** coordinates, Z-ranges, and unit counts match between both files
6. **Commit** on a feature branch, not main

---

## Testing

```bash
# All unit tests
npm test

# Single test file
node --test lib/ulpin.test.ts

# Type checking
npx tsc --noEmit

# UI regression screenshots
npm run check:rwd
```

Tests are in `lib/*.test.ts` and cover: ULPIN encoding, geo operations, basement lift logic, LADM projection, Section 22A resolution, topology checks.

---

## Important Notes

- **Cesium version**: pinned at `1.126.0`. Assets copied to `public/cesium/` by `postinstall` script. `CESIUM_BASE_URL` set in `lib/cesium/base-url.ts`.
- **React StrictMode disabled** (`reactStrictMode: false`) — required because Cesium's Viewer doesn't tolerate double-mount in dev.
- **No environment variables required** for basic operation. Optional: `NEXT_PUBLIC_CESIUM_TOKEN` (terrain), `NEXT_PUBLIC_MAPBOX_TOKEN` (Mapbox satellite), `WAYBACK_RELEASE` (historical imagery).
- **ESLint deprecated** in this Next.js version — type checking via `tsc` is the primary validation.
- **Lockfile warning**: a stray `package-lock.json` at `C:\Users\sampa\` root causes workspace root inference warnings. Safe to ignore or remove.
