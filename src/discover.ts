import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Finds workflow files (`.github/workflows/*.yml|*.yaml`) and composite
 * action manifests (`**\/action.yml|action.yaml`) under `root`, skipping
 * `node_modules` and `.git`.
 */
export function discoverWorkflowFiles(root: string): string[] {
  const out = new Set<string>();

  const workflowsDir = path.join(root, '.github', 'workflows');
  if (isDir(workflowsDir)) {
    for (const entry of fs.readdirSync(workflowsDir)) {
      if (/\.ya?ml$/i.test(entry)) out.add(path.resolve(path.join(workflowsDir, entry)));
    }
  }

  walkForActionFiles(root, out);

  return [...out].sort();
}

function walkForActionFiles(dir: string, out: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkForActionFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && /^action\.ya?ml$/i.test(entry.name)) {
      out.add(path.resolve(path.join(dir, entry.name)));
    }
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
