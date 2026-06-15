#!/usr/bin/env node
// relay.js — cross-platform entry point for npm installs
// Routes to ./relay (bash) on macOS/Linux, or ./relay.ps1 via PowerShell on Windows.
'use strict';

const { spawnSync } = require('child_process');
const { join } = require('path');
const { chmodSync, statSync } = require('fs');

const dir  = __dirname;
const args = process.argv.slice(2);

let result;
if (process.platform === 'win32') {
    result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'relay.ps1'), ...args],
        { stdio: 'inherit', shell: false }
    );
} else {
    const script = join(dir, 'relay');
    // Ensure executable bit is set — npm publish from Windows strips +x
    try {
        if ((statSync(script).mode & 0o111) === 0) chmodSync(script, '755');
    } catch (_) {}
    result = spawnSync(script, args, { stdio: 'inherit', shell: false });
}

process.exit(result.status != null ? result.status : 0);
