'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateInfo, targets } = require('../scripts/core-package.cjs');
const version = require('../package.json').version;
test('core package metadata maps native POSIX OS and architectures explicitly', () => {
  for (const [key,target] of Object.entries(targets)) {
    const [platform,arch] = key.split('-');
    assert.equal(validateInfo({version,protocol:1,target,profile:'release',test_fixtures:false},version,platform,arch),`@dst-justin/relay-core-${key}`);
  }
});
test('core package rejects wrong version, protocol, target, debug and test builds', () => {
  const info={version,protocol:1,target:targets['darwin-arm64'],profile:'release',test_fixtures:false};
  for (const patch of [{version:'0.0.0'},{protocol:2},{target:targets['linux-x64']},{profile:'debug'},{test_fixtures:true},{test_fixtures:undefined}]) {
    assert.throws(()=>validateInfo({...info,...patch},version,'darwin','arm64'));
  }
  assert.throws(()=>validateInfo(info,version,'win32','x64'),/Unsupported/);
});
