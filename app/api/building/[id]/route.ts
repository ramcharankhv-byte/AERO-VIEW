import { NextResponse } from 'next/server';
import { backend, getBuildingDetail } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** GET /api/building/:id -> building with its floors and units nested. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const numeric = Number(id);
  if (!Number.isInteger(numeric)) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  try {
    const detail = await getBuildingDetail(numeric);
    if (!detail) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }
    return NextResponse.json(detail, {
      headers: { 'x-ulpin-backend': await backend() },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load building', detail: String(err) },
      { status: 500 },
    );
  }
}
