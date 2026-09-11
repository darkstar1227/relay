'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, version } = require('./support/sandbox.cjs');

function ok(result) { assert.equal(result.status, 0, result.stderr + result.stdout); return result; }

test('help, aliases and invalid commands preserve the public entrypoint', t => {
  const s = sandbox(t);
  assert.equal(ok(s.run(['version'])).stdout, `relay ${version}\n`);
  assert.equal(ok(s.run(['--version'])).stdout, `relay ${version}\n`);
  assert.match(ok(s.run(['help'])).text, /relay proxy/);
  assert.equal(s.run(['not-a-command']).status, 1);
  assert.match(ok(s.run(['list', '--no-usage'])).text, /No accounts yet/);
});

test('listing heals order and numeric switch backs up the outgoing credential', t => {
  const s = sandbox(t);
  s.account('alpha', { accessToken: 'old-alpha' });
  const beta = s.account('beta', { accessToken: 'beta-token' });
  s.account('gamma');
  fs.writeFileSync(path.join(s.state, 'order'), 'beta\nmissing\nbeta\nalpha\n');
  fs.writeFileSync(path.join(s.state, 'current'), 'alpha');
  const live = { claudeAiOauth: { accessToken: 'refreshed-alpha' } };
  fs.writeFileSync(path.join(s.home, '.claude/.credentials.json'), JSON.stringify(live));
  const listed = ok(s.run(['list', '--no-usage']));
  assert.ok(listed.text.indexOf('beta@example.test') < listed.text.indexOf('alpha@example.test'));
  assert.equal(fs.readFileSync(path.join(s.state, 'order'), 'utf8'), 'beta\nalpha\ngamma\n');
  ok(s.run(['1']));
  assert.equal(fs.readFileSync(path.join(s.state, 'current'), 'utf8').trim(), 'beta');
  assert.deepEqual(s.json('credentials/alpha.json'), live);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.claude/.credentials.json'))), beta);
  assert.equal(s.json('manual_switch').account, 'beta');
});

