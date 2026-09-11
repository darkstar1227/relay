'use strict';
// No fixture-feature dependency, Python oracle, shell, HTTP, Keychain or services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const binary = process.env.RELAY_CORE_TEST_BIN;
assert.ok(binary && path.isAbsolute(binary), 'RELAY_CORE_TEST_BIN must be absolute');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-portable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '設定 with spaces.json');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir };
  for (const key of Object.keys(env)) if (/^RELAY_(PROVIDER|RUN|TEST|CORE)/.test(key)) delete env[key];
  function run(op, args = [], input = '', extra = {}) {
    const r = spawnSync(binary, [op, ...args], { env: { ...env, ...extra }, input, encoding: 'utf8', timeout: 10000 });
    assert.ifError(r.error); return r;
  }
  function ok(op, args, input, extra) {
    const r = run(op, args, input, extra); assert.equal(r.status, 0, `${op}: ${r.stderr}`); return r.stdout.trim();
  }
  return { dir, file, env, run, ok, write: v => fs.writeFileSync(file, JSON.stringify(v)), read: () => JSON.parse(fs.readFileSync(file)) };
}
test('portable protocol and metadata reject unknown operations without leaking arguments', t => {
  const f = fixture(t);
  assert.equal(f.ok('protocol'), `relay-core 1 ${require('../../package.json').version}`);
  assert.equal(JSON.parse(f.ok('artifact-info')).protocol, 1);
  const r = f.run('unknown-SECRET'); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /SECRET/);
});
test('portable JSON readers preserve Unicode and arbitrary precision; malformed input is private', t => {
  const f = fixture(t);
  f.write({ version: '2.9.2', model: '中文', discover_models: true, oauthAccount: { emailAddress: 'fixture@example.invalid' } });
  assert.equal(f.ok('provider-field', [f.file, 'model']), '中文');
  assert.equal(f.ok('provider-discover', [f.file]), '1');
  assert.equal(f.ok('account-email', [f.file]), 'fixture@example.invalid');
  assert.equal(f.ok('read-version', [f.file]), '2.9.2');
  assert.equal(f.ok('access-token', [], '{"claudeAiOauth":{"accessToken":"fake"}}'), 'fake');
  assert.match(f.ok('format-json', [], '{"n":9007199254740993123}'), /9007199254740993123/);
  for (const op of ['access-token', 'format-json']) {
    const r = f.run(op, [], '{SECRET'); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /SECRET/);
  }
  assert.equal(f.ok('account-email', [path.join(f.dir, 'missing')]), '');
  assert.equal(f.run('read-version', [path.join(f.dir, 'missing')]).status, 1);
});
test('portable provider and run settings write safely and reject missing environment', t => {
  const f = fixture(t);
  f.ok('provider-add', [], '', { RELAY_PROVIDER_PATH: f.file, RELAY_PROVIDER_BASE_URL: 'https://example.invalid', RELAY_PROVIDER_TOKEN: 'fake', RELAY_PROVIDER_MODEL: '中文' });
  assert.equal(f.read().model, '中文');
  f.ok('run-settings', [], '', { RELAY_RUN_SETTINGS_FILE: f.file, RELAY_RUN_BASE_URL: 'https://example.invalid', RELAY_RUN_TOKEN: 'fake' });
  assert.equal(f.read().env.ANTHROPIC_AUTH_TOKEN, 'fake');
  const before = fs.readFileSync(f.file);
  assert.equal(f.run('provider-add').status, 1);
  assert.deepEqual(fs.readFileSync(f.file), before);
});
test('portable config mutation preserves unknown fields and malformed writes leave bytes intact', t => {
  const f = fixture(t); f.write({ future: 'preserved' });
  f.ok('reorder', [f.file, 'b,a']); assert.deepEqual(f.read().order, ['b', 'a']);
  f.ok('lock-add', [f.file, 'a']); f.ok('lock-add', [f.file, 'a']); assert.deepEqual(f.read().locks, ['a']);
  f.ok('unlock', [f.file, 'a']); assert.deepEqual(f.read().locks, []);
  f.ok('warmup-add', [f.file, 'a', '06:00']); f.ok('warmup-add', [f.file, 'a', '06:00']); assert.equal(f.read().warmup.length, 1);
  f.ok('warmup-pause', [f.file]); assert.equal(f.read().warmup_enabled, false);
  f.ok('warmup-resume', [f.file]); assert.equal(f.read().warmup_enabled, true);
  assert.equal(f.ok('warmup-remove', [f.file, 'a', '']), '1');
  f.ok('config-save', [f.file], '{"extra":true}'); assert.equal(f.read().future, 'preserved');
  const before = fs.readFileSync(f.file);
  for (const raw of ['{SECRET', '[]', 'null']) { assert.equal(f.run('config-save', [f.file], raw).status, 1); assert.deepEqual(fs.readFileSync(f.file), before); }
});
test('portable defaults heal order and do not overwrite existing configuration', t => {
  const f = fixture(t), creds = path.join(f.dir, 'creds'); fs.mkdirSync(creds);
  fs.writeFileSync(path.join(creds, 'a.json'), '{}');
  for (const op of ['lock-default-config', 'warmup-ensure-config']) {
    const target = path.join(f.dir, op + '.json'); f.ok(op, [creds, target]);
    assert.deepEqual(JSON.parse(fs.readFileSync(target)).order, ['a']);
    fs.writeFileSync(target, '{"preserved":true}'); f.ok(op, [creds, target]);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"preserved":true}');
  }
});
test('portable Codex rotation serializes 30 concurrent writers', async t => {
  const f = fixture(t); f.write({ future: 'preserved' });
  f.ok('codex-models-set', [f.file, 'a,b,c']); assert.equal(f.ok('codex-models-get', [f.file]), 'a,b,c');
  const values = await Promise.all(Array.from({ length: 30 }, () => new Promise((resolve, reject) => {
    const child = spawn(binary, ['codex-model-pick', f.file], { env: f.env, timeout: 15000 });
    let out = '', err = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => err += x);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
  })));
  for (const name of ['a', 'b', 'c']) assert.equal(values.filter(x => x === name).length, 10);
  assert.equal(f.read()._codex_model_cursor, 2); assert.equal(f.read().future, 'preserved');
});
test('portable ordering handles shorthand and named Unicode accounts', t => {
  const f = fixture(t);
  assert.equal(f.ok('prompt-reorder', ['21', 'a', '中文']), '中文,a');
  assert.equal(f.ok('reorder-chain', [], 'a,中文\n'), 'a -> 中文 -> (cycle)');
  assert.equal(f.ok('warmup-test', ['a']), ''); // intentional legacy no-op
});
test('portable display operations read only isolated configuration, logs and sessions', t => {
  const f = fixture(t), log = path.join(f.dir, 'autoswitch.log'), state = path.join(f.dir, 'state.json');
  f.write({ order: ['a'], locks: ['a'], thresholds: { a: 80 }, warmup: [{ account: 'a', time: '06:00' }], poll: { low_minutes: 10, high_minutes: 2, high_threshold: 50 } });
  fs.writeFileSync(state, '{}');
  fs.writeFileSync(log, Array.from({ length: 3 }, () => JSON.stringify({ event: 'warmup_missed', account: 'a', time: '06:00' })).join('\n') + '\n' + JSON.stringify({ event: 'switch', frm: 'a', to: 'b', ts: 1 }));
  assert.match(f.ok('lock-list', [f.file]), /a/);
  assert.match(f.ok('warmup-list', [f.file, state]), /06:00/);
  assert.match(f.ok('warmup-health', [f.file, log]), /3\/3/);
  assert.match(f.ok('autoswitch-config-summary', [f.file]), /80%/);
  assert.match(f.ok('autoswitch-status', [f.file, 'a']), /Last switch/);
  assert.match(f.ok('autoswitch-log', [log]), /switch/);
  const base = path.join(f.dir, 'projects'), project = path.join(base, 'fixture'); fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'session.jsonl'), '{}');
  assert.match(f.ok('sessions', [base]), /1 session\(s\)/);
  assert.equal(f.run('sessions', [path.join(f.dir, 'missing')]).status, 1);
});

