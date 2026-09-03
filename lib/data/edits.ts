import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BuildingEdit } from './building-schema';

/**
 * The manual-edit store.
 *
 * This is the seam a real backend replaces. Everything above it -- the PATCH
 * handler, the validation, the form, the optimistic-free save cycle -- talks
 * to this module and to nothing else, so swapping in a database means
 * reimplementing `loadEdits` and `applyEdit` and touching nothing further.
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
  edits: Record<string, EditRecord>;
}

const DISCLAIMER =
  'LOCAL DEMONSTRATION EDITS — NOT A REGISTER. Values recorded here were typed '
  + 'into the viewer and are stored only in this file. They carry no survey '
  + 'authority and are not written back to OpenStreetMap or to PostGIS.';

/**
 * Where edits live.
 *
 * Overridable, and that matters in development: Next's file watcher sees
 * anything under the project tree, so writing here on every Save restarts the
 * dev server and makes a working feature look like a crash. Point
 * ULPIN_EDITS_PATH outside the tree while developing.
 */
const EDITS_PATH = process.env.ULPIN_EDITS_PATH
  ?? path.join(process.cwd(), 'data', 'edits.json');

const empty = (): EditStore => ({
  _disclaimer: DISCLAIMER,
  _synthetic: true,
  edits: {},
});

let cache: EditStore | null = null;
let rev = 0;

/**
 * Serialises every mutation.
 *
 * Two concurrent PATCHes would otherwise read-modify-write the same object and
 * one would be lost. Because patches merge FIELD BY FIELD, a request changing
 * `floors` and one changing `name` both survive; last-writer-wins applies per
 * field rather than per building.
 */
let queue: Promise<unknown> = Promise.resolve();

export async function loadEdits(): Promise<EditStore> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(EDITS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EditStore>;
    cache = {
      ...empty(),
      ...parsed,
      edits: parsed.edits && typeof parsed.edits === 'object' ? parsed.edits : {},
    };
  } catch {
    // Absent or unreadable is the normal first-run state, not an error. The
    // file is deliberately NOT created on read -- only a save creates it.
    cache = empty();
  }
  return cache;
}

/** The edits for one building, or null. */
export async function editsFor(id: number): Promise<Partial<BuildingEdit> | null> {
  const store = await loadEdits();
  return store.edits[String(id)]?.fields ?? null;
}

/** All edits, keyed by building id. Used by the collection read path. */
export async function allEdits(): Promise<Map<number, Partial<BuildingEdit>>> {
  const store = await loadEdits();
  const out = new Map<number, Partial<BuildingEdit>>();
  for (const [k, v] of Object.entries(store.edits)) out.set(Number(k), v.fields);
  return out;
}

/**
 * Monotonic revision counter.
 *
 * Memoised derivations in lib/db.ts key on this so a save invalidates them
 * with an integer comparison rather than a deep equality check.
 */
export function editsRev(): number {
  return rev;
}

async function persist(store: EditStore): Promise<void> {
  const tmp = `${EDITS_PATH}.tmp`;
  await fs.mkdir(path.dirname(EDITS_PATH), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8');
  try {
    // Atomic on the same volume, so a crash mid-write cannot leave a truncated
    // store behind.
    await fs.rename(tmp, EDITS_PATH);
  } catch {
    // Windows can refuse a rename over a file a watcher still holds open.
    await fs.copyFile(tmp, EDITS_PATH);
    await fs.unlink(tmp).catch(() => {});
  }
}

/** Merge a patch into a building's record and write it through. */
export async function applyEdit(
  id: number,
  patch: Partial<BuildingEdit>,
): Promise<EditRecord> {
  const run = queue.then(async () => {
    const store = await loadEdits();
    const key = String(id);
    const prev = store.edits[key];
    const record: EditRecord = {
      fields: { ...prev?.fields, ...patch },
      updated_at: new Date().toISOString(),
      rev: (prev?.rev ?? 0) + 1,
    };
    store.edits[key] = record;
    await persist(store);
    rev++;
    return record;
  });
  // The queue must continue even when one write fails, or a single error would
  // wedge every later save behind a rejected promise.
  queue = run.catch(() => undefined);
  return run;
}

/** Drop a building's edits. Used by tests and by a future "revert" action. */
export async function clearEdit(id: number): Promise<void> {
  const run = queue.then(async () => {
    const store = await loadEdits();
    delete store.edits[String(id)];
    await persist(store);
    rev++;
  });
  queue = run.catch(() => undefined);
  return run;
}
