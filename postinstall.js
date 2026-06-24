#!/usr/bin/env node
// Runs after `npm install -g @dst-justin/relay`.
// If the npm global bin dir is not in PATH, appends it to shell config files.
'use strict';

const { execSync } = require('child_process');
const { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

// ── Windows ───────────────────────────────────────────────────────────────────
// npm on Windows already manages PATH via the installer; nothing to do here.
if (process.platform === 'win32') {
  // Verify relay.js can reach relay.ps1 (sanity check)
  if (!existsSync(join(__dirname, 'relay.ps1'))) {
    console.warn('  relay: warning — relay.ps1 not found, Windows support may be broken');
  }
  process.exit(0);
}

// ── Get npm global bin dir ────────────────────────────────────────────────────
// npm sets npm_config_prefix during install; fall back to `npm prefix -g`
let prefix = process.env.npm_config_prefix;
if (!prefix) {
  try {
    prefix = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
  } catch (_) {
    process.exit(0); // can't determine, give up silently
  }
}
const binDir = join(prefix, 'bin');

// Already in PATH — nothing to do
const pathDirs = (process.env.PATH || '').split(':');
if (pathDirs.includes(binDir)) process.exit(0);

const home = os.homedir();

// ── POSIX shells: bash / zsh / sh ────────────────────────────────────────────
const exportLine = `export PATH="${binDir}:$PATH"`;
const marker = '# added by relay';
const block = `\n${exportLine}  ${marker}\n`;

const rcFiles = ['.bashrc', '.zshrc', '.profile'].map(f => join(home, f));
let patched = false;

for (const rc of rcFiles) {
  if (!existsSync(rc)) continue;
  try {
    if (readFileSync(rc, 'utf8').includes(marker)) continue; // idempotent
    appendFileSync(rc, block);
    console.log(`  relay: added ${binDir} to PATH in ~/${require('path').basename(rc)}`);
    patched = true;
  } catch (_) {}
}

// If no shell rc found, create ~/.bashrc as a last resort
if (!patched) {
  const bashrc = join(home, '.bashrc');
  try {
    appendFileSync(bashrc, block);
    console.log(`  relay: created ~/.bashrc with PATH entry for ${binDir}`);
    patched = true;
  } catch (_) {}
}

// ── Fish shell ────────────────────────────────────────────────────────────────
const fishConfig = join(home, '.config', 'fish', 'config.fish');
const fishMarker = '# added by relay';
const fishLine = `\nset -gx PATH "${binDir}" $PATH  ${fishMarker}\n`;

if (existsSync(fishConfig)) {
  try {
    if (!readFileSync(fishConfig, 'utf8').includes(fishMarker)) {
      appendFileSync(fishConfig, fishLine);
      console.log(`  relay: added ${binDir} to PATH in ~/.config/fish/config.fish`);
      patched = true;
    }
  } catch (_) {}
}

if (patched) {
  console.log(`  relay: restart your shell (or 'source ~/.bashrc' / 'source ~/.zshrc') then try: relay list`);
}
