#!/usr/bin/env node
'use strict';
// Pack once, install that exact tarball in a disposable prefix, then smoke-test
// the installed entrypoint. --pack-dir retains the verified tarball for CI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { version } = require('../package.json');
const { sandbox } = require('../tests/support/sandbox.cjs');

function main(args) {
  if (args.length && (args.length !== 2 || !['--pack-dir', '--tarball'].includes(args[0]))) {
    throw new Error('Usage: node scripts/verify-package.cjs [--pack-dir directory | --tarball file]');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-package-'));
  const cleanups = [];
  try {
    const baseEnv = { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') };
    function run(command, commandArgs, options = {}) {
      const result = spawnSync(command, commandArgs, {
        cwd: root, env: baseEnv, encoding: 'utf8', timeout: 90000, ...options,
      });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    }
    // npm_execpath is supplied by npm scripts. Direct invocations resolve the
    // npm CLI next to Node on Windows, avoiding shell quoting of tarball paths.
    const npmCli = process.env.npm_execpath || (process.platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : null);
    const npm = npmCli ? [process.execPath, [npmCli]] : ['npm', []];
    const runNpm = (a, options) => run(npm[0], [...npm[1], ...a], options);
    let tarball;
    if (args[0] === '--tarball') {
      tarball = path.resolve(args[1]);
    } else {
      run(process.execPath, [path.join(root, 'scripts/build.cjs'), '--check']);
      const directory = args[0] === '--pack-dir' ? path.resolve(args[1]) : temp;
      fs.mkdirSync(directory, { recursive: true });
      const [packed] = JSON.parse(runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory]));
      const files = new Set(packed.files.map(file => file.path));
      for (const name of ['relay', 'relay.js', 'relay.ps1', 'relay.cmd', 'postinstall.js', 'package.json']) {
        assert.ok(files.has(name), `Missing package runtime: ${name}`);
      }
      assert.ok(![...files].some(name => /^(src|tests|scripts)\//.test(name)), 'Development sources leaked into package');
      tarball = path.join(directory, packed.filename);
    }
    const prefix = path.join(temp, 'install with spaces');
    runNpm(['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball]);
    const installed = path.join(prefix, 'node_modules/@dst-justin/relay');
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'))).version, version);
    assert.ok(fs.readFileSync(path.join(installed, 'relay')).equals(fs.readFileSync(path.join(root, 'relay'))));

    const fixture = process.platform === 'win32' ? null : sandbox({ after(fn) { cleanups.push(fn); } });
    const home = fixture ? fixture.home : path.join(temp, 'profile');
    fs.mkdirSync(home, { recursive: true });
    const env = {
      ...(fixture ? fixture.env : baseEnv), HOME: home, USERPROFILE: home,
      RELAY_TEST_HOME: home,
      APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      npm_config_cache: path.join(temp, 'npm-cache'), npm_config_prefix: prefix,
      PATH: path.join(prefix, 'bin') + path.delimiter + (fixture ? fixture.env.PATH : process.env.PATH),
    };
    if (process.platform === 'win32') {
      run(process.execPath, [path.join(root, 'scripts/remote-profile-probe.cjs')], { env });
    }
    // Run the real lifecycle in the isolated prefix, including executable mode.
    runNpm(['run', 'postinstall', '--prefix', installed], { env });
    const output = run(process.execPath, [path.join(installed, 'relay.js'), 'version'], { cwd: home, env });
    assert.equal(output.trim(), `relay ${version}`);
    const help = run(process.execPath, [path.join(installed, 'relay.js'), 'help'], { cwd: home, env });
    assert.ok(help.includes('relay'), 'Installed launcher did not render help');
    if (process.platform === 'win32') {
      console.log(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(root, 'tests/windows-smoke.ps1'), '-RelayPath', path.join(installed, 'relay.ps1')], { env }).trim());
    }
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(installed, 'relay')).mode & 0o111);
    console.log(`Validated ${tarball} on ${process.platform}/${process.arch} with Node ${process.versions.node}`);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