test('portable operations reject excess arguments without disclosing them', t => {
  const f = fixture(t);
  for (const op of ['protocol', 'artifact-info', 'provider-field', 'provider-discover', 'account-email',
    'read-version', 'access-token', 'format-json', 'provider-add', 'run-settings', 'reorder', 'lock-add',
    'unlock', 'warmup-add', 'warmup-remove', 'warmup-pause', 'warmup-resume', 'lock-default-config',
    'warmup-ensure-config', 'config-save', 'codex-models-get', 'codex-models-set', 'codex-model-pick',
    'reorder-chain', 'warmup-test', 'lock-list', 'warmup-list', 'warmup-health',
    'autoswitch-config-summary', 'autoswitch-status', 'autoswitch-log', 'sessions']) {
    // prompt-reorder intentionally accepts a variable number of account names.
    const r = f.run(op, Array(12).fill('SECRET-ARG'));
    assert.equal(r.status, 1, op); assert.doesNotMatch(r.stderr, /SECRET-ARG/, op);
  }
});

test('portable failed replacement cleans temporary files and retains destination', t => {
  const f = fixture(t); fs.mkdirSync(f.file);
  fs.writeFileSync(path.join(f.file, 'sentinel'), 'preserved');
  const r = f.run('provider-add', [], '', { RELAY_PROVIDER_PATH: f.file,
    RELAY_PROVIDER_BASE_URL: 'https://example.invalid', RELAY_PROVIDER_TOKEN: 'SECRET-TOKEN' });
  assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /SECRET-TOKEN/);
  assert.equal(fs.readFileSync(path.join(f.file, 'sentinel'), 'utf8'), 'preserved');
  assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.file)]);
});

test('Windows rejects POSIX-only operations before side effects', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  for (const op of ['daemon', 'download-update', 'credential-lock']) {
    const r = f.run(op); assert.equal(r.status, 1); assert.match(r.stderr, /POSIX/);
  }
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
