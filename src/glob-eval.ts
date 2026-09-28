import * as fs from 'node:fs';
import * as path from 'node:path';
import * as glob from '@actions/glob';

/**
 * Evaluates hashFiles patterns exactly the way the runner does, not the way
 * @actions/glob behaves by default. Source: actions/runner
 * src/Misc/expressionFunc/hashFiles/src/hashFiles.ts (the code that actually
 * runs for `hashFiles()`, not @actions/glob's own hashFiles() helper, which
 * the runner does not call).
 *
 * Divergences from @actions/glob's own defaults that this mirrors:
 *  - `followSymbolicLinks` defaults to `false` here. @actions/glob defaults
 *    it to `true`. The runner only sets it `true` when the first hashFiles
 *    argument is the literal string `--follow-symbolic-links`.
 *  - Patterns are resolved against `GITHUB_WORKSPACE` (the repository root),
 *    never a step's `working-directory` — the runner always launches the
 *    hashFiles subprocess with that as its cwd, and `@actions/glob` resolves
 *    relative patterns against `process.cwd()`.
 *  - Matches outside the workspace, and matched directories, are excluded —
 *    only files under the workspace count toward "matched".
 */
export interface GlobEvalResult {
  /** Absolute paths of matched files (directories and out-of-workspace paths excluded), as the runner would hash them. */
  matchedFiles: string[];
}

export class InvalidPatternError extends Error {}

export async function evaluateHashFilesPatterns(
  patterns: string[],
  workspace: string,
  followSymbolicLinks: boolean,
): Promise<GlobEvalResult> {
  const patternText = patterns.join('\n');
  const priorCwd = process.cwd();
  // @actions/glob logs its options and search paths via @actions/core's
  // debug()/issueCommand(), which writes `::debug::…` lines straight to
  // stdout with no way to opt out outside of a real runner. Filter out only
  // those workflow-command lines (they always start with `::`) rather than
  // swallowing stdout wholesale — anything else (our own output, a test
  // runner's own reporting) passes through untouched, so this is safe even
  // when other code is writing to stdout concurrently across the awaits below.
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
    if (/^::[a-z-]+(?:\s|::)/i.test(text)) {
      const cb = rest.find((a): a is () => void => typeof a === 'function');
      cb?.();
      return true;
    }
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    process.chdir(workspace);
    // Mirror the runner exactly: it captures `githubWorkspace` from its own
    // `process.cwd()` *after* the hashFiles subprocess is already running
    // there, so it never disagrees with itself about symlink resolution. If
    // we instead filtered against the caller-supplied `workspace` string
    // verbatim, a symlinked path (e.g. macOS's /tmp -> /private/tmp) would
    // make every real match look "outside the workspace" and get dropped.
    const effectiveWorkspace = process.cwd();
    let globber: glob.Globber;
    try {
      globber = await glob.create(patternText, { followSymbolicLinks });
    } catch (err) {
      throw new InvalidPatternError(err instanceof Error ? err.message : String(err));
    }
    const workspacePrefix = effectiveWorkspace.endsWith(path.sep)
      ? effectiveWorkspace
      : effectiveWorkspace + path.sep;
    const matchedFiles: string[] = [];
    for await (const file of globber.globGenerator()) {
      if (file !== effectiveWorkspace && !file.startsWith(workspacePrefix)) continue;
      let isDirectory: boolean;
      try {
        isDirectory = fs.statSync(file).isDirectory();
      } catch {
        continue; // race or broken symlink; the runner's fs.statSync would throw and abort the whole hashFiles call, but we should not abort the whole scan over one file's quirk.
      }
      if (isDirectory) continue;
      matchedFiles.push(file);
    }
    return { matchedFiles };
  } finally {
    process.chdir(priorCwd);
    process.stdout.write = realWrite;
  }
}
