#!/usr/bin/env node
'use strict';
// Offline POSIX paired installation from TRUSTED, unpacked npm artifacts.
// Hashes detect corruption, not publisher authenticity. Does not publish,
// download, mutate existing services, or change the default npm entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { verifyInstalled } = require('./core-package.cjs');
const files = ['package.json', 'relay', 'relay.js', 'relay.ps1', 'relay.cmd', 'postinstall.js'];
const marker = 'relay-paired-install-v1\n';
const digest = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const json = p => JSON.parse(fs.readFileSync(p));
const validID = s => typeof s === 'string' && /^release-[a-f0-9]{24}$/.test(s);
function regular(p) { assert.ok(fs.lstatSync(p).isFile(), 'Artifact must be a regular file'); }
function copy(from, to) { regular(from); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); }
function syncDirectory(p) { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function atomic(p, bytes) {
  const tmp = p + '.' + randomBytes(12).toString('hex');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, p); syncDirectory(path.dirname(p)); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function checkPair(dir) {
  assert.ok(fs.lstatSync(dir).isDirectory(), 'Release must not be a symlink');
  const record = json(path.join(dir, 'pair.json'));
  for (const name of files) {
    const p = path.join(dir, 'main', name); regular(p);
    assert.equal(digest(p), record.main[name], 'Main artifact checksum mismatch');
  }
  const version = json(path.join(dir, 'main/package.json')).version;
  assert.equal(json(path.join(dir, 'main/package.json')).name, '@dst-justin/relay');
  assert.equal(version, record.version);
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
  assert.equal(digest(path.join(dir, 'core/core-manifest.json')), record.core_manifest);
  const binary = verifyInstalled(path.join(dir, 'core'), version);
  const source = fs.readFileSync(path.join(dir, 'main/relay'), 'utf8');
  assert.ok(source.includes(`\nRELAY_BUILD_VERSION='${version}'\n`), 'Shell/core version mismatch');
  const r = spawnSync(binary, ['protocol'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, 'Core handshake failed');
  assert.equal(r.stdout.trim(), `relay-core 1 ${version}`);
  const info = spawnSync(binary, ['artifact-info'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(info.status, 0, 'Cannot inspect actual core metadata');
  assert.deepEqual(JSON.parse(info.stdout), json(path.join(dir, 'core/core-manifest.json')).build, 'Actual core metadata mismatch');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pair-probe-'));
  try {
    const r = spawnSync('/bin/bash', [path.join(dir, 'main/relay'), 'version'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_CORE_BIN: binary },
    });
    assert.equal(r.status, 0, 'Paired shell failed to start');
    assert.equal(r.stdout.trim(), `relay ${version}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return record;
}
const launcher = `#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process');
try {
  const state=JSON.parse(fs.readFileSync(path.join(__dirname,'active.json')));
  if(!/^release-[a-f0-9]{24}$/.test(state.current))throw Error('Invalid paired release');
  const release=path.join(__dirname,'releases',state.current);
  const r=cp.spawnSync('/bin/bash',[path.join(release,'main/relay'),...process.argv.slice(2)],
    {stdio:'inherit',env:{...process.env,RELAY_CORE_BIN:path.join(release,'core/bin/relay-core')}});
  if(r.error)throw Error('Cannot launch paired release');
  process.exitCode=r.status===null?1:r.status;
}catch(e){console.error('relay: paired installation unavailable');process.exitCode=1;}
`;
function transaction(destination, action) {
  assert.notEqual(process.platform, 'win32', 'Paired installer requires POSIX');
  destination = path.resolve(destination);
  assert.notEqual(destination, path.parse(destination).root);
  assert.notEqual(destination, os.homedir());
  if (!fs.existsSync(destination)) fs.mkdirSync(destination, { mode: 0o700 });
  assert.ok(fs.lstatSync(destination).isDirectory(), 'Destination must not be a symlink');
  const mark = path.join(destination, '.relay-pair');
  if (!fs.existsSync(mark)) {
    assert.equal(fs.readdirSync(destination).length, 0, 'Refusing unmanaged nonempty destination');
    fs.writeFileSync(mark, marker, { flag: 'wx', mode: 0o600 });
  }
  assert.equal(fs.readFileSync(mark, 'utf8'), marker, 'Unknown installation format');
  const lock = path.join(destination, '.install-lock');
  // Fail closed; a crash leaves an explicit stale lock requiring inspection.
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const releases = path.join(destination, 'releases');
    if (!fs.existsSync(releases)) fs.mkdirSync(releases, { mode: 0o700 });
    assert.ok(fs.lstatSync(releases).isDirectory());
    return action(destination, releases);
  } finally { fs.rmdirSync(lock); }
}
function stateAt(root) {
  const p = path.join(root, 'active.json');
  if (!fs.existsSync(p)) return { current: null, previous: null };
  const s = json(p); assert.ok(validID(s.current)); assert.ok(s.previous === null || validID(s.previous)); return s;
}
function install(main, core, destination) {
  return transaction(destination, (root, releases) => {
    const old = stateAt(root), id = 'release-' + randomBytes(12).toString('hex');
    const stage = path.join(releases, id); fs.mkdirSync(stage, { mode: 0o700 });
    let commitAttempted = false;
    try {
      fs.mkdirSync(path.join(stage, 'main')); fs.mkdirSync(path.join(stage, 'core'));
      fs.mkdirSync(path.join(stage, 'core/bin'));
      for (const name of files) copy(path.join(main, name), path.join(stage, 'main', name));
      for (const name of ['package.json', 'core-manifest.json', 'bin/relay-core']) copy(path.join(core, name), path.join(stage, 'core', name));
      fs.chmodSync(path.join(stage, 'core/bin/relay-core'), 0o755);
      const record = { version: json(path.join(stage, 'main/package.json')).version,
        main: Object.fromEntries(files.map(n => [n, digest(path.join(stage, 'main', n))])), core_manifest: digest(path.join(stage, 'core/core-manifest.json')) };
      fs.writeFileSync(path.join(stage, 'pair.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      checkPair(stage);
      // Flush candidate files before the one-file activation commit.
      for (const p of [...files.map(n => path.join(stage, 'main', n)), ...['package.json', 'core-manifest.json', 'bin/relay-core'].map(n => path.join(stage, 'core', n)), path.join(stage, 'pair.json')]) {
        const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      for (const p of ['main', 'core/bin', 'core', '']) syncDirectory(path.join(stage, p));
      syncDirectory(releases);
      const entry = path.join(root, 'relay');
      if (fs.existsSync(entry)) { regular(entry); assert.equal(fs.readFileSync(entry, 'utf8'), launcher, 'Managed launcher was modified'); }
      else {
        fs.writeFileSync(entry, launcher, { flag: 'wx', mode: 0o755 });
        const fd = fs.openSync(entry, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      commitAttempted = true;
      atomic(path.join(root, 'active.json'), JSON.stringify({ current: id, previous: old.current }));
      return { version: record.version, release: id, previous: old.current, launcher: entry };
    } catch (e) {
      // After commit was attempted, retain candidate for crash recovery even if
      // directory sync failed; never delete a possibly active release.
      if (!commitAttempted) fs.rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  });
}
function rollback(destination) {
  return transaction(destination, (root, releases) => {
    const old = stateAt(root); assert.ok(old.previous, 'No previous paired release');
    checkPair(path.join(releases, old.previous));
    atomic(path.join(root, 'active.json'), JSON.stringify({ current: old.previous, previous: old.current }));
    return { release: old.previous, previous: old.current };
  });
}
module.exports = { install, rollback, checkPair };
if (require.main === module) {
  try {
    const [op, ...args] = process.argv.slice(2);
    if (op === 'install' && args.length === 3) console.log(JSON.stringify(install(...args)));
    else if (op === 'rollback' && args.length === 1) console.log(JSON.stringify(rollback(...args)));
    else throw Error('Usage: pair-install.cjs install <unpacked-main> <unpacked-core> <new-directory> | rollback <directory>');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
