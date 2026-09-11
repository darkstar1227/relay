'use strict';
// Export exactly the historical script needed by update tests, not .git history.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-test-baseline.cjs output-file');
const bytes = execFileSync('git', ['show', 'b40c791cab7ece474119071db8f15f840453dab0:relay'], { cwd: root });
const hash = createHash('sha256').update(bytes).digest('hex');
if (hash !== '5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d') throw new Error('Unexpected baseline');
fs.writeFileSync(process.argv[2], bytes, { flag: 'wx' });
console.log(hash);
