import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from '@/lib/projects';

/**
 * Read-only lookups for the demo users.
 *
 * The citizen roster and the gov roster are both committed JSON files. They
 * are tiny, so the simplest thing is to read them on every login and let the
 * OS cache the bytes -- the alternative (a per-process Map that survives
 * across Vercel invocations) does not exist on serverless.
 *
 * The lookup paths are also deliberately not memoised: a `git pull` in dev
 * that swaps a residents.json would otherwise be invisible until the next
 * process restart, which is the wrong default for a demo where the only
 * mutation is a JSON edit.
 */

export interface Resident {
  aadhar: string;
  phone: string;
  name: string;
  building_id: number;
  floor: number;
  unit: string;
}

/** All residents for one project. Empty array on read error -- the route
 *  then answers "unknown aadhar", which is the right answer for a fresh
 *  checkout that has not been seeded yet. */
export async function findResidents(slug: string): Promise<Resident[]> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECTS_DIR, slug, 'residents.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isResident);
  } catch {
    return [];
  }
}

function isResident(v: unknown): v is Resident {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.aadhar === 'string'
    && typeof o.phone === 'string'
    && typeof o.name === 'string'
    && typeof o.building_id === 'number'
    && typeof o.floor === 'number'
    && typeof o.unit === 'string'
  );
}

/** Look up a single resident by aadhar + phone. Phone is matched verbatim --
 *  the demo roster has no area-code normalisation to do. */
export async function findResident(
  slug: string,
  aadhar: string,
  phone: string,
): Promise<Resident | null> {
  const all = await findResidents(slug);
  return all.find((r) => r.aadhar === aadhar && r.phone === phone) ?? null;
}

/** The gov roster: { "<email>": "<bcrypt-hash>" }. The plaintext never
 *  lands in the file -- `scripts/hash_gov_password.mjs` produces the hash
 *  from a GOV_ADMIN_PASSWORD env var. */
export type GovRoster = Record<string, string>;

export async function readGovRoster(): Promise<GovRoster> {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), 'data', 'gov_users.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: GovRoster = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
