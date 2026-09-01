import { NextResponse } from 'next/server';
import { backend, getConflicts } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/conflicts -> utility/basement intersections found by ST_3DIntersects. */
export async function GET() {
  try {
    const rows = await getConflicts();
    return NextResponse.json(rows, {
      headers: { 'x-ulpin-backend': await backend() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load conflicts', detail: String(err) },
      { status: 500 },
    );
  }
}
