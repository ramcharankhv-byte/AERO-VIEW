# Demonstration: Visakhapatnam infrastructure and the underground redesign

Ten minutes, no database, no network beyond the basemap.

```bash
npm run dev
# then sign in at http://localhost:3000/login
```

Everything below is a link. The viewer keeps its whole state in the query
string, so each step is also a bookmark you can hand to someone else.

---

## 1. The two structures

| | |
|---|---|
| **Railway station** | <http://localhost:3000/p/vizag-infra?site=vskp-railway-station> |
| **Flyover** | <http://localhost:3000/p/vizag-infra?site=telugu-thalli-flyover> |

Both are also offered by the **siripuram** project, which is the same city:

| | |
|---|---|
| **Station, in Siripuram** | <http://localhost:3000/p/siripuram?site=vskp-railway-station> |
| **Flyover, in Siripuram** | <http://localhost:3000/p/siripuram?site=telugu-thalli-flyover> |

A site is not bounded by the project's own AOI — the navigator flies to the
structure's anchor and the terrain is sampled over the structure's own extent —
so a project can offer a landmark that stands outside the ground its cadastre
covers. The definition lives in one place and is mirrored by
`npm run build:vizag`.

Both open from the **Infrastructure** panel, top left. Opening a site is what
fetches and builds it — nothing is in the scene until you ask for it, and
closing one tears it down.

Orbit with the left mouse button, zoom with the wheel, tilt with the right
button or ctrl-drag. **Click any part** — a platform, a shelter, a pillar — and
the right-hand card names it and gives its identifier.

Straight to one pillar:
<http://localhost:3000/p/vizag-infra?site=telugu-thalli-flyover&cmp=TTF-P-014>

### What is real here

The card separates the two, and this is the point of it:

- **CITED** — published or mapped. The platform outlines, their numbering and
  the station point come from OpenStreetMap; the platform count, station area,
  elevation and opening dates are published figures; the flyover's two
  carriageway alignments and its 1,448 m length are mapped, and its lane count
  and opening year published.
- **DERIVED** — ours. Shelters, foot over bridges, track positions, the station
  building, deck level, ramp gradients, the 30 m span spacing, and every
  identifier such as `TTF-P-014`.

No station drawing, bridge schedule or survey was consulted, and the card says
so in words rather than leaving you to infer it.

---

## 2. Underground

<http://localhost:3000/p/vizag-infra?site=telugu-thalli-flyover&ug=1&ugl=wse>

That link opens Underground mode with **water, sewerage and electrical** on.
The ground goes translucent, the buildings fade, and the surface detail that is
not the subject drops away.

In the **Underground infrastructure** panel:

- tick categories one at a time — each is drawn in its own corridor at its own
  depth, so several read at once instead of merging into one smear;
- **All** / **None**;
- the **Depth section** below shows the strata in order with their depths.

A category is only built the first time you tick it. Turn one off and it is
hidden, not thrown away.

**Click a pipe.** The card gives its type, identifier, recorded depth,
diameter, material, authority and status — and, when the viewer has moved it
to keep the view legible, a *Drawn for clarity* note saying by how much and in
which direction, ending with *the stored coordinates are unchanged*.

---

## 3. The problem this fixes

Open the same mode on the older project, which has real relief:

<http://localhost:3000/p/siripuram?ug=1&ugl=wse>

`scripts/utilities.sql` bakes **one** ground elevation — the AOI mean — into
every vertex of every run. Over Siripuram's 63 m of relief that put a large
part of the "1 m deep" network above the ground it was supposed to be under.
Measure it either way:

```bash
npm run check:ug          # offline, against the cadastre's own elevations
npm run verify:ui         # in a browser, against real terrain
```

| | before | after |
|---|---|---|
| power, median depth below local ground | −0.4 m (recorded −1.0) | **−1.0 m** |
| power, spread of that depth | 31 m | **~5 m** |
| vertices drawn above ground | 41.8 % | **0.2 %** |
| in-browser, near the camera | — | median −1.47 m, spread **0.83 m** |

---

## 4. Rebuilding the data

```bash
npm run build:infra    # OSM extracts  -> the two site specifications
npm run build:vizag    # the specs     -> the vizag-infra project snapshot
```

The OSM extracts are committed under `data/infra/osm/` with the query that
produced them, the date and the licence (© OpenStreetMap contributors, ODbL).
Re-running the first command re-derives both structures from that geometry, so
a corrected map becomes a corrected model.

---

## Notes

- Siripuram carries **no utility/basement conflicts**. The two planted ones
  were removed on request. The seeded conflict machinery is untouched and
  still exercised — `hyderabad-banjara` has 80 — but it is no longer
  surfaced automatically anywhere; **Topology Validation** (Layers panel) is
  now the one place a conflict is reported, on demand, for any project.
- `npm run smoke` cannot pass on this branch: it has no session handling and
  the viewer redirects anonymous visitors to `/login`. Pre-existing, unrelated
  to this work.
- `npm start` (production server) 400s on `/_next/static/*` on Windows when the
  project path contains a space — as `C:\Aero View` does. `npm run build`
  itself is clean. Use `npm run dev` for the demonstration.
