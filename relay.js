#!/usr/bin/env node
// relay.js — cross-platform entry point for npm installs
// Routes to ./relay (bash) on macOS/Linux, or ./relay.ps1 via PowerShell on Windows.
'use strict';

const { spawnSync } = require('child_process');
const { join } = require('path');

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
    result = spawnSync(
        join(dir, 'relay'),
        args,
        { stdio: 'inherit', shell: false }
    );
}

process.exit(result.status ?? 0);
