/**
 * Compares our evaluator's match set against @actions/glob itself, called
 * the same way (patterns joined by '\n', a single glob.create()) — the
 * actual dependency the runner's hashFiles uses. This is not a test of our
 * own logic in a vacuum: it is the ground truth the spec asked for.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as glob from '@actions/glob';
import { evaluateHashFilesPatterns } from '../src/glob-eval.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function realGlobMatch(patterns: string[], cwd: string): Promise<string[]> {
  const prior = process.cwd();
  process.chdir(cwd);
  try {
    const globber = await glob.create(patterns.join('\n'), { followSymbolicLinks: false });
    const files: string[] = [];
    for await (const f of globber.globGenerator()) {
      if (!fs.statSync(f).isDirectory()) files.push(f);
    }
    return files.sort();
  } finally {
    process.chdir(prior);
  }
}

test('ground truth: matches-nothing fixture — @actions/glob itself finds nothing for bun.lockb', async () => {
  const dir = path.join(FIXTURES, 'matches-nothing');
  const real = await realGlobMatch(['bun.lockb'], dir);
  assert.deepEqual(real, []);
  const ours = await evaluateHashFilesPatterns(['bun.lockb'], dir, false);
  assert.deepEqual(ours.matchedFiles, []);
});

test('ground truth: clean fixture — our match set equals @actions/glob directly', async () => {
  const dir = path.join(FIXTURES, 'clean');
  const real = await realGlobMatch(['package-lock.json'], dir);
  const ours = await evaluateHashFilesPatterns(['package-lock.json'], dir, false);
  assert.deepEqual(ours.matchedFiles.sort(), real);
  assert.equal(real.length, 1);
});

test('ground truth: a leading "!" negation removes a match, matching @actions/glob directly', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hashfiles-lint-negate-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.lock'), '');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.lock'), '');

    const patterns = ['**/*.lock', '!sub/**'];
    const real = await realGlobMatch(patterns, dir);
    const ours = await evaluateHashFilesPatterns(patterns, dir, false);

    assert.deepEqual(ours.matchedFiles.sort(), real);
    assert.equal(real.length, 1);
    assert.match(real[0]!, /a\.lock$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ground truth: followSymbolicLinks defaults to false, unlike @actions/glob itself', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hashfiles-lint-symlink-'));
  try {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'hashfiles-lint-symlink-target-'));
    fs.writeFileSync(path.join(real, 'target.lock'), '');
    fs.symlinkSync(real, path.join(dir, 'linked'), 'dir');

    // @actions/glob's own default (no options passed) follows symlinks.
    const globberDefault = await (async () => {
      const prior = process.cwd();
      process.chdir(dir);
      try {
        const g = await glob.create('**/*.lock');
        const files: string[] = [];
        for await (const f of g.globGenerator()) if (!fs.statSync(f).isDirectory()) files.push(f);
        return files;
      } finally {
        process.chdir(prior);
      }
    })();
    assert.equal(globberDefault.length, 1, '@actions/glob default follows the symlink');

    const ours = await evaluateHashFilesPatterns(['**/*.lock'], dir, false);
    assert.equal(ours.matchedFiles.length, 0, 'the runner does not follow symlinks unless asked to');

    const oursFollowing = await evaluateHashFilesPatterns(['**/*.lock'], dir, true);
    assert.equal(oursFollowing.matchedFiles.length, 1);

    fs.rmSync(real, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
