import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findResident } from '@/lib/auth/lookup';
import { buildSetCookie, isHttpsRequest, makeCitizenSession } from '@/lib/auth/session';
import { maskAadhar, maskPhone } from '@/lib/auth/guards';
import { listProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/citizen/login
 *   body: { slug: string, aadhar: string, phone: string }
 *
 * Looks the resident up in data/projects/<slug>/residents.json. On a match
 * a signed session cookie is set and the building / floor claims ride
 * alongside the rest. On any failure the same 401 is returned -- we do not
 * distinguish "no such aadhar" from "phone does not match" so an attacker
 * cannot use the response to enumerate which aadhar numbers are seeded.
 *
 * Both aadhar and phone are validated for shape: 12 digits / 10 digits.
 * Anything else is rejected before the file is read, so a malformed
 * request does not even reach the disk.
 */

const Body = z.object({
  slug: z.string().min(1).max(64),
  aadhar: z.string().regex(/^\d{12}$/, 'aadhar must be 12 digits'),
  phone: z.string().regex(/^\d{10}$/, 'phone must be 10 digits'),
});

export async function POST(req: Request) {
  let payload: z.infer<typeof Body>;
  try {
    const json = await req.json();
    const parsed = Body.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid request', detail: parsed.error.flatten() },
        { status: 400 },
      );
    }
    payload = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid json body' }, { status: 400 });
  }

  // Confirm the project exists. The citizen's slug in the form has to
  // match a project they can actually load. listProjects() is cheap
  // (PostGIS or a snapshot, both already memoised in lib/projects.ts).
  const projects = await listProjects();
  const project = projects.find((p) => p.slug === payload.slug);
  if (!project) {
    return NextResponse.json(
      { error: 'project not found', slug: payload.slug },
      { status: 404 },
    );
  }

  const resident = await findResident(payload.slug, payload.aadhar, payload.phone);
  if (!resident) {
    // Same shape as the "match" path's error would be, deliberately. The
    // status code is 401, not 404, because the user is unauthenticated
    // rather than asking for a non-existent resource.
    return NextResponse.json(
      { error: 'aadhar or phone did not match' },
      { status: 401 },
    );
  }

  const claims = makeCitizenSession({
    aadhar: resident.aadhar,
    name: resident.name,
    slug: payload.slug,
    buildingId: resident.building_id,
    floor: resident.floor,
    unit: resident.unit,
  });

  const setCookie = buildSetCookie(claims, { secure: isHttpsRequest(req) });
  return NextResponse.json(
    {
      ok: true,
      role: 'citizen',
      name: resident.name,
      slug: payload.slug,
      buildingId: resident.building_id,
      floor: resident.floor,
      unit: resident.unit,
      aadharMasked: maskAadhar(resident.aadhar),
      phoneMasked: maskPhone(resident.phone),
    },
    { headers: { 'set-cookie': setCookie } },
  );
}
