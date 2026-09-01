import { NextResponse } from 'next/server';
import { backend, queryPoint } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * POST /api/query {lon, lat, z}
 * Every entity whose 3D volume contains the point, ordered
 * parcel < building < floor < unit.
 */
export async function POST(req: Request) {
  let body: { lon?: unknown; lat?: unknown; z?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const lon = Number(body.lon);
  const lat = Number(body.lat);
  const z = Number(body.z);
  if (![lon, lat, z].every(Number.isFinite)) {
    return NextResponse.json(
      { error: 'lon, lat and z are required numbers' },
      { status: 400 },
    );
  }
  if (lat < -90 || lat > 90) {
    return NextResponse.json({ error: 'lat out of range' }, { status: 400 });
  }
  if (lon < -180 || lon > 180) {
    return NextResponse.json({ error: 'lon out of range' }, { status: 400 });
  }

  try {
    const stack = await queryPoint(lon, lat, z);
    return NextResponse.json(
      { point: { lon, lat, z }, count: stack.length, stack },
      { headers: { 'x-ulpin-backend': await backend() } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: 'query failed', detail: String(err) },
      { status: 500 },
    );
  }
}
