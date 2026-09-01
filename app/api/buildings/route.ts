import { NextResponse } from 'next/server';
import { backend, getBuildings } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/buildings -> GeoJSON FeatureCollection of every footprint in the AOI. */
export async function GET() {
  try {
    const fc = await getBuildings();
    return NextResponse.json(fc, {
      headers: { 'x-ulpin-backend': await backend() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load buildings', detail: String(err) },
      { status: 500 },
    );
  }
}
