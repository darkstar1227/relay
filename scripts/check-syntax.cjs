#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

for (const [command, args] of [
  ['/bin/bash', ['-n', 'relay']],
  ['python3', ['-c', 'import ast,pathlib; files=sorted(pathlib.Path("src/python").glob("*.py")); [ast.parse(p.read_text(), filename=str(p)) for p in files]; print(str(len(files))+" Python sources parsed")']],
]) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error(result.error ? result.error.message : result.stderr);
    process.exit(1);
  }
  process.stdout.write(result.stdout);
}
console.log('Bash syntax valid');
