import { NextResponse } from 'next/server';
import { listProjects } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/projects -> every project, with its stats.
 *
 * PostGIS first, falling back to the committed data/api/projects.json, which
 * is what lets the gallery render with the database down. The response is the
 * same shape as that file, so the two are interchangeable by construction
 * rather than by a mapping someone has to keep in step.
 */
export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to list projects', detail: String(err) },
      { status: 500 },
    );
  }
}
