import { NextResponse } from 'next/server';
import { backend, getUtilities } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/utilities -> GeoJSON of utility centrelines + depth/radius props. */
export async function GET() {
  try {
    const fc = await getUtilities();
    return NextResponse.json(fc, {
      headers: { 'x-ulpin-backend': await backend() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load utilities', detail: String(err) },
      { status: 500 },
    );
  }
}
