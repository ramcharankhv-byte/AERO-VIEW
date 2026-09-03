import { NextResponse } from 'next/server';
import { backend, getRoads } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/roads -> GeoJSON FeatureCollection of merged street centrelines.
 *
 * `x-ulpin-roads: derived` is sent alongside the usual backend header because
 * this resource is unlike the others: there is no road table in PostGIS, so it
 * is served from the committed artefact whatever the database is doing. The
 * header says so on the wire rather than only in a comment.
 */
export async function GET() {
  try {
    const fc = await getRoads();
    return NextResponse.json(fc, {
      headers: {
        'x-ulpin-backend': await backend(),
        'x-ulpin-roads': 'derived',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load roads', detail: String(err) },
      { status: 500 },
    );
  }
}
