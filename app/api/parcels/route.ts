import { NextResponse } from 'next/server';
import { backend, getParcels } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * GET /api/parcels -> GeoJSON of surface parcel polygons.
 *
 * Beyond the five endpoints in the brief, but the "Surface parcels" layer and
 * the 2D parcel-context inset cannot render without it.
 */
export async function GET() {
  try {
    const fc = await getParcels();
    return NextResponse.json(fc, { headers: { 'x-ulpin-backend': await backend() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load parcels', detail: String(err) },
      { status: 500 },
    );
  }
}
