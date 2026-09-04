import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Project, ProjectStats, ProjectStatus } from './types';

/**
 * The project registry.
 *
 * A project is one AOI: a bbox, the revenue codes its ULPINs are minted under,
 * and a status. Everything else in the application is scoped by one.
 *
 * Two backends, for the same reason lib/db.ts has two. PostGIS holds the
 * `projects` table and is the source of truth. `data/api/projects.json` is a
 * committed snapshot of it, so the gallery renders -- and the siripuram demo
 * opens -- with docker down, exactly as the cadastre endpoints already do.
 *
 * This module is deliberately separate from lib/db.ts: lib/db.ts answers "what
 * is in project X", and to do that it first has to know that X exists and
 * which numeric id it has. Folding the two together made that a cycle.
 */

export const DEFAULT_SLUG = 'siripuram';

/** Where the per-project snapshot directories live. */
export const API_DIR = path.join(process.cwd(), 'data', 'api');

/** Where per-project runtime state (edits, cached Overpass) lives. */
export const PROJECTS_DIR = path.join(process.cwd(), 'data', 'projects');

export type { Project, ProjectStats, ProjectStatus };

const REGISTRY_SNAPSHOT = path.join(API_DIR, 'projects.json');

/** A slug is a path segment we join onto a directory, so it is validated. */
export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

export function snapshotDir(slug: string): string {
  return path.join(API_DIR, slug);
}

/**
 * Registry rows, PostGIS first.
 *
 * NOT memoised on the snapshot path beyond lib/db.ts's own file cache: the
 * seed pipeline rewrites projects.json, and a dev server that had cached the
 * old list would keep serving a gallery missing the project just generated.
 */
export async function listProjects(): Promise<Project[]> {
  const { projectsFromDb } = await import('./db');
  const fromDb = await projectsFromDb();
  if (fromDb) return fromDb;
  return readRegistrySnapshot();
}

async function readRegistrySnapshot(): Promise<Project[]> {
  try {
    const raw = await fs.readFile(REGISTRY_SNAPSHOT, 'utf-8');
    const parsed = JSON.parse(raw) as { projects?: Project[] };
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    // No registry at all is a legitimate state on a checkout that has never
    // been seeded. The gallery renders empty rather than throwing.
    return [];
  }
}

export async function findProject(slug: string): Promise<Project | null> {
  if (!isValidSlug(slug)) return null;
  const all = await listProjects();
  return all.find((p) => p.slug === slug) ?? null;
}

/** True when data/api/<slug>/ carries a usable snapshot. */
export async function hasSnapshots(slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) return false;
  try {
    await fs.access(path.join(snapshotDir(slug), 'buildings.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * What a route handler should do with a slug.
 *
 * Three outcomes, and the two failures are different failures:
 *
 *   'ok'          serve it; the snapshot, PostGIS, or both can answer
 *   'not-found'   nothing anywhere knows this slug          -> 404
 *   'unavailable' the project is real but nothing can answer it right now,
 *                 which in practice means a project generated straight into
 *                 PostGIS whose snapshots were never exported, read while
 *                 the database is down                      -> 503
 *
 * Collapsing the last two into a 404 would tell a user their project does not
 * exist when the truth is that their database is not running, and the gallery
 * renders the two as different states.
 */
export type Resolution =
  | { kind: 'ok'; project: Project }
  | { kind: 'not-found'; slug: string }
  | { kind: 'unavailable'; project: Project };

export async function resolveProject(slug: string): Promise<Resolution> {
  const project = await findProject(slug);
  if (!project) {
    // A snapshot directory with no registry row is still not a project: the
    // registry is what says what a project is called and where it is. Treat
    // it as absent rather than inventing a record for it.
    return { kind: 'not-found', slug };
  }
  if (await hasSnapshots(slug)) return { kind: 'ok', project };

  const { projectHasRows } = await import('./db');
  if (await projectHasRows(slug)) return { kind: 'ok', project };

  return { kind: 'unavailable', project };
}

/** The message the 503 body and the gallery card both use, so they agree. */
export function unavailableMessage(project: Project): string {
  return `PostGIS is required for this project: "${project.name}" has no exported `
    + `snapshot under data/api/${project.slug}/, so the database must be running `
    + 'to serve it. Start it with `docker compose up -d`, or re-run the export '
    + `with \`npm run seed -- --slug=${project.slug}\`.`;
}

export const EMPTY_STATS: ProjectStats = {
  buildings: 0, parcels: 0, streets: 0, floors: 0,
  units: 0, utilities: 0, conflicts: 0,
};
