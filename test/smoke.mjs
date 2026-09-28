/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'dist', 'cli.js');
const fixtures = path.join(here, 'fixtures');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout };
  }
}

test('exits 0 and reports clean on a workflow with no findings', () => {
  const { code, stdout } = run([path.join(fixtures, 'clean')]);
  assert.equal(code, 0);
  assert.match(stdout, /clean/);
});

test('exits 1 and reports the finding on a workflow with a dead pattern', () => {
  const { code, stdout } = run([path.join(fixtures, 'matches-nothing')]);
  assert.equal(code, 1);
  assert.match(stdout, /matches-nothing/);
  assert.match(stdout, /bun\.lockb/);
});

test('--format json emits well-formed JSON with the finding', () => {
  const { code, stdout } = run([path.join(fixtures, 'matches-nothing'), '--format', 'json']);
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].rule, 'matches-nothing');
});

test('--format github emits a workflow error command', () => {
  const { code, stdout } = run([path.join(fixtures, 'matches-nothing'), '--format', 'github']);
  assert.equal(code, 1);
  assert.match(stdout, /^::error file=/m);
});

test('exits 2 on a directory with an unparseable workflow file', () => {
  const dir = fs.mkdtempSync(path.join(fixtures, '..', '..', '.tmp-smoke-'));
  try {
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), 'jobs: [this is not: valid: yaml');
    const { code, stdout } = run([dir]);
    assert.equal(code, 2);
    assert.match(stdout, /could not analyse/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
