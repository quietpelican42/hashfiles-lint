import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverWorkflowFiles } from './discover.ts';
import { lintText, YamlParseError } from './scan.ts';
import type { Finding } from './types.ts';

export type { Finding, RuleId, Severity } from './types.ts';
export { YamlParseError } from './scan.ts';

export interface FileError {
  file: string;
  message: string;
}

export interface LintReport {
  findings: Finding[];
  /** Files that could not be parsed (invalid YAML) or read. */
  errors: FileError[];
  /** Files scanned successfully (may have zero findings). */
  scannedFiles: string[];
}

/**
 * Lints a single directory (its `.github/workflows/` and any composite
 * `action.yml`/`action.yaml` files) or a single workflow/action file.
 * `workspace` is the repository root patterns resolve against; it defaults
 * to `target` if `target` is a directory, else to `process.cwd()`.
 */
export async function lintPath(target: string, workspace?: string): Promise<LintReport> {
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? discoverWorkflowFiles(target) : [path.resolve(target)];
  // Resolved to a realpath up front: hashFiles patterns get matched by
  // symlink-resolved absolute path (see glob-eval.ts), so anything compared
  // against `ws` downstream (path.relative for the ignored/vendored-path
  // checks) must start from the same realpath, not a caller-supplied one
  // that might contain a symlink component (e.g. macOS's /tmp).
  const ws = fs.realpathSync(path.resolve(workspace ?? (stat.isDirectory() ? target : process.cwd())));
  // Reported file paths are relative to the analysed root, not the process's
  // cwd — running `hashfiles-lint /abs/path/to/repo` from somewhere else
  // must never print a `../../../..` chain. `root` deliberately is not
  // realpath'd: `files` below were resolved with plain path.resolve too, so
  // both sides of the path.relative() call agree regardless of any symlink
  // in `target`.
  const root = stat.isDirectory() ? path.resolve(target) : path.dirname(path.resolve(target));

  const findings: Finding[] = [];
  const errors: FileError[] = [];
  const scannedFiles: string[] = [];

  for (const file of files) {
    const relFile = path.relative(root, file) || path.basename(file);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      errors.push({ file: relFile, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const fileFindings = await lintText(relFile, text, ws);
      findings.push(...fileFindings);
      scannedFiles.push(relFile);
    } catch (err) {
      if (err instanceof YamlParseError) {
        errors.push({ file: relFile, message: err.message });
      } else {
        throw err;
      }
    }
  }

  return { findings, errors, scannedFiles };
}
