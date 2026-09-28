import * as path from 'node:path';
import { LineCounter, parseDocument, isMap, isScalar, isSeq } from 'yaml';
import type { Node, YAMLMap } from 'yaml';
import { findHashFilesCalls, type HashFilesCall } from './expr.ts';
import { evaluateHashFilesPatterns, InvalidPatternError } from './glob-eval.ts';
import { detectPackageManager, lockfileOwner, literalBasename } from './package-manager.ts';
import { findNearMiss, literalDirname } from './near-miss.ts';
import type { Finding } from './types.ts';

export class YamlParseError extends Error {}

export interface StepContext {
  uses?: string;
  with?: Record<string, string>;
  withLines?: Record<string, number>;
  /** Identifies the `steps:` array this step belongs to (a job or a composite action's `runs`), so order comparisons never cross jobs. */
  stepsListId?: number;
  /** Position within that steps array. */
  index?: number;
  hasRun: boolean;
  runText?: string;
  runLine?: number;
}

interface CallSite {
  line: number;
  fieldPath: string[];
  step?: StepContext;
  call: HashFilesCall;
}

interface Collected {
  callSites: CallSite[];
  steps: StepContext[];
}

function keyNameOf(key: unknown): string | undefined {
  return isScalar(key) && typeof key.value === 'string' ? key.value : undefined;
}

/** Walks a workflow or composite-action YAML document, collecting every `hashFiles()` call site and every step's `uses`/`with`/`run`. Works uniformly for `jobs.*.steps[]` and a composite action's `runs.steps[]` — both are just a `steps:` array of maps with a `uses` or `run` key. */
export function collectCallSites(text: string): Collected {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    throw new YamlParseError(doc.errors[0]!.message);
  }

  const callSites: CallSite[] = [];
  const steps: StepContext[] = [];
  let stepsListCounter = 0;

  function walk(
    node: Node | null | undefined,
    fieldPath: string[],
    step: StepContext | undefined,
    stepsListId?: number,
    index?: number,
  ): void {
    if (!node) return;
    if (isMap(node)) {
      let currentStep = step;
      const map = node as YAMLMap;
      const usesPair = map.items.find((p) => keyNameOf(p.key) === 'uses');
      const runPair = map.items.find((p) => keyNameOf(p.key) === 'run');
      if (usesPair || runPair) {
        const withPair = map.items.find((p) => keyNameOf(p.key) === 'with');
        const withMap: Record<string, string> = {};
        const withLines: Record<string, number> = {};
        if (withPair && isMap(withPair.value)) {
          for (const wp of withPair.value.items) {
            const k = keyNameOf(wp.key);
            if (k !== undefined && isScalar(wp.value) && typeof wp.value.value === 'string') {
              withMap[k] = wp.value.value;
              const range = wp.value.range;
              if (range) withLines[k] = lineCounter.linePos(range[0]).line;
            }
          }
        }
        let runText: string | undefined;
        let runLine: number | undefined;
        if (runPair && isScalar(runPair.value) && typeof runPair.value.value === 'string') {
          runText = runPair.value.value;
          const range = runPair.value.range;
          if (range) runLine = lineCounter.linePos(range[0]).line;
        }
        currentStep = {
          uses:
            usesPair && isScalar(usesPair.value) && typeof usesPair.value.value === 'string'
              ? usesPair.value.value
              : undefined,
          with: withMap,
          withLines,
          stepsListId,
          index,
          hasRun: runPair !== undefined,
          runText,
          runLine,
        };
        steps.push(currentStep);
      }
      for (const pair of map.items) {
        const keyName = keyNameOf(pair.key);
        if (keyName === 'steps' && isSeq(pair.value)) {
          const listId = ++stepsListCounter;
          pair.value.items.forEach((item, idx) => {
            walk(item as Node | null, [...fieldPath, 'steps', `[${idx}]`], currentStep, listId, idx);
          });
        } else {
          walk(
            pair.value as Node | null,
            keyName !== undefined ? [...fieldPath, keyName] : fieldPath,
            currentStep,
          );
        }
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, idx) => {
        walk(item as Node | null, [...fieldPath, `[${idx}]`], step);
      });
    } else if (isScalar(node)) {
      if (typeof node.value === 'string' && /hashFiles\s*\(/i.test(node.value)) {
        const calls = findHashFilesCalls(node.value);
        if (calls.length > 0) {
          const startOffset = node.range ? node.range[0] : 0;
          const line = lineCounter.linePos(startOffset).line;
          for (const call of calls) {
            callSites.push({ line, fieldPath: fieldPath.slice(), step, call });
          }
        }
      }
    }
  }

  walk(doc.contents, [], undefined);
  return { callSites, steps };
}

