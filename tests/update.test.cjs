'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { sandbox, root, version } = require('./support/sandbox.cjs');
const latestURL = 'https://api.github.com/repos/darkstar1227/relay/releases/latest';
const registryURL = 'https://registry.npmjs.org/@dst-justin%2frelay/latest';
const downloadURL = `https://raw.githubusercontent.com/darkstar1227/relay/v${version}/relay`;

function installed(t, method = 'direct') {
  const s = sandbox(t);
  const dir = path.join(s.home, "install's directory");
  fs.mkdirSync(dir);
  const script = path.join(dir, 'relay');
  fs.copyFileSync(path.join(root, 'relay'), script);
  if (method === 'npm') fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  if (method === 'git') fs.mkdirSync(path.join(dir, '.git'));
  s.http({ [latestURL]: { tag_name: `v${version}` } });
  function run(args = ['update'], entry = script) {
    const result = spawnSync('/bin/bash', [entry, ...args], { cwd: s.home, env: s.env, encoding: 'utf8', timeout: 15000 });
    if (result.error) throw result.error;
    return result;
  }
  function shim(name, code) {
    fs.writeFileSync(path.join(s.bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  }
  return { ...s, dir, script, run, shim };
}

function outdated(s) {
  // A released, pre-modular executable exercises the actual old updater.
  const source = process.env.RELAY_TEST_BASELINE_SCRIPT
    ? fs.readFileSync(process.env.RELAY_TEST_BASELINE_SCRIPT)
    : execFileSync('git', ['show', 'b40c791:relay'], { cwd: root });
  assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'),
    '5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d');
  fs.writeFileSync(s.script, source);
}

test('single-file installs report their embedded release version', t => {
  const s = installed(t);
  const r = s.run(['version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `relay ${version}`);
});

test('the released v2.9.0 updater installs the assembled candidate and it starts', t => {
  const s = installed(t);
  outdated(s);
  s.http({ [latestURL]: { tag_name: `v${version}` }, [downloadURL]: { body_file: path.join(root, 'relay') } });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(s.script).equals(fs.readFileSync(path.join(root, 'relay'))));
  assert.equal(s.run(['version']).stdout.trim(), `relay ${version}`);
  assert.match(s.run(['help']).stdout, /relay proxy/);
});

for (const [label, response] of [['HTTP failure', { error: 503 }], ['invalid payload', null]]) {
  test(`direct update rejects ${label}, preserves the executable and returns failure`, t => {
    const s = installed(t);
    const next = '99.0.0';
    const bad = path.join(s.home, 'bad.txt'); fs.writeFileSync(bad, '<html>upstream unavailable</html>');
    s.http({ [latestURL]: { tag_name: `v${next}` }, [`https://raw.githubusercontent.com/darkstar1227/relay/v${next}/relay`]: response || { body_file: bad } });
    const before = fs.readFileSync(s.script);
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.ok(fs.readFileSync(s.script).equals(before));
    assert.doesNotMatch(r.stdout, /✓.*Updated/);
    assert.equal(s.run(['version']).stdout.trim(), `relay ${version}`);
  });
}

for (const method of ['npm', 'git']) {
  test(`${method} update failure propagates instead of reporting success`, t => {
    const s = installed(t, method);
    s.http({ [latestURL]: { tag_name: '99.0.0' } });
    s.shim(method, 'process.exit(23)');
    const r = s.run();
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /✓.*Updated/);
  });
}

test('npm update through a relative symlink selects npm and checks the installed version', t => {
  const s = installed(t, 'npm');
  const link = path.join(s.home, 'relative-relay');
  fs.symlinkSync(path.relative(s.home, s.script), link);
  s.env.RELAY_TEST_INSTALL = s.dir;
  s.shim('npm', `const fs=require('fs');
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['install','-g','@dst-justin/relay@${version}'])) process.exit(42);
    fs.writeFileSync(process.env.RELAY_TEST_INSTALL+'/package.json', JSON.stringify({version:'${version}'}));`);
  const r = s.run(['update'], link);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Updating via npm/);
  assert.equal(s.run(['version'], link).stdout.trim(), `relay ${version}`);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('GitHub release lookup falls back to the registry without making a false success claim', t => {
  const s = installed(t, 'npm');
  s.http({ [latestURL]: { error: 503 }, [registryURL]: { version } });
  s.env.RELAY_TEST_INSTALL = s.dir;
  s.shim('npm', `require('fs').writeFileSync(process.env.RELAY_TEST_INSTALL+'/package.json', JSON.stringify({version:'${version}'}))`);
  assert.equal(s.run().status, 0);
  assert.equal(s.run(['version']).stdout.trim(), `relay ${version}`);
});

test('a successful direct update preserves relative symlinks and executable mode', t => {
  const s = installed(t);
  const next = '99.0.0';
  const payload = path.join(s.home, 'candidate');
  fs.writeFileSync(payload, fs.readFileSync(s.script, 'utf8').replace(`RELAY_BUILD_VERSION='${version}'`, `RELAY_BUILD_VERSION='${next}'`));
  s.http({ [latestURL]: { tag_name: `v${next}` }, [`https://raw.githubusercontent.com/darkstar1227/relay/v${next}/relay`]: { body_file: payload } });
  const links = path.join(s.home, 'links'); fs.mkdirSync(links);
  const link = path.join(links, 'relay'); fs.symlinkSync(path.relative(links, s.script), link);
  const r = s.run(['update'], link);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.readFileSync(s.script).equals(fs.readFileSync(payload)));
  assert.equal(fs.statSync(s.script).mode & 0o777, 0o755);
  assert.equal(s.run(['version'], link).stdout.trim(), `relay ${next}`);
});

for (const [label, content] of [
  ['Bash syntax error', '#!/usr/bin/env bash\nif then\n'],
  ['wrong embedded version', "#!/usr/bin/env bash\nRELAY_BUILD_VERSION='98.0.0'\n"],
]) {
  test(`direct update rejects ${label} without leaving temporary downloads`, t => {
    const s = installed(t);
    const payload = path.join(s.home, 'candidate'); fs.writeFileSync(payload, content);
    s.http({ [latestURL]: { tag_name: 'v99.0.0' }, 'https://raw.githubusercontent.com/darkstar1227/relay/v99.0.0/relay': { body_file: payload } });
    const before = fs.readFileSync(s.script);
    assert.notEqual(s.run().status, 0);
    assert.ok(fs.readFileSync(s.script).equals(before));
    assert.deepEqual(fs.readdirSync(s.dir), ['relay']);
  });
}

test('npm returning success without installing the selected version is rejected', t => {
  const s = installed(t, 'npm');
  s.shim('npm', 'process.exit(0)');
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not install/);
});

