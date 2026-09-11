'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox } = require('./support/sandbox.cjs');

for (const fault of ['mktemp', 'mkfifo', 'holder', 'invalid-timeout']) {
  test(`credential lock fails closed and cleans up on ${fault}`, t => {
    const s = sandbox(t); s.account('a');
    if (fault === 'mktemp' || fault === 'mkfifo') {
      fs.writeFileSync(path.join(s.bin, fault), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    if (fault === 'holder') fs.mkdirSync(path.join(s.state, 'credential.lock'));
    const start = Date.now();
    const r = s.run(['a'], '', { RELAY_LOCK_TIMEOUT_SECONDS: fault === 'invalid-timeout' ? '0' : '1' });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(Date.now() - start < 5000, 'lock failure must be bounded');
    assert.equal(fs.existsSync(path.join(s.state, 'current')), false);
    assert.equal(fs.existsSync(path.join(s.home, '.claude/.credentials.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(s.home, 'tmp')), []);
  });
}

test('successful switches release the holder and remove private FIFO directories', t => {
  const s = sandbox(t); s.account('a'); s.account('b');
  for (const name of ['a','b','a']) {
    const r = s.run([name], '', { RELAY_LOCK_TIMEOUT_SECONDS: '2' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(s.state, 'current'), 'utf8').trim(), name);
    assert.deepEqual(fs.readdirSync(path.join(s.home, 'tmp')), []);
  }
});
