'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assemble, banner } = require('../scripts/build.cjs');
const root = path.resolve(__dirname, '..');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-builder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src/shell'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/python'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  fs.writeFileSync(path.join(dir, 'src/manifest.json'), JSON.stringify({ shell: ['entry.sh', 'dispatch.sh'] }));
  fs.writeFileSync(path.join(dir, 'src/shell/entry.sh'), '#!/usr/bin/env bash\npython3 -c \'{{python:quote.py}}\' "$@"\n');
  fs.writeFileSync(path.join(dir, 'src/shell/dispatch.sh'), '# end\n');
  fs.writeFileSync(path.join(dir, 'src/python/quote.py'), 'import sys; print(repr(sys.argv[1]))\n');
  return dir;
}

test('assembly preserves Python quotes, argument boundaries and manifest order', t => {
  const dir = fixture(t);
  const output = assemble(dir);
  const script = path.join(dir, 'relay');
  fs.writeFileSync(script, output);
  const value = 'a space, "quotes", $HOME and \\ backslash';
  const result = spawnSync('/bin/bash', [script, value], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `'a space, "quotes", $HOME and \\\\ backslash'\n`);
  assert.ok(output.endsWith('# end\n'));
  assert.equal(assemble(dir), output);
});

test('a duplicate shell module cannot silently duplicate initialization', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'src/manifest.json'), JSON.stringify({ shell: ['entry.sh', 'entry.sh'] }));
  assert.throws(() => assemble(dir), /duplicate shell module/);
});

test('missing Python sources and malformed markers fail the build', t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'src/python/quote.py'));
  assert.throws(() => assemble(dir), /ENOENT/);
  fs.writeFileSync(path.join(dir, 'src/shell/entry.sh'), '#!/usr/bin/env bash\n{{python:../bad.py}}\n');
  assert.throws(() => assemble(dir), /Unexpanded/);
});

test('unreferenced sources cannot be silently omitted from a release', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'src/python/forgotten.py'), 'print(42)\n');
  assert.throws(() => assemble(dir), /Unreferenced python source/);
});

test('checked-in release is exactly the current assembly', () => {
  assert.ok(assemble() === fs.readFileSync(path.join(root, 'relay'), 'utf8'), 'Run npm run build to synchronize relay');
});

test('check mode never repairs or rewrites the checked-in artifact', () => {
  const before = fs.statSync(path.join(root, 'relay'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build.cjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(path.join(root, 'relay')).mtimeMs, before.mtimeMs);
  assert.ok(fs.readFileSync(path.join(root, 'relay'), 'utf8').includes(banner));
});

test('stale artifacts fail check mode without being overwritten', t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/build.cjs'), path.join(dir, 'scripts/build.cjs'));
  fs.writeFileSync(path.join(dir, 'relay'), 'stale release\n');
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts/build.cjs'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /out of date/);
  assert.equal(fs.readFileSync(path.join(dir, 'relay'), 'utf8'), 'stale release\n');
});

test('Windows source retains the previously accepted PowerShell 5.1 constraints', () => {
  const source = fs.readFileSync(path.join(root, 'relay.ps1'), 'utf8');
  assert.equal(source.charCodeAt(0), 0xfeff, 'Windows PowerShell 5.1 requires the BOM for UTF-8 source');
  assert.ok(!source.includes('??'), 'PowerShell 7 null-coalescing syntax is not supported by 5.1');
  assert.match(source, /\$null -ne \$resp\.expires_in/);
});
