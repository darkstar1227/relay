'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const version = process.env.RELAY_TEST_VERSION || require('../../package.json').version;

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay test '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'test-bin');
  const state = path.join(home, '.claude-relay');
  for (const dir of [bin, path.join(state, 'credentials'), path.join(state, 'meta'), path.join(home, '.claude'), path.join(home, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(state, '.update_cache'), `${Math.floor(Date.now() / 1000)}:${version}`);
  const env = {
    ...process.env, HOME: home, RELAY_TEST_HOME: home,
    PATH: bin + path.delimiter + process.env.PATH,
    TMPDIR: path.join(home, 'tmp'), PYTHONPATH: __dirname,
    PYTHONDONTWRITEBYTECODE: '1', TZ: 'UTC', LC_ALL: 'C',
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  // All service and credential commands are intercepted before host tools.
  function shim(name, code) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  }
  shim('uname', "console.log('Linux')");
  for (const name of ['security', 'launchctl', 'crontab', 'sudo', 'curl', 'wget', 'notify-send', 'osascript']) {
    shim(name, "console.error('Host operation blocked by test harness'); process.exit(1)");
  }
  shim('systemctl', "require('fs').appendFileSync(process.env.HOME + '/service-calls', JSON.stringify(process.argv.slice(2)) + '\\n')");
  shim('rm', `const fs = require('fs'), path = require('path');
    const paths = process.argv.slice(2).filter(a => !a.startsWith('-'));
    if (paths.some(p => !path.resolve(p).startsWith(process.env.HOME + path.sep))) process.exit(1);
    for (const p of paths) fs.rmSync(p, { force: true, recursive: process.argv.some(a => a.includes('r') && a.startsWith('-')) });`);
  const recordAgent = `const fs = require('fs');
    const args = process.argv.slice(2);
    const result = { args, token: process.env.RELAY_CODEX_API_KEY || null };
    const index = args.indexOf('--settings');
    if (index >= 0) result.settings = JSON.parse(fs.readFileSync(args[index + 1], 'utf8'));
    fs.writeFileSync(process.env.HOME + '/agent-call.json', JSON.stringify(result));
    fs.appendFileSync(process.env.HOME + '/agent-calls', JSON.stringify(result) + '\\n');`;
  shim('claude', recordAgent);
  shim('codex', recordAgent);

  const script = process.env.RELAY_TEST_SCRIPT || path.join(root, 'relay');
  function run(args, input = '', extra = {}) {
    const result = spawnSync('/bin/bash', [script, ...args], {
      cwd: home, env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 15000,
    });
    if (result.error) throw result.error;
    return { ...result, text: result.stdout.replace(/\x1b\[[0-9;]*m/g, '') };
  }
  function account(name, oauth = {}) {
    const data = { claudeAiOauth: oauth, preserved: 'fixture' };
    fs.writeFileSync(path.join(state, 'credentials', name + '.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(state, 'meta', name), name + '@example.test');
    return data;
  }
  function json(name) { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')); }
  function http(fixtures) {
    env.RELAY_TEST_HTTP = path.join(home, 'http.json');
    fs.writeFileSync(env.RELAY_TEST_HTTP, JSON.stringify(fixtures));
  }
  return { home, bin, state, env, run, account, json, http, script };
}
module.exports = { sandbox, root, version };
