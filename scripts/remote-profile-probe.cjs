'use strict';
// Refuse to run remote Windows tests unless PowerShell also honors isolation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-profile-probe-'));
try {
  const env = { ...process.env, USERPROFILE: temp, HOME: temp };
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$HOME'], { env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim().toLowerCase() !== temp.toLowerCase()) {
    throw new Error('PowerShell profile isolation failed; refusing remote runtime tests');
  }
  console.log(JSON.stringify({ isolatedPowerShellHome: true, node: process.version, platform: process.platform, arch: process.arch }));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
