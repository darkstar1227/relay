'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox } = require('./support/sandbox.cjs');

function deployed(t) {
  const s = sandbox(t);
  s.account('alpha', { accessToken: 'alpha-token' });
  s.account('beta', { accessToken: 'beta-token' });
  for (const args of [['warmup', 'add', 'alpha', '06:30'], ['autoswitch', 'start']]) {
    // This file remains the Python oracle. Rust daemon behavior has its own tests.
    const r = s.run(args, '', { RELAY_CORE_BIN: '' });
    assert.equal(r.status, 0, r.stderr);
  }
  s.python = code => {
    const prelude = 'import importlib.util,sys\nspec=importlib.util.spec_from_file_location("daemon",sys.argv[1])\nd=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(d)\n';
    const r = spawnSync('python3', ['-c', prelude + code, path.join(s.state, 'autoswitch-daemon.py')], { env: s.env, cwd: s.home, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r;
  };
  return s;
}

test('daemon blocks only locked accounts at or above the threshold', t => {
  const s = deployed(t);
  s.python(`
thresholds = {'alpha': 80}
assert not d.is_blocked('alpha', thresholds, [], {'alpha': {'five_hour': {'utilization': 95}}})
assert not d.is_blocked('alpha', thresholds, ['alpha'], {'alpha': {'five_hour': {'utilization': 79}}})
assert d.is_blocked('alpha', thresholds, ['alpha'], {'alpha': {'five_hour': {'utilization': 80}}})
assert not d.is_blocked('alpha', thresholds, ['alpha'], {'alpha': None})
`);
});

test('scheduled warmup runs once per day and restores the previous account', t => {
  const s = deployed(t);
  fs.writeFileSync(path.join(s.state, 'current'), 'beta');
  fs.writeFileSync(path.join(s.home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'live-beta' } }));
  s.python(`
import datetime
from unittest.mock import patch
class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None): return cls(2026, 9, 6, 6, 35)
with patch.object(d.datetime, 'datetime', Clock):
    d.check_warmup([{'account': 'alpha', 'time': '06:30'}])
    d.check_warmup([{'account': 'alpha', 'time': '06:30'}])
`);
  assert.deepEqual(s.json('warmup_state.json')['alpha|06:30'], { date: '2026-09-06', status: 'ok' });
  assert.equal(fs.readFileSync(path.join(s.home, 'agent-calls'), 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readFileSync(path.join(s.state, 'current'), 'utf8'), 'beta');
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, '.claude/.credentials.json'))).claudeAiOauth.accessToken, 'live-beta');
});

test('missed warmup records the miss without invoking Claude', t => {
  const s = deployed(t);
  s.python(`
import datetime
from unittest.mock import patch
class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None): return cls(2026, 9, 6, 7, 0)
with patch.object(d.datetime, 'datetime', Clock):
    d.check_warmup([{'account': 'alpha', 'time': '06:30'}])
`);
  assert.deepEqual(s.json('warmup_state.json')['alpha|06:30'], { date: '2026-09-06', status: 'missed' });
  assert.ok(!fs.existsSync(path.join(s.home, 'agent-call.json')));
});

test('an existing live daemon PID rejects a second instance', t => {
  const s = deployed(t);
  s.python(`
d.check_single_instance()
try:
    d.check_single_instance()
except SystemExit as e:
    assert e.code == 1
else:
    raise AssertionError('second instance accepted')
finally:
    d.remove_lock()
`);
  assert.ok(!fs.existsSync(path.join(s.state, 'autoswitch.lock')));
});