test('interactive reorder preserves unspecified accounts and updates automation', t => {
  const s = sandbox(t);
  s.account('alpha'); s.account('beta'); s.account('gamma');
  fs.writeFileSync(path.join(s.state, 'order'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(s.state, 'autoswitch.json'), JSON.stringify({ order: ['alpha','beta','gamma'], thresholds: { alpha: 80 } }));
  ok(s.run(['reorder'], '21\n'));
  assert.equal(fs.readFileSync(path.join(s.state, 'order'), 'utf8'), 'beta\nalpha\ngamma\n');
  assert.deepEqual(s.json('autoswitch.json').order, ['beta','alpha','gamma']);
  ok(s.run(['rename', 'beta', 'work']));
  assert.equal(fs.readFileSync(path.join(s.state, 'order'), 'utf8'), 'work\nalpha\ngamma\n');
  ok(s.run(['remove', 'work'], 'n\n'));
  assert.ok(fs.existsSync(path.join(s.state, 'credentials/work.json')));
  ok(s.run(['remove', 'work'], 'y\n'));
  assert.equal(fs.readFileSync(path.join(s.state, 'order'), 'utf8'), 'alpha\ngamma\n');
});

test('provider run preserves settings and keeps tokens out of child argv', t => {
  const s = sandbox(t);
  const token = 'fixture "token" $literal';
  ok(s.run(['provider', 'add', 'gateway', '--base-url', 'http://127.0.0.1:4000', '--token', token, '--model', 'model-a', '--discover-models']));
  assert.equal(s.json('providers/gateway.json').auth_token, token);
  assert.equal(fs.statSync(path.join(s.state, 'providers/gateway.json')).mode & 0o777, 0o600);
  ok(s.run(['run', 'gateway', '--', 'a prompt with spaces']));
  const claude = JSON.parse(fs.readFileSync(path.join(s.home, 'agent-call.json')));
  assert.equal(claude.settings.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(claude.settings.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(claude.args.at(-1), 'a prompt with spaces');
  assert.ok(!claude.args.join(' ').includes(token));
  ok(s.run(['provider', 'add', 'coding', '--base-url', 'http://127.0.0.1:4000', '--token', token, '--model', 'code-model', '--codex']));
  ok(s.run(['run', 'coding', '--', 'hello world']));
  const codex = JSON.parse(fs.readFileSync(path.join(s.home, 'agent-call.json')));
  assert.equal(codex.token, token);
  assert.ok(!codex.args.join(' ').includes(token));
  assert.equal(codex.args.at(-1), 'hello world');
});

test('warmup and locks keep their configuration schema and idempotency', t => {
  const s = sandbox(t);
  s.account('alpha'); s.account('beta');
  fs.writeFileSync(path.join(s.state, 'order'), 'beta\nalpha\n');
  ok(s.run(['warmup', 'add', 'alpha', '06:30']));
  ok(s.run(['warmup', 'add', 'alpha', '06:30']));
  assert.deepEqual(s.json('autoswitch.json').warmup, [{ account: 'alpha', time: '06:30' }]);
  assert.deepEqual(s.json('autoswitch.json').order, ['beta', 'alpha']);
  ok(s.run(['lock', 'beta'])); ok(s.run(['lock', 'beta']));
  assert.deepEqual(s.json('autoswitch.json').locks, ['beta']);
  ok(s.run(['warmup', 'pause']));
  assert.equal(s.json('autoswitch.json').warmup_enabled, false);
  ok(s.run(['warmup', 'resume']));
  assert.equal(s.json('autoswitch.json').warmup_enabled, true);
  ok(s.run(['warmup', 'remove', 'alpha', '06:30']));
  assert.deepEqual(s.json('autoswitch.json').warmup, []);
  ok(s.run(['unlock', 'beta']));
  assert.deepEqual(s.json('autoswitch.json').locks, []);
  assert.equal(s.run(['warmup', 'add', 'alpha', '25:00']).status, 1);
});

test('usage and refresh execute embedded Python against controlled HTTP responses', t => {
  const s = sandbox(t);
  s.account('alpha', { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 });
  s.http({
    'https://api.anthropic.com/v1/oauth/token': { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 },
    'https://api.anthropic.com/api/oauth/usage': { five_hour: { utilization: 85 }, seven_day: { utilization: 30 } },
  });
  const result = ok(s.run(['list']));
  assert.match(result.text, /85%/);
  assert.match(result.text, /above 80%/);
  assert.equal(s.json('credentials/alpha.json').claudeAiOauth.accessToken, 'new-token');
  assert.equal(s.json('credentials/alpha.json').preserved, 'fixture');
  assert.equal(s.json('usage_cache.json').alpha.data.seven_day.utilization, 30);
  // A fresh cache must still display usage when the network is unavailable.
  s.http({});
  assert.match(ok(s.run(['list'])).text, /85%/);
});

test('daemon deployment emits the selected runtime and a sandboxed service definition', t => {
  const s = sandbox(t);
  s.account('alpha');
  ok(s.run(['warmup', 'add', 'alpha', '06:30']));
  ok(s.run(['autoswitch', 'start']));
  const rust = Boolean(process.env.RELAY_CORE_BIN);
  const daemon = path.join(s.state, rust ? 'autoswitch-daemon.sh' : 'autoswitch-daemon.py');
  const validation = rust
    ? spawnSync('/bin/bash', ['-n', daemon], { env: s.env, encoding: 'utf8' })
    : spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', daemon], { env: s.env, encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(fs.statSync(daemon).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(s.state, 'daemon_version'), 'utf8').trim(), version);
  const service = fs.readFileSync(path.join(s.home, '.config/systemd/user/relay-autoswitch.service'), 'utf8');
  assert.ok(service.includes(daemon));
  assert.ok(fs.readFileSync(path.join(s.home, 'service-calls'), 'utf8').includes('enable'));
});

test('single-file install remains usable without the source tree or Node launcher', t => {
  const s = sandbox(t);
  ok(s.run(['install']));
  const installed = path.join(s.home, 'bin/relay');
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(s.script, 'utf8'));
  const result = spawnSync('/bin/bash', [installed, 'help'], { cwd: s.home, env: s.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /relay proxy/);
});

test('usage HTTP failures degrade gracefully and malformed cache can be rebuilt', t => {
  const s = sandbox(t);
  s.account('alpha', { accessToken: 'valid', expiresAt: Date.now() + 3600000 });
  fs.writeFileSync(path.join(s.state, 'usage_cache.json'), 'broken JSON');
  s.http({ 'https://api.anthropic.com/api/oauth/usage': { error: 429 } });
  assert.match(ok(s.run(['list'])).text, /alpha@example.test/);
  s.http({ 'https://api.anthropic.com/api/oauth/usage': { five_hour: { utilization: 12 } } });
  assert.match(ok(s.run(['list'])).text, /12%/);
  assert.equal(s.json('usage_cache.json').alpha.data.five_hour.utilization, 12);
});

test('401 without a refresh token displays the existing re-login guidance', t => {
  const s = sandbox(t);
  s.account('alpha', { accessToken: 'rejected' });
  s.http({ 'https://api.anthropic.com/api/oauth/usage': { error: 401 } });
  const result = ok(s.run(['list']));
  assert.match(result.text, /token expired/);
  assert.match(result.text, /relay refresh alpha/);
});

test('session listing uses the isolated projects directory', t => {
  const s = sandbox(t);
  const project = path.join(s.home, '.claude/projects/test-project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session-one.jsonl'), '{}\n');
  const result = ok(s.run(['sessions']));
  assert.match(result.text, /session-one/);
  assert.match(result.text, /1 session\(s\)/);
});
