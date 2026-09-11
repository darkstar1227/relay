'use strict';
// Fixture-only credential integration; refuses a binary without the test feature.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const binary = process.env.RELAY_CORE_TEST_BIN;
assert.ok(binary && path.isAbsolute(binary));
const info = spawnSync(binary, ['artifact-info'], { encoding: 'utf8' });
assert.equal(info.status, 0); assert.equal(JSON.parse(info.stdout).test_fixtures, true);
const tokenURL = 'https://api.anthropic.com/v1/oauth/token';
const usageURL = 'https://api.anthropic.com/api/oauth/usage';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-network-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, '.claude-relay'), creds = path.join(state, 'credentials');
  for (const p of [creds, path.join(state, 'meta'), path.join(home, '.claude')]) fs.mkdirSync(p, { recursive: true });
  const http = path.join(home, 'http.json'), calls = path.join(home, 'calls');
  fs.writeFileSync(http, '{}');
  const env = { ...process.env, HOME: home, USERPROFILE: home, RELAY_TEST_HOME: home, RELAY_TEST_HTTP: http, RELAY_TEST_HTTP_CALLS: calls };
  const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
  const account = (name, expires = Date.now() + 3600000) => {
    const p = path.join(creds, name + '.json');
    write(p, { preserved: true, claudeAiOauth: { accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: expires } }); return p;
  };
  const run = (op, args = []) => {
    const r = spawnSync(binary, [op, ...args], { env, encoding: 'utf8', timeout: 12000 });
    assert.ifError(r.error); assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  return { home, state, creds, env, calls, write, account, run, http: v => write(http, v), read: p => JSON.parse(fs.readFileSync(p)) };
}
test('credential sync copies live state only for an existing selected account', t => {
  const f = fixture(t), account = f.account('a');
  const live = path.join(f.home, '.claude/.credentials.json'); f.write(live, { fresh: true });
  f.run('sync-current'); assert.equal(f.read(account).preserved, true);
  fs.writeFileSync(path.join(f.state, 'current'), 'a'); f.run('sync-current'); assert.deepEqual(f.read(account), { fresh: true });
  fs.writeFileSync(live, '{INVALID'); f.run('sync-current'); assert.deepEqual(f.read(account), { fresh: true });
});
test('refresh updates selected live store; rejected and malformed responses preserve bytes', t => {
  const f = fixture(t), account = f.account('a', 1), live = path.join(f.home, '.claude/.credentials.json');
  fs.writeFileSync(path.join(f.state, 'current'), 'a'); f.write(live, { untouched: true });
  for (const response of [{ error: 429 }, { error: 401 }, { access_token: [] }, { access_token: 'new', refresh_token: [] }, { access_token: 'new', expires_in: null }, { access_token: 'new', expires_in: 9223372036854775807 }]) {
    f.http({ [tokenURL]: response }); const before = fs.readFileSync(account), beforeLive = fs.readFileSync(live);
    // Legacy contract: overall refresh-all returns success with per-account warnings.
    assert.match(f.run('refresh-all', [f.creds, '1', 'a']), /refresh failed/);
    assert.deepEqual(fs.readFileSync(account), before); assert.deepEqual(fs.readFileSync(live), beforeLive);
  }
  f.http({ [tokenURL]: { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 } });
  assert.match(f.run('refresh-all', [f.creds, '1', 'a']), /refreshed/);
  assert.deepEqual(f.read(live), f.read(account)); assert.equal(f.read(live).preserved, true);
});
test('usage 401 retries once, cache avoids network and HTTP failure does not poison cache', t => {
  const f = fixture(t); f.account('a');
  const args = ['full', f.creds, path.join(f.state, 'meta'), 'a'];
  f.http({ [usageURL]: { error: 401 }, [tokenURL]: { access_token: 'new', expires_in: 3600 } });
  f.run('render-table', args);
  const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n');
  assert.equal(calls.filter(x => x === usageURL).length, 2); assert.equal(calls.filter(x => x === tokenURL).length, 1);
  const cache = path.join(f.state, 'usage_cache.json'); assert.equal(fs.existsSync(cache), false);
  f.http({ [usageURL]: { five_hour: { utilization: 17 } } }); assert.match(f.run('render-table', args), /17%/);
  const before = fs.readFileSync(f.calls); f.http({}); assert.match(f.run('render-table', args), /17%/);
  assert.deepEqual(fs.readFileSync(f.calls), before);
  const saved = f.read(cache); saved.a.ts = 0; f.write(cache, saved); const old = fs.readFileSync(cache);
  f.http({ [usageURL]: { error: 503 } }); f.run('render-table', args); assert.deepEqual(fs.readFileSync(cache), old);
});
test('concurrent status refresh rotates an expired credential only once', async t => {
  const f = fixture(t), account = f.account('a', 1);
  f.http({ [tokenURL]: { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }, [usageURL]: { five_hour: { utilization: 17 } } });
  await Promise.all(Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
    const p = spawn(binary, ['status-once', account, 'a', 'fixture'], { env: f.env, timeout: 15000 });
    p.stdout.resume(); p.stderr.resume(); p.once('error', reject); p.once('close', c => c === 0 ? resolve() : reject(new Error('status failed')));
  })));
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').filter(x => x === tokenURL).length, 1);
  assert.equal(f.read(account).claudeAiOauth.refreshToken, 'rotated');
});
test('parallel usage merges all cache entries', t => {
  const f = fixture(t); for (let i = 0; i < 12; i++) f.account('a' + i);
  f.http({ [usageURL]: { five_hour: { utilization: 17 } } });
  f.run('render-table', ['full', f.creds, path.join(f.state, 'meta'), '']);
  assert.equal(Object.keys(f.read(path.join(f.state, 'usage_cache.json'))).length, 12);
});
