import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildingEdit } from './building-schema';
import { isValidSlug, DEFAULT_SLUG } from '../projects';

/**
 * The manual-edit store, one file per project.
 *
 * This is the seam a real backend replaces. Everything above it -- the PATCH
 * handler, the validation, the form, the optimistic-free save cycle -- talks
 * to this module and to nothing else, so swapping in a database means
 * reimplementing `loadEdits` and `applyEdit` and touching nothing further.
 *
 * WHY ONE FILE PER PROJECT
 * ------------------------
 * Records are keyed by BUILDING ID, and building ids are only unique within a
 * project. A single global file therefore collides across AOIs: saving a name
 * against building 12 in one project would silently overwrite building 12 in
 * another, and neither the API nor the form would show anything wrong. The
 * directory layout is what makes that impossible rather than merely unlikely.
 *
 * WHY THE SNAPSHOT CACHE DOES NOT GO STALE
 * ----------------------------------------
 * The obvious design -- mutate the parsed snapshot in place -- would poison
 * lib/db.ts's `fileCache` for the life of the process, and every read after a
 * save would return something that is no longer what is on disk. Instead the
 * cached documents are never touched: the overlay is a pure function applied
 * over pristine inputs on each read. There is consequently no cache to
 * invalidate, which is why no invalidation code appears anywhere.
 */

export interface EditRecord {
  fields: Partial<BuildingEdit>;
  updated_at: string;
  rev: number;
}

interface EditStore {
  _disclaimer: string;
  _synthetic: true;
  project: string;
  edits: Record<string, EditRecord>;
}

const DISCLAIMER =
  'LOCAL DEMONSTRATION EDITS — NOT A REGISTER. Values recorded here were typed '
  + 'into the viewer and are stored only in this file. They carry no survey '
  + 'authority and are not written back to OpenStreetMap or to PostGIS.';

/**
 * Where edits live: <base>/<slug>/edits.json.
 *
 * ULPIN_EDITS_PATH overrides the BASE DIRECTORY. It used to name the single
 * global file; a value still ending in `.json` is therefore read as "the
 * directory that file was in", so an existing development setup keeps working
 * instead of silently creating a directory called `edits.json`.
 *
 * Overridability matters in development: Next's file watcher sees anything
 * under the project tree, so writing here on every Save restarts the dev
 * server and makes a working feature look like a crash. Point
 * ULPIN_EDITS_PATH outside the tree while developing.
 */
function editsBaseDir(): string {
  const override = process.env.ULPIN_EDITS_PATH;
  if (!override) return path.join(process.cwd(), 'data', 'projects');
  return override.toLowerCase().endsWith('.json') ? path.dirname(override) : override;
}

function editsPath(slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  return path.join(editsBaseDir(), slug, 'edits.json');
}

/** Where the single global store used to live, before edits were per project. */
function legacyEditsPath(): string {
  const override = process.env.ULPIN_EDITS_PATH;
  if (override && override.toLowerCase().endsWith('.json')) return override;
  return path.join(process.cwd(), 'data', 'edits.json');
}

const empty = (slug: string): EditStore => ({
  _disclaimer: DISCLAIMER,
  _synthetic: true,
  project: slug,
  edits: {},
});

const cache = new Map<string, EditStore>();
const revs = new Map<string, number>();

/**
 * Serialises every mutation, per project.
 *
 * Two concurrent PATCHes would otherwise read-modify-write the same object and
 * one would be lost. Because patches merge FIELD BY FIELD, a request changing
 * `floors` and one changing `name` both survive; last-writer-wins applies per
 * field rather than per building. The queue is per project because two
 * projects write to two different files and have no reason to block on each
 * other.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * One-time adoption of the pre-multi-project global store.
 *
 * COPIES data/edits.json into the demo project's path; it does not move it and
 * it does not delete it. Anyone who had recorded edits before this change
 * keeps them, and if the copy turns out to be wrong the original is still
 * there to look at. Runs at most once per process and only when the demo
 * project has no store of its own yet.
 */
