'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { install, rollback } = require('../../scripts/pair-install.cjs');
const root = path.resolve(__dirname, '../..');
const binary = path.join(root, 'target/release/relay-core');
const version = require('../../package.json').version;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pair-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main'), core = path.join(dir, 'core'), dest = path.join(dir, 'installed with spaces');
  fs.mkdirSync(main); fs.mkdirSync(path.join(core, 'bin'), { recursive: true });
  for (const name of ['package.json', 'relay', 'relay.js', 'relay.ps1', 'relay.cmd', 'postinstall.js']) fs.copyFileSync(path.join(root, name), path.join(main, name));
  const r = spawnSync(binary, ['artifact-info'], { encoding: 'utf8' }); assert.equal(r.status, 0, 'Build release core first');
  const build = JSON.parse(r.stdout); assert.equal(build.profile, 'release'); assert.equal(build.test_fixtures, false);
  const name = require('../../scripts/core-package.cjs').validateInfo(build, version);
  fs.copyFileSync(binary, path.join(core, 'bin/relay-core'));
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(core, 'core-manifest.json'), JSON.stringify({ build, bytes: fs.statSync(binary).size, sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex') }));
  return { dir, main, core, dest, active: () => JSON.parse(fs.readFileSync(path.join(dest, 'active.json'))) };
}
test('native pairs install atomically, preserve the previous release and roll back', t => {
  const f = fixture(t); const first = install(f.main, f.core, f.dest);
  fs.appendFileSync(path.join(f.main, 'relay'), '\n# next fixture\n');
  const second = install(f.main, f.core, f.dest);
  assert.notEqual(first.release, second.release);
  assert.deepEqual(f.active(), { current: second.release, previous: first.release });
  rollback(f.dest); assert.deepEqual(f.active(), { current: first.release, previous: second.release });
  const home = path.join(f.dir, 'home'); fs.mkdirSync(home);
  const r = spawnSync(process.execPath, [path.join(f.dest, 'relay'), 'version'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), `relay ${version}`);
  assert.ok(fs.existsSync(path.join(f.dest, 'releases', second.release)));
});
test('corrupt or mismatched candidates do not change the active pair', t => {
  const f = fixture(t); install(f.main, f.core, f.dest); const old = f.active();
  fs.appendFileSync(path.join(f.core, 'bin/relay-core'), 'corrupt');
  assert.throws(() => install(f.main, f.core, f.dest), /size mismatch/); assert.deepEqual(f.active(), old);
  fs.copyFileSync(binary, path.join(f.core, 'bin/relay-core'));
  const p = JSON.parse(fs.readFileSync(path.join(f.main, 'package.json'))); p.version = '99.0.0';
  fs.writeFileSync(path.join(f.main, 'package.json'), JSON.stringify(p));
  assert.throws(() => install(f.main, f.core, f.dest), /version mismatch/); assert.deepEqual(f.active(), old);
  assert.equal(fs.readdirSync(path.join(f.dest, 'releases')).length, 1);
});
test('rollback validates old bytes and refuses tampered retained releases', t => {
  const f = fixture(t), first = install(f.main, f.core, f.dest); install(f.main, f.core, f.dest);
  const old = f.active(); fs.appendFileSync(path.join(f.dest, 'releases', first.release, 'main/relay'), 'tampered');
  assert.throws(() => rollback(f.dest), /checksum mismatch/); assert.deepEqual(f.active(), old);
});
test('unmanaged directories and concurrent installers fail closed', t => {
  const f = fixture(t); fs.mkdirSync(f.dest); fs.writeFileSync(path.join(f.dest, 'user-file'), 'preserve');
  assert.throws(() => install(f.main, f.core, f.dest), /unmanaged/);
  assert.deepEqual(fs.readdirSync(f.dest), ['user-file']);
  const managed = path.join(f.dir, 'managed'); install(f.main, f.core, managed);
  fs.mkdirSync(path.join(managed, '.install-lock'));
  assert.throws(() => install(f.main, f.core, managed), /EEXIST/);
});

test('candidate startup failure leaves the active pair unchanged', t => {
  const f = fixture(t); install(f.main, f.core, f.dest); const old = f.active();
  fs.writeFileSync(path.join(f.main, 'relay'), `#!/usr/bin/env bash\nRELAY_BUILD_VERSION='${version}'\nexit 23\n`);
  assert.throws(() => install(f.main, f.core, f.dest), /failed to start/);
  assert.deepEqual(f.active(), old);
});

test('failed activation rename retains the old pointer and recoverable candidate', t => {
  const f = fixture(t); install(f.main, f.core, f.dest); const old = f.active();
  const rename = fs.renameSync;
  fs.renameSync = (a, b) => {
    if (b === path.join(f.dest, 'active.json')) throw new Error('injected activation failure');
    return rename(a, b);
  };
  try { assert.throws(() => install(f.main, f.core, f.dest), /injected activation failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(f.active(), old);
  assert.equal(fs.readdirSync(path.join(f.dest, 'releases')).length, 2);
  assert.equal(fs.existsSync(path.join(f.dest, '.install-lock')), false);
});
