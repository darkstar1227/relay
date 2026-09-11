'use strict';
// Deliberate live test, never part of npm test/CI. Explicit host + confirmation
// guard; secret-bearing backups stay on that host in a private directory.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
assert.equal(process.argv[2], '--authorized-live-dshome');
assert.equal(os.hostname(), 'DESKTOP-BQ8SQUF');
assert.equal(os.homedir(), '/home/ds');
assert.equal(process.platform, 'linux');
process.umask(0o077);
const root = path.resolve(__dirname, '..');
assert.ok(path.basename(root).startsWith('relay-stage-11-'));
const core = path.join(root, 'target/release/relay-core');
const home = os.homedir(), state = path.join(home, '.claude-relay');
const creds = path.join(state, 'credentials'), account = path.join(creds, 'personal.json');
const config = path.join(state, 'autoswitch.json');
const oldUnit = 'relay-autoswitch.service';
const testUnit = `relay-core-acceptance-${process.pid}.service`;
const badUnit = `relay-core-reject-${process.pid}.service`;
const unitFile = path.join(home, '.config/systemd/user', oldUnit);
const env = { ...process.env, HOME: home, LC_ALL: 'C.UTF-8', PATH: '/home/ds/.nvm/versions/node/v24.16.0/bin:/home/ds/.local/bin:/usr/local/bin:/usr/bin:/bin' };
for (const k of Object.keys(env)) if (k.startsWith('RELAY_')) delete env[k];
const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-live-backup-'));
const summary = { date: new Date().toISOString(), host: os.hostname(), account: 'personal', backup, checks: [] };
const evidence = path.join(root, 'live-results.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p));
function cmd(command, args, timeout = 45000) {
  const r = spawnSync(command, args, { env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (r.error) throw new Error(`${path.basename(command)} execution failed`);
  return r;
}
function checked(command, args, timeout) {
  const r = cmd(command, args, timeout); assert.equal(r.status, 0, `${path.basename(command)} failed (exit ${r.status})`); return r.stdout;
}
function record(name, pass, details = {}) {
  summary.checks.push({ name, pass, ...details });
  fs.writeFileSync(evidence, JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(summary.checks.at(-1)));
}
function atomic(p, bytes) {
  const temp = p + '.acceptance-' + process.pid;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, p);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let originalConfig, testConfig, unitHash, currentHash, liveHash, stopped = false, cleaned = false;
const originalActive = cmd('systemctl', ['--user', 'is-active', oldUnit]).status === 0;
const originalEnabled = cmd('systemctl', ['--user', 'is-enabled', oldUnit]).stdout.trim();
function cleanup() {
  if (cleaned) return; cleaned = true;
  const stop = cmd('systemctl', ['--user', 'stop', testUnit]);
  const testActive = cmd('systemctl', ['--user', 'is-active', testUnit]).status === 0;
  record('candidate_stopped', !testActive, { stop_exit: stop.status });
  cmd('systemctl', ['--user', 'stop', badUnit]);
  if (testActive) { record('restoration', false, { reason: 'candidate still active; do not run two daemons' }); return; }
  if (originalConfig && testConfig) {
    if (fs.readFileSync(config).equals(testConfig)) atomic(config, originalConfig);
    else if (!fs.readFileSync(config).equals(originalConfig)) {
      record('restoration', false, { reason: 'configuration changed externally; preserved' }); return;
    }
  }
  // NEVER restore credential snapshots: refresh may have invalidated old tokens.
  if (stopped && originalActive) checked('systemctl', ['--user', 'start', oldUnit]);
  const active = cmd('systemctl', ['--user', 'is-active', oldUnit]).status === 0;
  const enabled = cmd('systemctl', ['--user', 'is-enabled', oldUnit]).stdout.trim();
  record('restoration', active === originalActive && enabled === originalEnabled &&
    (!originalConfig || fs.readFileSync(config).equals(originalConfig)) &&
    (!unitHash || hash(fs.readFileSync(unitFile)) === unitHash), { active, enabled, credentials_rolled_back: false });
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, () => {
  try { cleanup(); } finally { process.exit(1); }
});
(async () => {
  try {
    const info = JSON.parse(checked(core, ['artifact-info']));
    assert.equal(info.profile, 'release'); assert.equal(info.test_fixtures, false); assert.equal(info.version, require('../package.json').version);
    assert.ok(read(account).claudeAiOauth.refreshToken);
    assert.notEqual(fs.readFileSync(path.join(state, 'current'), 'utf8').trim(), 'personal', 'Only non-current account approved by this probe');
    if (originalActive) { stopped = true; checked('systemctl', ['--user', 'stop', oldUnit]); }
    assert.notEqual(cmd('systemctl', ['--user', 'is-active', oldUnit]).status, 0);
    originalConfig = fs.readFileSync(config); unitHash = hash(fs.readFileSync(unitFile));
    currentHash = hash(fs.readFileSync(path.join(state, 'current')));
    liveHash = hash(fs.readFileSync(path.join(home, '.claude/.credentials.json')));
    for (const [name, source] of [['autoswitch.json', config], ['personal.json', account], ['current', path.join(state, 'current')], ['live.json', path.join(home, '.claude/.credentials.json')], ['autoswitch.log', path.join(state, 'autoswitch.log')]]) {
      if (fs.existsSync(source)) fs.writeFileSync(path.join(backup, name), fs.readFileSync(source), { mode: 0o600 });
    }
    record('backup_and_pause', true, { original_active: originalActive, original_enabled: originalEnabled });
    const before = read(account), start = Date.now();
    const refresh = checked(core, ['refresh-all', creds, '1', 'personal']);
    const after = read(account);
    const refreshed = /\brefreshed\b/.test(refresh) && !/refresh failed/.test(refresh);
    const strip = v => { const x = structuredClone(v); for (const k of ['accessToken', 'refreshToken', 'expiresAt']) delete x.claudeAiOauth[k]; return x; };
    assert.deepEqual(strip(after), strip(before));
    record('real_oauth_refresh', refreshed, { ms: Date.now() - start, access_changed: before.claudeAiOauth.accessToken !== after.claudeAiOauth.accessToken, refresh_changed: before.claudeAiOauth.refreshToken !== after.claudeAiOauth.refreshToken, expires_in_future: after.claudeAiOauth.expiresAt > Date.now(), unknown_fields_preserved: true });
    const usageStart = Date.now(), status = checked(core, ['status-once', account, 'personal', '(not displayed)']);
    const usageOK = /5hr usage:/.test(status) && !/query failed|Token expired|No access token/.test(status);
    record('real_usage', usageOK, { ms: Date.now() - usageStart });
    // Disable scheduled warmup and account switching for the live daemon smoke.
    // The daemon still performs its real startup refresh under credential.lock.
    const cfg = JSON.parse(originalConfig); cfg.order = []; cfg.warmup = []; cfg.warmup_enabled = false;
    testConfig = Buffer.from(JSON.stringify(cfg, null, 2)); atomic(config, testConfig);
    checked('systemd-run', ['--user', '--unit=' + testUnit, '--service-type=exec', '--collect', '--property=RuntimeMaxSec=90', '--property=TimeoutStopSec=35', '--property=KillMode=control-group', '--setenv=HOME=' + home, '--setenv=PATH=' + env.PATH, core, 'daemon']);
    const until = Date.now() + 25000;
    let daemonPid = '';
    while (Date.now() < until) {
      daemonPid = cmd('systemctl', ['--user', 'show', testUnit, '-p', 'MainPID', '--value']).stdout.trim();
      if (daemonPid !== '0' && fs.existsSync(path.join(state, 'autoswitch.lock')) && fs.readFileSync(path.join(state, 'autoswitch.lock'), 'utf8').trim() === daemonPid) break;
      await delay(100);
    }
    assert.ok(Number(daemonPid) > 0);
    await delay(1500);
    record('real_systemd_daemon', cmd('systemctl', ['--user', 'is-active', testUnit]).status === 0,
      { pid_matches: fs.readFileSync(path.join(state, 'autoswitch.lock'), 'utf8').trim() === daemonPid, scheduled_warmup_disabled: true });
    const duplicate = cmd(core, ['daemon']); record('live_singleton_rejection', duplicate.status === 1 && /already running/.test(duplicate.stderr));
    const stopStart = Date.now(); checked('systemctl', ['--user', 'stop', testUnit]);
    record('systemd_graceful_stop', !fs.existsSync(path.join(state, 'autoswitch.lock')), { ms: Date.now() - stopStart });
    const rejected = cmd('systemd-run', ['--user', '--unit=' + badUnit, '--service-type=exec', '--collect', path.join(root, 'deliberately-missing-core'), 'daemon']);
    record('invalid_candidate_rejected', rejected.status !== 0);
    record('current_and_live_unchanged', hash(fs.readFileSync(path.join(state, 'current'))) === currentHash && hash(fs.readFileSync(path.join(home, '.claude/.credentials.json'))) === liveHash);
    const finalStatus = checked(core, ['status-once', account, 'personal', '(not displayed)']);
    record('post_daemon_rotated_credential_usable', /5hr usage:/.test(finalStatus) && !/query failed|Token expired/.test(finalStatus));
  } catch (e) {
    // Do not serialize arbitrary assertions/actual credential values.
    record('execution_error', false, { type: e.code || e.name });
  } finally {
    try { cleanup(); } catch (e) { record('restoration_error', false, { type: e.code || e.name }); }
    summary.finished = new Date().toISOString();
    fs.writeFileSync(evidence, JSON.stringify(summary, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ evidence, backup, passed: summary.checks.filter(x => x.pass).length, total: summary.checks.length }));
    process.exitCode = summary.checks.some(x => !x.pass) ? 1 : 0;
  }
})();
