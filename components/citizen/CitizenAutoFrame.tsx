'use client';

import { useEffect, useRef } from 'react';
import { useViewStore } from '@/lib/store';

/**
 * The citizen's automatic framing.
 *
 * On a citizen session, the user opens the page, and the camera is
 * already on the right place:
 *   - The active building is theirs.
 *   - The mode is 'floor', the isolated floor is theirs.
 *   - Their flat is selected -- UnitsLayer renders the selected unit
 *     in a different colour.
 *
 * What it deliberately does NOT do is switch the underground view on.
 * It used to, so that the basements (parking, water riser, sewer tank)
 * were visible on first paint. That made a subsurface scene -- globe
 * translucency, the camera dropped to a shallow 18-degree pitch beneath
 * the surface -- the FIRST thing a citizen ever saw, before they had
 * asked for it. Underground stays a thing the user turns on from the
 * ActionBar, in both roles; a citizen opens on the ordinary view of
 * their own floor.
 *
 * This is the only piece of UI that looks at the citizen's session;
 * the rest of the scene is the same as the government view, with the
 * data filter (Phase 3) already restricting the cadastre to one
 * building.
 *
 * Effect dependencies: only the role is checked. A logout that flips
 * the role back to anon should leave the camera where the user put
 * it -- a navigation away and back is the explicit recovery path,
 * not a reactive "snap back to city" that would surprise a user who
 * has just logged out mid-tour.
 *
 * The selectedUnitId is written via setState() rather than selectUnit():
 * selectUnit() also flips the mode to 'unit' (camera zooms into the
 * flat), which is the wrong framing for a citizen who wants to see
 * the whole floor with their flat marked.
 */
type Me =
  | { role: null }
  | { role: 'gov' }
  | { role: 'citizen'; slug: string; buildingId: number; floor: number; unit: string };

type BuildingDetail = {
  floors: Array<{ id: number; level_no: number }>;
  units: Array<{ id: number; floor_id: number; level_no: number; unit_no: string }>;
};

export default function CitizenAutoFrame() {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch('/api/me', { credentials: 'same-origin' });
        const me = (await meRes.json()) as Me;
        if (cancelled) return;
        // Recorded for EVERY role, before the citizen-only work below: the
        // panel asks this to decide whether to offer an Edit button, and a
        // gov session has to answer "gov" rather than stay null.
        useViewStore.getState().setSession(
          me.role === 'citizen'
            ? { role: 'citizen', floor: me.floor, unit: me.unit }
            : { role: me.role ?? null, floor: null, unit: null },
        );
        if (me.role !== 'citizen') return;
        // PROJECT-SCOPED, not the unscoped alias. `/api/building/:id` resolves
        // against the demo project whatever the session says, so a citizen on
        // any other project used to get a 404 here and no framing at all.
        const slug = useViewStore.getState().projectSlug ?? me.slug;
        const detailRes = await fetch(
          `/api/p/${slug}/building/${me.buildingId}`,
          { credentials: 'same-origin' },
        );
        if (!detailRes.ok) return;
        const detail = (await detailRes.json()) as BuildingDetail;
        // The session is the source of truth for which flat; the API
        // call is only to translate (floor, unit_no) into a numeric id
        // the renderer can match.
        const myFloor = detail.floors.find((f) => f.level_no === me.floor);
        const myUnit = myFloor
          ? detail.units.find((u) => u.floor_id === myFloor.id && u.unit_no === me.unit)
          : null;
        if (cancelled) return;
        firedRef.current = true;
        // selectBuilding() also flips the mode to 'building', which is
        // the correct next state -- the camera will frame the whole
        // building before isolateFloor() drops to the floor level.
        useViewStore.getState().selectBuilding(me.buildingId);
        useViewStore.getState().isolateFloor(me.floor);
        if (myUnit) {
          useViewStore.setState({ selectedUnitId: myUnit.id });
        }
      } catch {
        /* not signed in or backend hiccup -- leave the view alone */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return null;
}
