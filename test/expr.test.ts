import assert from 'node:assert/strict';
import test from 'node:test';
import { findHashFilesCalls } from '../src/expr.ts';

test('parses a single literal argument', () => {
  const calls = findHashFilesCalls("key: ${{ hashFiles('bun.lockb') }}");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.args.map((a) => a.literal),
    ['bun.lockb'],
  );
});

test('parses multiple comma-separated literal arguments', () => {
  const calls = findHashFilesCalls("${{ hashFiles('**/package-lock.json', '**/yarn.lock') }}");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.args.map((a) => a.literal),
    ['**/package-lock.json', '**/yarn.lock'],
  );
});

test('unescapes doubled single quotes inside a literal', () => {
  const calls = findHashFilesCalls("hashFiles('it''s/here.lock')");
  assert.equal(calls[0]!.args[0]!.literal, "it's/here.lock");
});

test('treats a nested function call argument as dynamic (non-literal)', () => {
  const calls = findHashFilesCalls("hashFiles(format('{0}/package.json', matrix.dir))");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args.length, 1);
  assert.equal(calls[0]!.args[0]!.literal, null);
});

test('treats a bare context reference as dynamic', () => {
  const calls = findHashFilesCalls('hashFiles(matrix.lockfile)');
  assert.equal(calls[0]!.args[0]!.literal, null);
});

test('is case-insensitive on the function name', () => {
  const calls = findHashFilesCalls("HashFiles('a.lock')");
  assert.equal(calls.length, 1);
});

test('ignores a call on a commented-out line', () => {
  const calls = findHashFilesCalls("      # key: ${{ hashFiles('bun.lockb') }}\n      key: static");
  assert.equal(calls.length, 0);
});

test('does not ignore a call when # appears only inside a string', () => {
  const calls = findHashFilesCalls("hashFiles('weird#name.lock')");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.args[0]!.literal, 'weird#name.lock');
});

test('recognizes the --follow-symbolic-links first argument as a literal', () => {
  const calls = findHashFilesCalls("hashFiles('--follow-symbolic-links', 'a.lock')");
  assert.equal(calls[0]!.args[0]!.literal, '--follow-symbolic-links');
  assert.equal(calls[0]!.args[1]!.literal, 'a.lock');
});

test('finds two separate calls in one string', () => {
  const calls = findHashFilesCalls("prefix-${{ hashFiles('a.lock') }}-${{ hashFiles('b.lock') }}");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.args[0]!.literal, 'a.lock');
  assert.equal(calls[1]!.args[0]!.literal, 'b.lock');
});