let migrationDone = false;
async function adoptLegacyStore(slug: string): Promise<void> {
  if (migrationDone || slug !== DEFAULT_SLUG) return;
  migrationDone = true;
  const target = editsPath(slug);
  try {
    await fs.access(target);
    return; // the project already has its own store; leave both alone
  } catch { /* no per-project store yet -- fall through */ }

  const legacy = legacyEditsPath();
  if (path.resolve(legacy) === path.resolve(target)) return;
  try {
    const raw = await fs.readFile(legacy, 'utf-8');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, raw, 'utf-8');
    console.info(
      `[edits] copied the pre-multi-project store ${legacy} -> ${target}. `
      + 'The original has been left in place, not moved.',
    );
  } catch {
    // No legacy file is the normal case on a fresh checkout.
  }
}

export async function loadEdits(slug: string): Promise<EditStore> {
  const hit = cache.get(slug);
  if (hit) return hit;
  await adoptLegacyStore(slug);
  let store: EditStore;
  try {
    const raw = await fs.readFile(editsPath(slug), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EditStore>;
    store = {
      ...empty(slug),
      ...parsed,
      project: slug,
      edits: parsed.edits && typeof parsed.edits === 'object' ? parsed.edits : {},
    };
  } catch {
    // Absent or unreadable is the normal first-run state, not an error. The
    // file is deliberately NOT created on read -- only a save creates it.
    store = empty(slug);
  }
  cache.set(slug, store);
  return store;
}

/** The edits for one building in one project, or null. */
export async function editsFor(
  slug: string,
  id: number,
): Promise<Partial<BuildingEdit> | null> {
  const store = await loadEdits(slug);
  return store.edits[String(id)]?.fields ?? null;
}

/** All of a project's edits, keyed by building id. Used by the collection read. */
export async function allEdits(
  slug: string,
): Promise<Map<number, Partial<BuildingEdit>>> {
  const store = await loadEdits(slug);
  const out = new Map<number, Partial<BuildingEdit>>();
  for (const [k, v] of Object.entries(store.edits)) out.set(Number(k), v.fields);
  return out;
}

/**
 * Monotonic revision counter, per project.
 *
 * Memoised derivations in lib/db.ts key on this so a save invalidates them
 * with an integer comparison rather than a deep equality check -- and only
 * invalidates the project that was actually saved.
 */
export function editsRev(slug: string): number {
  return revs.get(slug) ?? 0;
}

async function persist(slug: string, store: EditStore): Promise<void> {
  const target = editsPath(slug);
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  try {
    // Atomic on the same volume, so a crash mid-write cannot leave a truncated
    // store behind.
    await fs.rename(tmp, target);
  } catch {
    // Windows can refuse a rename over a file a watcher still holds open.
    await fs.copyFile(tmp, target);
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Merge a patch into a building's record and write it through. */
export async function applyEdit(
  slug: string,
  id: number,
  patch: Partial<BuildingEdit>,
): Promise<EditRecord> {
  const run = (queues.get(slug) ?? Promise.resolve()).then(async () => {
    const store = await loadEdits(slug);
    const key = String(id);
    const prev = store.edits[key];
    const record: EditRecord = {
      fields: { ...prev?.fields, ...patch },
      updated_at: new Date().toISOString(),
      rev: (prev?.rev ?? 0) + 1,
    };
    store.edits[key] = record;
    await persist(slug, store);
    revs.set(slug, editsRev(slug) + 1);
    return record;
  });
  // The queue must continue even when one write fails, or a single error would
  // wedge every later save behind a rejected promise.
  queues.set(slug, run.catch(() => undefined));
  return run;
}

/** Drop a building's edits. Used by tests and by a future "revert" action. */
export async function clearEdit(slug: string, id: number): Promise<void> {
  const run = (queues.get(slug) ?? Promise.resolve()).then(async () => {
    const store = await loadEdits(slug);
    delete store.edits[String(id)];
    await persist(slug, store);
    revs.set(slug, editsRev(slug) + 1);
  });
  queues.set(slug, run.catch(() => undefined));
  return run;
}
