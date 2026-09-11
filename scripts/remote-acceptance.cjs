#!/usr/bin/env node
'use strict';
// Run only inside an explicitly marked disposable source checkout. No publish,
// global installation, real credentials, or service management is performed.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!path.basename(root).startsWith('relay-stage-11-')) throw new Error('Disposable checkout required');
const results = [];
function run(name, command, args, timeout = 600000) {
  const start = Date.now();
  const r = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C.UTF-8', RELAY_CORE_BIN: '' } });
  const output = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(root, `${name}.log`), output);
  const result = { name, status: r.status, signal: r.signal, error: r.error?.message,
    duration_ms: Date.now() - start, counts: output.split('\n').filter(x => /^(?:#|ℹ) (tests|pass|fail|skipped) |^test result:/.test(x)),
    tail: output.trim().split('\n').slice(-12) };
  results.push(result);
  fs.writeFileSync(path.join(root, 'acceptance-results.json'), JSON.stringify({
    version: require('../package.json').version, host: os.hostname(), platform: process.platform,
    arch: process.arch, node: process.version, results }, null, 2));
  console.log(JSON.stringify(result));
  return r.status === 0;
}
run('build-check', process.execPath, ['scripts/build.cjs', '--check']);
run('package-install', process.execPath, ['scripts/verify-package.cjs', '--tarball', 'dist/remote-stage-11/dst-justin-relay-2.9.2.tgz']);
if (process.platform === 'win32') {
  // Windows public CLI is still PowerShell. POSIX core operations and the full
  // integration suite are not Windows-supported; native compile is a probe.
  run('windows-core-build-probe', 'cargo', ['build', '--locked']);
} else {
  run('default-tests', process.execPath, ['--test', 'tests/build.test.cjs', 'tests/cli.test.cjs',
    'tests/daemon.test.cjs', 'tests/credential-lock.test.cjs', 'tests/core-package.test.cjs']);
  run('rust-core-tests', process.execPath, ['scripts/test-core.cjs']);
  if (run('release-build', 'cargo', ['build', '--release', '--locked'])) {
    run('core-package-install', process.execPath, ['scripts/core-package.cjs', 'dist/core-native']);
  }
}
process.exitCode = results.some(r => r.status !== 0) ? 1 : 0;
