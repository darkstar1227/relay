#!/usr/bin/env node
'use strict';
// Isolated instrumented build. Does not replace target/debug or target/release.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(root, 'target/core-coverage-'));
const profiles = path.join(dir, 'profiles'); fs.mkdirSync(profiles);
const env = { ...process.env, CARGO_TARGET_DIR: dir, RUSTFLAGS: '-C instrument-coverage', LLVM_PROFILE_FILE: path.join(profiles, '%m-%p.profraw') };
const llvm = process.env.RELAY_LLVM_BIN || '/opt/homebrew/opt/llvm/bin';
function run(name, command, args, extra = {}) {
  const r = spawnSync(command, args, { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(dir, name + '.log'), (r.stdout || '') + (r.stderr || ''));
  if (r.error || r.status !== 0) throw new Error(`${name} failed; evidence: ${dir}/${name}.log`);
  console.log(`${name}: passed`); return r.stdout;
}
run('build', 'cargo', ['build', '--locked', '--features', 'test-fixtures']);
const compiled = run('unit-build', 'cargo', ['test', '--locked', '--no-run', '--message-format=json']);
const units = compiled.split('\n').filter(Boolean).map(x => JSON.parse(x)).filter(x => x.reason === 'compiler-artifact' && x.profile.test && x.executable).map(x => x.executable);
for (let i = 0; i < units.length; i++) run('unit-' + i, units[i], []);
const binary = path.join(dir, 'debug/relay-core');
run('integration', process.execPath, ['--test', '--test-reporter=tap', 'tests/core/operations.test.cjs', 'tests/core/portable.test.cjs', 'tests/core/network.test.cjs'], { RELAY_CORE_TEST_BIN: binary });
run('adapter', process.execPath, ['--test', '--test-reporter=tap', 'tests/cli.test.cjs', 'tests/daemon.test.cjs', 'tests/credential-lock.test.cjs'], { RELAY_CORE_BIN: binary });
const raw = fs.readdirSync(profiles).filter(x => x.endsWith('.profraw')).map(x => path.join(profiles, x));
const merged = path.join(dir, 'coverage.profdata');
run('merge', path.join(llvm, 'llvm-profdata'), ['merge', '-sparse', ...raw, '-o', merged]);
const data = JSON.parse(run('export', path.join(llvm, 'llvm-cov'), ['export', binary, ...units.flatMap(x => ['-object', x]), '-instr-profile=' + merged]));
const files = data.data.flatMap(x => x.files).filter(x => x.filename.startsWith(path.join(root, 'crates/relay-core/src') + path.sep));
const summary = files.map(x => ({ file: path.relative(root, x.filename), ...x.summary }));
const lines = summary.reduce((a, x) => ({ count: a.count + x.lines.count, covered: a.covered + x.lines.covered }), { count: 0, covered: 0 });
const result = { directory: dir, profiles: raw.length, lines, line_percent: lines.covered / lines.count * 100,
  branch_coverage: 'UNKNOWN: stable instrument-coverage does not provide a usable branch denominator here', files: summary };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ directory: dir, lines, line_percent: result.line_percent }));
