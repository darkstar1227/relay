#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run('cargo', ['build', '--locked', '--features', 'test-fixtures']);
run('cargo', ['test', '--locked']);
const binary = path.join(root, 'target/debug', process.platform === 'win32' ? 'relay-core.exe' : 'relay-core');
run(process.execPath, ['--test', 'tests/core/operations.test.cjs'], { ...process.env, RELAY_CORE_TEST_BIN: binary });
run(process.execPath, ['--test', 'tests/core/portable.test.cjs'], { ...process.env, RELAY_CORE_TEST_BIN: binary });
run(process.execPath, ['--test', 'tests/core/network.test.cjs'], { ...process.env, RELAY_CORE_TEST_BIN: binary });
// POSIX public-CLI tests exercise migrated operations through the real adapter.
if (process.platform !== 'win32') {
  run(process.execPath, ['--test', 'tests/cli.test.cjs', 'tests/daemon.test.cjs', 'tests/credential-lock.test.cjs'],
    { ...process.env, RELAY_CORE_BIN: binary });
}
