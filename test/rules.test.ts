import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { lintPath } from '../src/index.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

test('matches-nothing: a pattern with no matching file is an error', async () => {
  const report = await lintPath(fixture('matches-nothing'));
  assert.equal(report.errors.length, 0);
  const findings = report.findings.filter((f) => f.rule === 'matches-nothing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'error');
  assert.match(findings[0]!.message, /bun\.lockb/);
});

test('matches-only-ignored: a pattern that only reaches into node_modules is a warning', async () => {
  const report = await lintPath(fixture('matches-only-ignored'));
  const findings = report.findings.filter((f) => f.rule === 'matches-only-ignored');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'warning');
  assert.match(findings[0]!.message, /node_modules/);
  // and must NOT also be reported as matches-nothing, since it did match something
  assert.equal(report.findings.some((f) => f.rule === 'matches-nothing'), false);
});

test("vendored-leading-glob: a leading '**/' pulling in a vendored copy is info", async () => {
  const report = await lintPath(fixture('vendored-leading-glob'));
  const findings = report.findings.filter((f) => f.rule === 'vendored-leading-glob');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'info');
  assert.match(findings[0]!.message, /vendor/);
});

test('static-cache-key: a key with no expression part at all is a warning', async () => {
  const report = await lintPath(fixture('static-cache-key'));
  const findings = report.findings.filter((f) => f.rule === 'static-cache-key');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'warning');
  assert.match(findings[0]!.message, /deps-cache/);
});

test('lockfile-manager-mismatch: hashFiles on the wrong manager lockfile is a warning', async () => {
  const report = await lintPath(fixture('lockfile-manager-mismatch'));
  const findings = report.findings.filter((f) => f.rule === 'lockfile-manager-mismatch');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /yarn.*npm/);
});

test('clean fixture: no findings (negative control)', async () => {
  const report = await lintPath(fixture('clean'));
  assert.equal(report.errors.length, 0);
  assert.deepEqual(report.findings, []);
});

test('reports the correct line number for a matches-nothing finding', async () => {
  const report = await lintPath(fixture('matches-nothing'));
  const finding = report.findings.find((f) => f.rule === 'matches-nothing')!;
  assert.equal(finding.line, 11); // the `key:` line in the fixture workflow
});

test('generated-file: an earlier run step in the same job downgrades matches-nothing to a warning', async () => {
  const report = await lintPath(fixture('generated-file'));
  const findings = report.findings.filter((f) => f.rule === 'matches-nothing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'warning');
  assert.match(findings[0]!.message, /composer\.lock/);
  assert.match(findings[0]!.message, /line 8/); // the `run: composer update` line
});

test('generated-file-after: a run step AFTER the hashFiles use does not downgrade — stays an error', async () => {
  const report = await lintPath(fixture('generated-file-after'));
  const findings = report.findings.filter((f) => f.rule === 'matches-nothing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, 'error');
});

test('near-miss: bun.lockb absent but bun.lock present in the same directory gets a "did you mean" hint', async () => {
  const report = await lintPath(fixture('near-miss-bun'));
  const findings = report.findings.filter((f) => f.rule === 'matches-nothing');
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /Did you mean 'bun\.lock'\?/);
});

test('paths are reported relative to the analysed root, never a "../" chain, when run from elsewhere', async () => {
  const priorCwd = process.cwd();
  process.chdir('/');
  try {
    const report = await lintPath(fixture('matches-nothing'));
    assert.equal(report.findings.length > 0, true);
    for (const f of report.findings) {
      assert.equal(f.file.includes('..'), false, `unexpected '..' in reported path: ${f.file}`);
    }
    assert.equal(report.findings[0]!.file, path.join('.github', 'workflows', 'test.yml'));
  } finally {
    process.chdir(priorCwd);
  }
});
