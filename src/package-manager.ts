import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StepContext } from './scan.ts';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILE_OWNER: Record<string, PackageManager> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};

/** Returns the package manager that owns a lockfile basename, or `undefined` if it names none of the ones this rule knows about. */
export function lockfileOwner(basename: string): PackageManager | undefined {
  return LOCKFILE_OWNER[basename];
}

/** Last path segment of a glob pattern, if it names a fixed file (no glob magic characters in that segment). */
export function literalBasename(pattern: string): string | undefined {
  const segments = pattern.split('/');
  const last = segments[segments.length - 1];
  if (!last || /[*?[\]{}]/.test(last)) return undefined;
  return last;
}

/**
 * Detects the single package manager a workflow indicates, from a
 * `setup-node`/`pnpm/action-setup` step or the repo's `package.json`
 * `packageManager` field. Returns `undefined` when there is no signal, or
 * signals disagree (ambiguous — do not guess).
 */
export function detectPackageManager(
  steps: StepContext[],
  workspace: string,
): PackageManager | undefined {
  const signals = new Set<PackageManager>();

  for (const step of steps) {
    if (!step.uses) continue;
    if (/^actions\/setup-node(@|\/|$)/i.test(step.uses)) {
      const cache = step.with?.cache;
      if (cache === 'npm' || cache === 'yarn' || cache === 'pnpm') {
        signals.add(cache);
      }
    } else if (/^pnpm\/action-setup(@|\/|$)/i.test(step.uses)) {
      signals.add('pnpm');
    } else if (/^oven-sh\/setup-bun(@|\/|$)/i.test(step.uses)) {
      signals.add('bun');
    }
  }

  const pkgJsonManager = readPackageManagerField(workspace);
  if (pkgJsonManager) signals.add(pkgJsonManager);

  if (signals.size === 1) return [...signals][0];
  return undefined;
}

function readPackageManagerField(workspace: string): PackageManager | undefined {
  try {
    const raw = fs.readFileSync(path.join(workspace, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'packageManager' in parsed &&
      typeof (parsed as { packageManager?: unknown }).packageManager === 'string'
    ) {
      const value = (parsed as { packageManager: string }).packageManager;
      const name = value.split('@')[0];
      if (name === 'npm' || name === 'yarn' || name === 'pnpm' || name === 'bun') return name;
    }
  } catch {
    // no package.json, unreadable, or invalid JSON — no signal.
  }
  return undefined;
}
