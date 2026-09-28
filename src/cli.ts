#!/usr/bin/env node
import { lintPath } from './index.ts';
import type { Finding } from './types.ts';

interface CliArgs {
  target: string;
  workspace: string | undefined;
  format: 'text' | 'json' | 'github';
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliArgs {
  let target: string | undefined;
  let workspace: string | undefined;
  let format: CliArgs['format'] = 'text';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--format' || arg === '--workspace') {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      if (arg === '--format') {
        if (value !== 'text' && value !== 'json' && value !== 'github') {
          throw new UsageError(`--format must be one of text, json, github (got "${value}")`);
        }
        format = value;
      } else {
        workspace = value;
      }
    } else if (arg.startsWith('--format=')) {
      const value = arg.slice('--format='.length);
      if (value !== 'text' && value !== 'json' && value !== 'github') {
        throw new UsageError(`--format must be one of text, json, github (got "${value}")`);
      }
      format = value;
    } else if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!target) {
      target = arg;
    } else {
      throw new UsageError(`unexpected argument "${arg}"`);
    }
  }
  return { target: target ?? '.', workspace, format };
}

function printHelp(): void {
  console.log(
    [
      'Usage: hashfiles-lint [path] [--format text|json|github] [--workspace <dir>]',
      '',
      'Finds GitHub Actions hashFiles() patterns that match no files in the working',
      'tree, plus related cache-key smells.',
      '',
      'path       A directory (its .github/workflows/ and action.yml files are',
      '           scanned) or a single workflow/action file. Default: .',
      '--workspace  Root patterns resolve against (mirrors GITHUB_WORKSPACE).',
      '           Defaults to `path` if it is a directory, else the current directory.',
      '',
      'Exit codes:',
      '  0  clean (no findings)',
      '  1  findings (errors and/or warnings and/or info)',
      '  2  could not analyse the input (unreadable file, invalid YAML)',
    ].join('\n'),
  );
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function formatText(findings: Finding[], errors: { file: string; message: string }[]): string {
  const lines: string[] = [];
  for (const err of errors) {
    lines.push(`${err.file}: could not analyse — ${err.message}`);
  }
  for (const f of findings) {
    lines.push(`${f.file}:${f.line}: ${f.severity} [${f.rule}] ${f.message}`);
  }
  if (lines.length === 0) lines.push('clean — no hashFiles() findings');
  return lines.join('\n');
}

function formatGithub(findings: Finding[], errors: { file: string; message: string }[]): string {
  const lines: string[] = [];
  for (const err of errors) {
    lines.push(`::error file=${err.file}::could not analyse — ${escapeGithub(err.message)}`);
  }
  for (const f of findings) {
    const cmd = f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'notice';
    lines.push(`::${cmd} file=${f.file},line=${f.line}::[${f.rule}] ${escapeGithub(f.message)}`);
  }
  return lines.join('\n');
}

function escapeGithub(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`hashfiles-lint: ${err.message}`);
      printHelp();
      process.exit(2);
    }
    throw err;
  }

  let report;
  try {
    report = await lintPath(args.target, args.workspace);
  } catch (err) {
    console.error(`hashfiles-lint: could not analyse "${args.target}": ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const sorted = report.findings
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  if (args.format === 'json') {
    console.log(JSON.stringify({ findings: sorted, errors: report.errors, scannedFiles: report.scannedFiles }, null, 2));
  } else if (args.format === 'github') {
    console.log(formatGithub(sorted, report.errors));
  } else {
    console.log(formatText(sorted, report.errors));
  }

  if (report.errors.length > 0) {
    process.exit(2);
  } else if (sorted.length > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err: unknown) => {
  console.error(`hashfiles-lint: unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(2);
});
