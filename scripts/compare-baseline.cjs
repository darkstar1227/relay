#!/usr/bin/env node
'use strict';
// Stage-one acceptance check against the immutable, released source revision.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { assemble } = require('./build.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--baseline' || !/^[a-f0-9]{7,40}$/i.test(args[1]))) {
  throw new Error('Usage: node scripts/compare-baseline.cjs [--baseline commit-sha]');
}
const baseline = args[1] || 'b40c791cab7ece474119071db8f15f840453dab0';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-baseline-'));

try {
  const source = execFileSync('git', ['show', `${baseline}:relay`], { cwd: root, encoding: 'utf8' });
  const pkg = execFileSync('git', ['show', `${baseline}:package.json`], { cwd: root });
  const generated = assemble();
  assert.ok(generated === fs.readFileSync(path.join(root, 'relay'), 'utf8'), 'Generated artifact is stale');
  fs.writeFileSync(path.join(temporary, 'relay'), source);
  fs.writeFileSync(path.join(temporary, 'package.json'), pkg);
  console.log(`Baseline ${baseline}; original SHA-256 ${createHash('sha256').update(source).digest('hex')}`);
  console.log('Candidate includes documented updater acceptance fixes; comparing unchanged account/daemon behavior below');
  for (const [label, script, version] of [
    ['baseline', path.join(temporary, 'relay'), JSON.parse(pkg).version],
    ['candidate', path.join(root, 'relay'), require('../package.json').version],
  ]) {
    const result = spawnSync(process.execPath, ['--test', 'tests/cli.test.cjs', 'tests/daemon.test.cjs'], {
      cwd: root, env: { ...process.env, RELAY_TEST_SCRIPT: script, RELAY_TEST_VERSION: version, RELAY_CORE_BIN: '' }, encoding: 'utf8', timeout: 90000,
    });
    console.log(`${label}:`);
    const output = result.status === 0
      ? result.stdout.split('\n').filter(line => /^# (tests|pass|fail|duration_ms)/.test(line)).join('\n')
      : result.stdout + result.stderr;
    console.log(output);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${label} behavior regression`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
