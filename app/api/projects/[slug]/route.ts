import { NextResponse } from 'next/server';
import { resolveProject, unavailableMessage } from '@/lib/projects';

export const dynamic = 'force-dynamic';

/**
 * GET /api/projects/:slug -> one project.
 *
 * Carries the same 404/503 distinction the cadastre routes do, so a caller
 * that gets 503 here knows the project is real and its database is down, and
 * does not have to infer that from an empty buildings collection.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  try {
    const resolution = await resolveProject(slug);
    if (resolution.kind === 'not-found') {
      return NextResponse.json(
        { error: 'project not found', slug },
        { status: 404 },
      );
    }
    if (resolution.kind === 'unavailable') {
      return NextResponse.json(
        {
          error: 'project unavailable',
          slug,
          project: resolution.project,
          detail: unavailableMessage(resolution.project),
        },
        { status: 503 },
      );
    }
    return NextResponse.json(resolution.project);
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to load project', detail: String(err) },
      { status: 500 },
    );
  }
}
