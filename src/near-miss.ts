import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Groups of lockfile basenames that are easy to confuse with one another —
 * the exact shape of the hoiekim/inbox#985 bug (`bun.lockb` referenced where
 * the repo actually has `bun.lock`).
 */
const FIXED_FAMILIES: string[][] = [
  ['bun.lockb', 'bun.lock'],
  ['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'],
  ['Pipfile.lock', 'poetry.lock', 'uv.lock'],
];

const REGEX_FAMILIES: RegExp[] = [/^requirements.*\.txt$/i];

function sameFamily(a: string, b: string): boolean {
  if (a === b) return false;
  for (const family of FIXED_FAMILIES) {
    const has = (name: string) => family.some((f) => f.toLowerCase() === name.toLowerCase());
    if (has(a) && has(b)) return true;
  }
  for (const re of REGEX_FAMILIES) {
    if (re.test(a) && re.test(b)) return true;
  }
  return false;
}

/** The literal directory a pattern's basename would resolve to, if every segment before it is a plain literal (no glob magic). `undefined` if the directory can't be resolved statically (e.g. `**\/composer.lock`). */
export function literalDirname(pattern: string): string | undefined {
  const segments = pattern.split('/');
  segments.pop();
  if (segments.some((s) => /[*?[\]{}!]/.test(s))) return undefined;
  return segments.join('/');
}

/**
 * Looks for a file in `dir` (workspace-relative) that is either the same
 * name in different case, or a member of the same known lockfile-rename
 * family as `basename`, and is not `basename` itself. Returns its name for a
 * "did you mean '…'?" hint, or `undefined`.
 */
export function findNearMiss(basename: string, dir: string, workspace: string): string | undefined {
  const absDir = path.join(workspace, dir);
  let entries: string[];
  try {
    entries = fs.readdirSync(absDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry === basename) continue;
    if (entry.toLowerCase() === basename.toLowerCase()) return entry;
  }
  for (const entry of entries) {
    if (sameFamily(basename, entry)) return entry;
  }
  return undefined;
}