const IGNORED_DIR_RE = /(^|\/)(\.git|node_modules)(\/|$)/;
const VENDOR_DIR_RE = /(^|\/)(node_modules|vendor|third[_-]party)(\/|$)/;

function matchedDirName(relPath: string, re: RegExp): string | undefined {
  const m = relPath.match(re);
  return m ? m[2] : undefined;
}

function quoteArgs(patterns: string[]): string {
  return patterns.map((p) => `'${p}'`).join(', ');
}

function isCacheKeyField(step: StepContext | undefined, fieldPath: string[]): boolean {
  return (
    step?.uses !== undefined &&
    /^actions\/cache(@|\/|$)/i.test(step.uses) &&
    fieldPath.length >= 2 &&
    fieldPath[fieldPath.length - 2] === 'with' &&
    fieldPath[fieldPath.length - 1] === 'key'
  );
}

function findStaticCacheKeys(steps: StepContext[], file: string): Finding[] {
  const out: Finding[] = [];
  for (const step of steps) {
    if (!step.uses || !/^actions\/cache(@|\/|$)/i.test(step.uses)) continue;
    const key = step.with?.key;
    if (key === undefined) continue;
    if (!key.includes('${{')) {
      out.push({
        rule: 'static-cache-key',
        severity: 'warning',
        file,
        line: step.withLines?.key ?? 1,
        message: `actions/cache key '${key}' has no expression part — it never changes, so the cache is never invalidated.`,
      });
    }
  }
  return out;
}

/** A keyword that would show up in a `run:` step generating this lockfile, for a stronger "which earlier step" signal. */
const TOOL_KEYWORDS: Array<{ basenames: RegExp; keyword: RegExp }> = [
  { basenames: /^composer\.lock$/i, keyword: /\bcomposer\b/i },
  { basenames: /^(package-lock\.json|npm-shrinkwrap\.json)$/i, keyword: /\bnpm\b/i },
  { basenames: /^yarn\.lock$/i, keyword: /\byarn\b/i },
  { basenames: /^pnpm-lock\.yaml$/i, keyword: /\bpnpm\b/i },
  { basenames: /^bun\.lockb?$/i, keyword: /\bbun\b/i },
  { basenames: /^go\.sum$/i, keyword: /\bgo\b/i },
  { basenames: /^Cargo\.lock$/i, keyword: /\bcargo\b/i },
  { basenames: /^poetry\.lock$/i, keyword: /\bpoetry\b/i },
  { basenames: /^uv\.lock$/i, keyword: /\buv\b/i },
  { basenames: /^requirements.*\.txt$/i, keyword: /\bpip-compile\b|\bpip\b/i },
];

function findGeneratingStep(
  basename: string | undefined,
  earlierRunSteps: StepContext[],
): { step: StepContext; confident: boolean } | undefined {
  if (earlierRunSteps.length === 0) return undefined;
  if (basename) {
    const rule = TOOL_KEYWORDS.find((r) => r.basenames.test(basename));
    if (rule) {
      const match = earlierRunSteps.find((s) => s.runText && rule.keyword.test(s.runText));
      if (match) return { step: match, confident: true };
    }
  }
  // No keyword match (or no fixed basename to key off of) — fall back to the
  // closest preceding run step as a weaker signal.
  return { step: earlierRunSteps[earlierRunSteps.length - 1]!, confident: false };
}

