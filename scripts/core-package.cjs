#!/usr/bin/env node
'use strict';
// Native POSIX core packaging only. Never publishes or changes the default runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { sandbox, root } = require('../tests/support/sandbox.cjs');
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};
function validateInfo(info, version, platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  assert.ok(targets[key], 'Unsupported native core package platform');
  assert.equal(info.version, version, 'Core/package version mismatch');
  assert.equal(info.protocol, 1, 'Unsupported core protocol');
  assert.equal(info.target, targets[key], 'Wrong core target or libc');
  assert.equal(info.profile, 'release', 'Core must be a release build');
  assert.equal(info.test_fixtures, false, 'Test fixtures must not ship');
  return `@dst-justin/relay-core-${key}`;
}
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function verifyInstalled(directory, version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'core-manifest.json')));
  assert.equal(pkg.name, validateInfo(manifest.build, version));
  assert.equal(pkg.version, version);
  const binary = path.join(directory, 'bin/relay-core');
  assert.ok(fs.lstatSync(binary).isFile(), 'Core must be a regular file');
  assert.equal(fs.statSync(binary).size, manifest.bytes, 'Core size mismatch');
  assert.equal(digest(binary), manifest.sha256, 'Core checksum mismatch');
  return binary;
}
function main(args) {
  if (args.length > 1) throw new Error('Usage: node scripts/core-package.cjs [output-directory]');
  const version = require('../package.json').version;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-core-package-'));
  const cleanups = [];
  try {
    const env = { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') };
    function run(command, args, options = {}) {
      const r = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 90000, ...options });
      if (r.error) throw r.error;
      assert.equal(r.status, 0, `${command} failed: ${r.stderr}`);
      return r.stdout;
    }
    const binary = path.join(root, 'target/release/relay-core');
    assert.ok(fs.lstatSync(binary).isFile(), 'Build the release core first');
    const info = JSON.parse(run(binary, ['artifact-info']));
    const name = validateInfo(info, version);
    assert.equal(run(binary, ['protocol']).trim(), `relay-core 1 ${version}`);
    run(process.execPath, ['scripts/build.cjs', '--check']);
    const stage = path.join(temp, 'stage');
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    fs.copyFileSync(binary, path.join(stage, 'bin/relay-core'));
    fs.chmodSync(path.join(stage, 'bin/relay-core'), 0o755);
    const manifest = { build: info, sha256: digest(binary), bytes: fs.statSync(binary).size };
    fs.writeFileSync(path.join(stage, 'core-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name, version,
      description: 'Version-paired internal Relay Rust core', license: 'MIT',
      os: [process.platform], cpu: [process.arch], files: ['bin/relay-core', 'core-manifest.json'],
      ...(process.platform === 'linux' ? { libc: ['glibc'] } : {}),
    }, null, 2) + '\n');
    const npm = (args, options) => process.env.npm_execpath
      ? run(process.execPath, [process.env.npm_execpath, ...args], options)
      : run('npm', args, options);
    const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: stage }));
    assert.deepEqual(packed.files.map(f => f.path).sort(), ['bin/relay-core', 'core-manifest.json', 'package.json']);
    const tarball = path.join(temp, packed.filename);
    const prefix = path.join(temp, 'install with spaces');
    npm(['install', '--offline', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball]);
    const installed = path.join(prefix, 'node_modules', name);
    const installedBinary = verifyInstalled(installed, version);
    assert.deepEqual(JSON.parse(run(installedBinary, ['artifact-info'])), info);
    assert.equal(run(installedBinary, ['protocol']).trim(), `relay-core 1 ${version}`);
    const fixture = sandbox({ after(fn) { cleanups.push(fn); } });
    fixture.account('fixture');
    for (const command of ['python3', 'python']) fs.writeFileSync(path.join(fixture.bin, command), '#!/bin/sh\nexit 92\n', { mode: 0o755 });
    for (const args of [['version'], ['list', '--no-usage'], ['lock', 'fixture']]) {
      const r = fixture.run(args, '', { RELAY_CORE_BIN: installedBinary });
      assert.equal(r.status, 0, `Installed core CLI ${args.join(' ')}: ${r.stderr}`);
    }
    // Exercise checksum detection on the disposable installed copy, not source.
    fs.appendFileSync(installedBinary, 'tampered');
    assert.throws(() => verifyInstalled(installed, version), /size mismatch/);
    fs.truncateSync(installedBinary, manifest.bytes);
    const corrupt = fs.readFileSync(installedBinary);
    corrupt[0] ^= 1;
    fs.writeFileSync(installedBinary, corrupt);
    assert.throws(() => verifyInstalled(installed, version), /checksum mismatch/);
    const out = args[0] ? path.resolve(args[0]) : null;
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      // Never overwrite an already-produced release artifact implicitly.
      fs.copyFileSync(tarball, path.join(out, packed.filename), fs.constants.COPYFILE_EXCL);
    }
    console.log(JSON.stringify({ name, version, platform: process.platform, arch: process.arch,
      binary_bytes: manifest.bytes, tarball_bytes: fs.statSync(tarball).size,
      sha256: digest(tarball), installed_and_verified: true,
      artifact: out ? path.join(out, packed.filename) : 'temporary artifact cleaned after validation',
    }, null, 2));
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { validateInfo, verifyInstalled, targets };
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