test('Git worktrees are recognized and a local fast-forward update is usable', t => {
  const s = installed(t);
  const remote = path.join(s.home, 'remote.git'), author = path.join(s.home, 'author');
  Object.assign(s.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const gitEnv = { ...s.env };
  function git(args) { return execFileSync('git', args, { cwd: s.home, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  git(['init', '--bare', remote]); git(['clone', remote, author]);
  git(['-C', author, 'config', 'user.name', 'Relay test']); git(['-C', author, 'config', 'user.email', 'test@example.test']);
  fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  fs.copyFileSync(s.script, path.join(author, 'relay'));
  git(['-C', author, 'add', '.']); git(['-C', author, 'commit', '-m', 'old fixture']); git(['-C', author, 'push', '-u', 'origin', 'HEAD']);
  const clone = path.join(s.home, 'checkout'); git(['clone', remote, clone]);
  const worktree = path.join(s.home, 'worktree'); git(['-C', clone, 'worktree', 'add', '-b', 'test-update', worktree]);
  const branch = git(['-C', author, 'branch', '--show-current']).trim();
  git(['-C', worktree, 'branch', '--set-upstream-to', `origin/${branch}`]);
  fs.writeFileSync(path.join(author, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(author, 'updated-marker'), 'new revision');
  git(['-C', author, 'add', '.']); git(['-C', author, 'commit', '-m', 'new fixture']); git(['-C', author, 'push']);
  const r = s.run(['update'], path.join(worktree, 'relay'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Updating via git/);
  assert.equal(fs.readFileSync(path.join(worktree, 'updated-marker'), 'utf8'), 'new revision');
  assert.equal(s.run(['version'], path.join(worktree, 'relay')).stdout.trim(), `relay ${version}`);
});

test('daemon redeploy refreshes an enabled service after a single-file update', t => {
  const s = installed(t);
  fs.writeFileSync(path.join(s.state, 'autoswitch-daemon.py'), '# old daemon\n');
  fs.writeFileSync(path.join(s.state, 'daemon_version'), '0.0.1\n');
  fs.writeFileSync(path.join(s.state, 'autoswitch.lock'), String(process.pid));
  const directory = path.join(s.home, '.config/systemd/user'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'relay-autoswitch.service'), '[Service]\n');
  const r = s.run(['help']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.state, 'daemon_version'), 'utf8').trim(), version);
  assert.ok(fs.readFileSync(path.join(s.state, 'autoswitch-daemon.py')).equals(fs.readFileSync(path.join(root, 'src/python/autoswitch_daemon.py'))));
  assert.match(fs.readFileSync(path.join(s.home, 'service-calls'), 'utf8'), /restart/);
});

test('failed daemon restart restores the old deployment and does not mark it current', t => {
  const s = installed(t);
  const old = '# old daemon\n';
  fs.writeFileSync(path.join(s.state, 'autoswitch-daemon.py'), old, { mode: 0o755 });
  fs.writeFileSync(path.join(s.state, 'daemon_version'), '0.0.1\n');
  fs.writeFileSync(path.join(s.state, 'autoswitch.lock'), String(process.pid));
  const directory = path.join(s.home, '.config/systemd/user'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'relay-autoswitch.service'), '[Service]\n');
  s.shim('systemctl', 'process.exit(1)');
  const r = s.run(['help']);
  assert.equal(fs.readFileSync(path.join(s.state, 'daemon_version'), 'utf8').trim(), '0.0.1');
  assert.equal(fs.readFileSync(path.join(s.state, 'autoswitch-daemon.py'), 'utf8'), old);
  assert.doesNotMatch(r.stdout, /redeployed and restarted/);
  assert.match(r.stderr, /redeploy failed/);
});

test('npm updater replaces installed files using real npm in an isolated global prefix', t => {
  const s = installed(t);
  const prefix = path.join(s.home, 'global-prefix');
  const npmCli = process.env.npm_execpath || fs.realpathSync(execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim());
  const env = { ...s.env, npm_config_cache: path.join(s.home, 'npm-cache') };
  function npm(args, cwd = s.home) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  }
  function pack(v, suffix) {
    const dir = path.join(s.home, 'package-' + v); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@dst-justin/relay', version: v, files: ['relay'] }));
    fs.writeFileSync(path.join(dir, 'relay'), fs.readFileSync(path.join(root, 'relay'), 'utf8') + suffix);
    const [result] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', s.home], dir));
    return path.join(s.home, result.filename);
  }
  const old = pack('0.0.1', '\n# old fixture\n');
  const next = pack(version, '');
  npm(['install', '-g', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', old]);
  const entry = path.join(prefix, 'lib/node_modules/@dst-justin/relay/relay');
  assert.equal(s.run(['version'], entry).stdout.trim(), 'relay 0.0.1');
  Object.assign(s.env, { RELAY_TEST_NPM_CLI: npmCli, RELAY_TEST_PREFIX: prefix, RELAY_TEST_TARBALL: next, npm_config_cache: env.npm_config_cache });
  s.shim('npm', `
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['install','-g','@dst-justin/relay@${version}'])) process.exit(42);
    const r = require('child_process').spawnSync(process.execPath, [process.env.RELAY_TEST_NPM_CLI,
      'install','-g','--prefix',process.env.RELAY_TEST_PREFIX,'--offline','--ignore-scripts','--no-audit','--no-fund',process.env.RELAY_TEST_TARBALL], {stdio:'inherit'});
    process.exit(r.status === null ? 1 : r.status);
  `);
  const result = s.run(['update'], entry);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(s.run(['version'], entry).stdout.trim(), `relay ${version}`);
  assert.ok(fs.readFileSync(entry).equals(fs.readFileSync(path.join(root, 'relay'))));
});