/** Lints one workflow or composite-action file's text. `workspace` is the repository root that patterns resolve against (mirrors GITHUB_WORKSPACE) — never a step's `working-directory`, which the runner's hashFiles ignores. */
export async function lintText(file: string, text: string, workspace: string): Promise<Finding[]> {
  const { callSites, steps } = collectCallSites(text);
  const findings: Finding[] = [];
  const manager = detectPackageManager(steps, workspace);

  for (const site of callSites) {
    const args = site.call.args.slice();
    let followSymbolicLinks = false;
    if (
      args.length > 0 &&
      args[0]!.literal !== null &&
      args[0]!.literal!.toLowerCase() === '--follow-symbolic-links'
    ) {
      followSymbolicLinks = true;
      args.shift();
    }

    const literalArgs = args.filter((a) => a.literal !== null) as Array<{ literal: string }>;
    if (manager) {
      for (const arg of literalArgs) {
        const base = literalBasename(arg.literal);
        if (!base) continue;
        const owner = lockfileOwner(base);
        if (owner && owner !== manager) {
          findings.push({
            rule: 'lockfile-manager-mismatch',
            severity: 'warning',
            file,
            line: site.line,
            message: `hashFiles('${arg.literal}') references a ${owner} lockfile, but the workflow's setup step or packageManager field indicates ${manager}.`,
          });
        }
      }
    }

    if (args.some((a) => a.literal === null)) {
      // At least one pattern is a dynamic expression (context ref, format(), …) —
      // the match set cannot be determined statically, so matches-nothing/
      // matches-only-ignored/vendored-leading-glob are skipped for this call.
      continue;
    }
    const literalPatterns = literalArgs.map((a) => a.literal).filter((p) => p.length > 0);
    if (literalPatterns.length === 0) continue;

    const keyField = isCacheKeyField(site.step, site.fieldPath);

    let result;
    try {
      result = await evaluateHashFilesPatterns(literalPatterns, workspace, followSymbolicLinks);
    } catch (err) {
      const message =
        err instanceof InvalidPatternError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      findings.push({
        rule: 'invalid-pattern',
        severity: 'warning',
        file,
        line: site.line,
        message: `hashFiles(${quoteArgs(literalPatterns)}) could not be evaluated: ${message}`,
      });
      continue;
    }

    if (result.matchedFiles.length === 0) {
      // A step earlier in the same job/composite-action might generate the
      // file this pattern names (e.g. `composer update` before a cache step
      // keyed on `composer.lock`) — if so this isn't wrong, just a checkout-
      // time false alarm, and should read as a warning, not an error.
      const earlierRunSteps =
        site.step?.stepsListId !== undefined && site.step.index !== undefined
          ? steps.filter(
              (s) =>
                s.stepsListId === site.step!.stepsListId &&
                s.index !== undefined &&
                s.index < site.step!.index! &&
                s.hasRun,
            )
          : [];
      const singlePattern = literalPatterns.length === 1 ? literalPatterns[0]! : undefined;
      const basename = singlePattern ? literalBasename(singlePattern) : undefined;
      const generating = findGeneratingStep(basename, earlierRunSteps);

      let hint = '';
      const dir = singlePattern ? literalDirname(singlePattern) : undefined;
      if (basename && dir !== undefined) {
        const nearMiss = findNearMiss(basename, dir, workspace);
        if (nearMiss) hint = ` Did you mean '${dir ? `${dir}/${nearMiss}` : nearMiss}'?`;
      }

      if (generating) {
        const line = generating.step.runLine ?? '?';
        const source = generating.confident
          ? `it only exists once the earlier step at line ${line} generates it`
          : `it may be generated by the earlier run step at line ${line} (unconfirmed — that step doesn't obviously name the tool)`;
        findings.push({
          rule: 'matches-nothing',
          severity: 'warning',
          file,
          line: site.line,
          message: `hashFiles(${quoteArgs(literalPatterns)}) matches no file currently in the checkout — ${source}. If it never appears, the cache key is constant.${hint}`,
        });
      } else {
        findings.push({
          rule: 'matches-nothing',
          severity: 'error',
          file,
          line: site.line,
          message: `hashFiles(${quoteArgs(literalPatterns)}) matches no files — it resolves to '' and${
            keyField ? ' the cache key becomes constant' : ' the expression is always empty'
          }.${hint}`,
        });
      }
      continue;
    }

    const relMatches = result.matchedFiles.map((f) => path.relative(workspace, f));
    const ignoredOnly = relMatches.every((r) => IGNORED_DIR_RE.test(r));
    if (ignoredOnly) {
      const dirs = new Set<string>();
      for (const r of relMatches) {
        const d = matchedDirName(r, IGNORED_DIR_RE);
        if (d) dirs.add(d);
      }
      findings.push({
        rule: 'matches-only-ignored',
        severity: 'warning',
        file,
        line: site.line,
        message: `hashFiles(${quoteArgs(literalPatterns)}) only matches files under ${[...dirs].join(' and ')} — @actions/glob does not exclude these by default.`,
      });
    } else {
      for (const pattern of literalPatterns) {
        if (!pattern.startsWith('**/')) continue;
        const vendored = relMatches.filter((r) => VENDOR_DIR_RE.test(r));
        if (vendored.length > 0 && vendored.length < relMatches.length) {
          findings.push({
            rule: 'vendored-leading-glob',
            severity: 'info',
            file,
            line: site.line,
            message: `hashFiles('${pattern}') also matches vendored cop${
              vendored.length === 1 ? 'y' : 'ies'
            } via the leading '**/': ${vendored.slice(0, 3).join(', ')}${vendored.length > 3 ? ', …' : ''}.`,
          });
        }
      }
    }
  }

  findings.push(...findStaticCacheKeys(steps, file));

  return findings;
}
