'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
if (!path.basename(root).startsWith('relay-stage-11-')) throw new Error('Requires disposable remote checkout');
const env = { ...process.env, RELAY_CORE_BIN: '', LC_ALL: 'C.UTF-8' };
const results = [];
function run(name, cmd, args, extra = {}) {
  const start = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(root, 'final-' + name + '.log'), out);
  results.push({ name, status: r.status, error: r.error?.message, ms: Date.now() - start,
    counts: out.split('\n').filter(x => /^(#|ℹ) (tests|pass|fail|skipped)|^test result:/.test(x)) });
  fs.writeFileSync(path.join(root, 'final-results.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  return r.status === 0;
}
run('build-check', process.execPath, ['scripts/build.cjs', '--check']);
if (process.platform !== 'win32') {
  run('default', process.execPath, ['--test', '--test-reporter=tap', 'tests/build.test.cjs', 'tests/cli.test.cjs', 'tests/daemon.test.cjs', 'tests/credential-lock.test.cjs', 'tests/core-package.test.cjs', 'tests/update.test.cjs'], { RELAY_TEST_BASELINE_SCRIPT: path.join(root, 'baseline-2.9.0') });
  run('all-core', process.execPath, ['scripts/test-core.cjs']);
} else if (run('fixture-build', 'cargo', ['build', '--locked', '--features', 'test-fixtures'])) {
  run('unit', 'cargo', ['test', '--locked']);
  run('portable-and-oauth', process.execPath, ['--test', '--test-reporter=tap', 'tests/core/portable.test.cjs', 'tests/core/network.test.cjs'], { RELAY_CORE_TEST_BIN: path.join(root, 'target/debug/relay-core.exe') });
}
if (run('release', 'cargo', ['build', '--locked', '--release'])) {
  const binary = path.join(root, 'target/release', process.platform === 'win32' ? 'relay-core.exe' : 'relay-core');
  run('release-portable', process.execPath, ['--test', '--test-reporter=tap', 'tests/core/portable.test.cjs'], { RELAY_CORE_TEST_BIN: binary });
  for (const op of ['latest-version', 'check-update-bg']) run(op, binary, [op]);
  if (process.platform !== 'win32') run('native-package', process.execPath, ['scripts/core-package.cjs']);
}
process.exitCode = results.some(x => x.status !== 0) ? 1 : 0;
