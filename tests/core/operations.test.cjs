'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { sandbox, root, version } = require('../support/sandbox.cjs');
const binary = process.env.RELAY_CORE_TEST_BIN;
if (!binary) throw new Error('Run npm run test:core');
function core(op, args = [], input = '', env = {}) {
  const result = spawnSync(binary, [op, ...args], {
    input, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return result.stdout; }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-core test '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config "quoted".json');
  return { dir, file, write: value => fs.writeFileSync(file, JSON.stringify(value)), read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
function python(op, args, env = {}, input = '') {
  return spawnSync('python3', [path.join(root, 'src/python', op + '.py'), ...args], {
    env: { ...process.env, ...env }, input, encoding: 'utf8', timeout: 10000,
  });
}

test('Rust daemon aborts an in-flight warmup and restores credentials on SIGTERM', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const s = sandbox(t); s.account('a'); s.account('b');
  fs.writeFileSync(path.join(s.state, 'current'), 'a');
  const started = path.join(s.home, 'warmup-child-pid'), agent = path.join(s.home, 'slow-agent');
  fs.writeFileSync(agent, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(s.state, 'claude_bin'), agent);
  fs.writeFileSync(path.join(s.state, 'autoswitch.json'), JSON.stringify({ order: [], warmup: [{ account: 'b', time: new Date().toISOString().slice(11,16) }] }));
  const daemon = spawn(binary, ['daemon'], { env: s.env, stdio: 'ignore' });
  const done = new Promise(resolve => daemon.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { daemon.kill('SIGKILL'); } catch {} if (fs.existsSync(started)) { try { process.kill(Number(fs.readFileSync(started)), 'SIGKILL'); } catch {} } });
  const deadline = Date.now() + 7000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(started), 'warmup child started');
  const pid = Number(fs.readFileSync(started)); daemon.kill('SIGTERM');
  assert.deepEqual(await done, { code: 0, signal: null });
  assert.equal(fs.readFileSync(path.join(s.state, 'current'), 'utf8'), 'a');
  assert.equal(fs.existsSync(path.join(s.state, 'autoswitch.lock')), false);
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
  assert.match(fs.readFileSync(path.join(s.state, 'autoswitch.log'), 'utf8'), /warmup_restore/);
});

test('Rust daemon recovers singleton ownership after SIGKILL with a stale PID file', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const s = sandbox(t); fs.writeFileSync(path.join(s.state, 'autoswitch.json'), '{"order":[]}');
  const pidFile = path.join(s.state, 'autoswitch.lock');
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    const daemon = spawn(binary, ['daemon'], { env: s.env, stdio: 'ignore' });
    t.after(() => { try { daemon.kill('SIGKILL'); } catch {} });
    const done = new Promise(resolve => daemon.once('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8') !== String(daemon.pid)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(daemon.pid));
    daemon.kill(signal); const result = await done;
    assert.equal(signal === 'SIGKILL' ? result.signal : result.code, signal === 'SIGKILL' ? signal : 0);
  }
  assert.equal(fs.existsSync(pidFile), false);
});

test('credential FIFO holder interoperates with Python flock and releases on EOF or kill', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const result = spawnSync('python3', ['-c', `
import os, sys, subprocess, fcntl
base, binary = sys.argv[1:]
lock = os.path.join(base, 'credential.lock')
ready, release = [os.path.join(base, x) for x in ['ready', 'release']]
os.mkfifo(ready); os.mkfifo(release)
for kill in [False, True]:
    child = subprocess.Popen([binary, 'credential-lock', lock, ready, release])
    try:
        with open(ready) as pipe: pipe.read()
        with open(lock, 'a') as contender:
            try:
                fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                raise AssertionError('Rust did not hold shared credential lock')
            except BlockingIOError: pass
            if kill: child.kill()
            else:
                with open(release, 'w'): pass
            assert child.wait(timeout=3) == (-9 if kill else 0)
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        if child.poll() is None: child.kill(); child.wait()
assert os.stat(lock).st_mode & 0o777 == 0o600
`, f.dir, binary], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(core('credential-lock', [path.join(f.dir, 'missing', 'lock'), 'ready', 'release']).status, 1);
});

test('protocol matches package version; arbitrary evaluation and extra arguments fail', () => {
  assert.equal(ok(core('protocol')), `relay-core 1 ${version}\n`);
  for (const [op, args] of [['-c', ['print(1)']], ['protocol', ['extra']], ['lock-add', []], ['no-such-operation', []]]) {
    const result = core(op, args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('actual fixture build metadata prevents development binary packaging', () => {
  const info=JSON.parse(ok(core('artifact-info')));
  assert.equal(info.version,version);assert.equal(info.profile,'debug');assert.equal(info.test_fixtures,true);
  const {validateInfo}=require('../../scripts/core-package.cjs');
  assert.throws(()=>validateInfo(info,version));
});

test('Rust usage table and status match Python ANSI output with controlled responses', t => {
  const s = sandbox(t); s.account('a', {accessToken:'fake-only',expiresAt:Date.now()+3600000});
  s.http({'https://api.anthropic.com/api/oauth/usage':{five_hour:{utilization:85,resets_at:'2000-01-01T00:00:00Z'},seven_day:{utilization:30}}});
  const cfg={locks:['a']}; fs.writeFileSync(path.join(s.state,'autoswitch.json'),JSON.stringify(cfg));
  for(const mode of ['quick','full']) for(const noUsage of [[],['--no-usage']]) {
    const args=[mode,path.join(s.state,'credentials'),path.join(s.state,'meta'),'a',...noUsage];
    assert.equal(ok(core('render-table',args,'',s.env)),ok(python('render_table',args,s.env)));
  }
  const args=[path.join(s.state,'credentials/a.json'),'a','a@example.test'];
  assert.equal(ok(core('status-once',args,'',s.env)),ok(python('status_once',args,s.env)));
});

test('Rust refresh preserves unknown fields and zero expiry; malformed response preserves bytes', t => {
  const s=sandbox(t); s.account('a',{accessToken:'old',refreshToken:'fake-refresh',expiresAt:1});
  const file=path.join(s.state,'credentials/a.json');
  for(const response of [{access_token:'new',expires_in:null},{access_token:[],expires_in:3600},{access_token:'new',refresh_token:[]},{}]) {
    s.http({'https://api.anthropic.com/v1/oauth/token':response}); const before=fs.readFileSync(file);
    assert.match(ok(core('refresh-all',[path.join(s.state,'credentials'),'1','a'],'',s.env)),/refresh failed/);
    assert.deepEqual(fs.readFileSync(file),before);
  }
  s.http({'https://api.anthropic.com/v1/oauth/token':{access_token:'new',refresh_token:'rotated',expires_in:0}});
  const before=Date.now(); assert.match(ok(core('refresh-all',[path.join(s.state,'credentials'),'1','a'],'',s.env)),/refreshed/);
  const value=s.json('credentials/a.json'); assert.equal(value.preserved,'fixture'); assert.equal(value.claudeAiOauth.refreshToken,'rotated');
  assert.ok(value.claudeAiOauth.expiresAt>=before && value.claudeAiOauth.expiresAt<=Date.now());
});

test('concurrent Rust status requests rotate an expired token only once', async t => {
  const s=sandbox(t);s.account('a',{accessToken:'expired',refreshToken:'single-use',expiresAt:1});
  s.http({'https://api.anthropic.com/v1/oauth/token':{access_token:'new',refresh_token:'rotated',expires_in:3600},'https://api.anthropic.com/api/oauth/usage':{five_hour:{utilization:12}}});
  const calls=path.join(s.home,'http-calls');
  await Promise.all(Array.from({length:10},()=>new Promise((resolve,reject)=>{
    const child=spawn(binary,['status-once',path.join(s.state,'credentials/a.json'),'a','fixture'],{env:{...s.env,RELAY_TEST_HTTP_CALLS:calls},timeout:10000});
    child.stdout.resume();child.stderr.resume();child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('status failed')));
  })));
  const requests=fs.readFileSync(calls,'utf8').trim().split('\n');
  assert.equal(requests.filter(url=>url.endsWith('/oauth/token')).length,1);
  assert.equal(s.json('credentials/a.json').claudeAiOauth.refreshToken,'rotated');
});

test('Rust parallel usage cache merges every account and works with Python execution blocked', t => {
  const s=sandbox(t); for(let i=0;i<12;i++) s.account('a'+i,{accessToken:'fake',expiresAt:Date.now()+3600000});
  s.http({'https://api.anthropic.com/api/oauth/usage':{five_hour:{utilization:12}}});
  for(const name of ['python3','python']) fs.writeFileSync(path.join(s.bin,name),'#!/bin/sh\nexit 92\n',{mode:0o755});
  const result=s.run(['list'],'',{RELAY_CORE_BIN:binary}); assert.equal(result.status,0,result.stderr);
  assert.equal(Object.keys(s.json('usage_cache.json')).length,12); assert.match(result.text,/12%/);
  s.http({}); assert.match(s.run(['list'],'',{RELAY_CORE_BIN:binary}).text,/12%/);
});

test('POSIX core path works when Python is absent from PATH', {skip:process.platform==='win32'}, t => {
  const s=sandbox(t);s.account('a',{accessToken:'fake',refreshToken:'fake-refresh',expiresAt:Date.now()+3600000});
  s.http({'https://api.anthropic.com/api/oauth/usage':{five_hour:{utilization:12}}});
  for(const command of ['date','mktemp','mkdir','chmod','cat','find','sort','tr','head','tail','basename','dirname','wc','sleep','kill','mv','cp','rmdir','mkfifo','touch','readlink']) {
    if(fs.existsSync(path.join(s.bin,command)))continue;
    const source=['/bin','/usr/bin'].map(dir=>path.join(dir,command)).find(p=>fs.existsSync(p));
    assert.ok(source,command);fs.symlinkSync(source,path.join(s.bin,command));
  }
  const env={RELAY_CORE_BIN:binary,PATH:s.bin};
  for(const args of [['version'],['list'],['a'],['status'],['lock','a'],['warmup','add','a','06:00'],['autoswitch','start']]) {
    const result=s.run(args,'',env);assert.equal(result.status,0,args.join(' ')+result.stderr);
  }
  assert.ok(fs.existsSync(path.join(s.state,'autoswitch-daemon.sh')));
});

test('Rust download validates content before replacement and cleans temporary artifacts', t => {
  const s=sandbox(t), file=path.join(s.home,'standalone'), body=path.join(s.home,'download-body');
  fs.writeFileSync(file,'original');
  const url=`https://raw.githubusercontent.com/darkstar1227/relay/v${version}/relay`;
  for(const content of ['<html>error</html>','#!/usr/bin/env bash\nif then\n',"#!/usr/bin/env bash\nRELAY_BUILD_VERSION='0.0.0'\n"]) {
    fs.writeFileSync(body,content);s.http({[url]:{body_file:body}});
    assert.equal(core('download-update',[file,version],'',s.env).status,1);assert.equal(fs.readFileSync(file,'utf8'),'original');
  }
  const content=`#!/usr/bin/env bash\nRELAY_BUILD_VERSION='${version}'\necho fixture\n`;
  fs.writeFileSync(body,content);s.http({[url]:{body_file:body}});
  ok(core('download-update',[file,version],'',s.env));assert.equal(fs.readFileSync(file,'utf8'),content);
  assert.equal(fs.statSync(file).mode&0o777,0o755);assert.equal(fs.readdirSync(s.home).filter(n=>n.startsWith('.relay-update-')).length,0);
});

test('Rust daemon preserves ordered cycling, threshold-aware locks and manual protection', t => {
  const s=sandbox(t); for(const n of ['a','b','c']) s.account(n,{accessToken:'fake'});
  fs.writeFileSync(path.join(s.state,'autoswitch.json'),JSON.stringify({order:['a','b','c'],thresholds:{a:80,b:80,c:80},locks:['b']}));
  fs.writeFileSync(path.join(s.state,'current'),'a');
  const cache={};for(const [name,u] of [['a',95],['b',90],['c',10]])cache[name]={ts:Date.now()/1000,data:{five_hour:{utilization:u}}};
  fs.writeFileSync(path.join(s.state,'usage_cache.json'),JSON.stringify(cache));
  ok(core('daemon-step',[],'',s.env)); assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'c');
  fs.writeFileSync(path.join(s.state,'manual_switch'),JSON.stringify({account:'c'}));
  ok(core('daemon-step',[],'',s.env));assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'c');
  assert.equal(s.json('manual_switch').account,'c');
});

test('Rust daemon all-blocked stays put and rereads changed configuration', t => {
  const s=sandbox(t);for(const n of ['a','b'])s.account(n,{accessToken:'fake'});
  const cfg=path.join(s.state,'autoswitch.json');
  fs.writeFileSync(cfg,JSON.stringify({order:['a','b'],thresholds:{a:80,b:80},locks:['b']}));
  fs.writeFileSync(path.join(s.state,'current'),'a');
  fs.writeFileSync(path.join(s.state,'usage_cache.json'),JSON.stringify({a:{ts:Date.now()/1000,data:{five_hour:{utilization:95}}},b:{ts:Date.now()/1000,data:{five_hour:{utilization:95}}}}));
  ok(core('daemon-step',[],'',s.env));assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'a');
  assert.match(fs.readFileSync(path.join(s.state,'autoswitch.log'),'utf8'),/all_blocked/);
  fs.writeFileSync(cfg,JSON.stringify({order:['a','b'],thresholds:{a:80,b:80},locks:[]}));
  ok(core('daemon-step',[],'',s.env));assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'b');
});

test('same-account warmup preserves live credentials instead of restoring a stale snapshot', t => {
  const s=sandbox(t);
  s.account('a',{accessToken:'synthetic-stale',refreshToken:'synthetic-old'});
  fs.writeFileSync(path.join(s.state,'current'),'a');
  const livePath=path.join(s.home,'.claude/.credentials.json');
  const live=' {"claudeAiOauth":{"accessToken":"synthetic-fresh","refreshToken":"synthetic-new"},"future":true}\n';
  fs.writeFileSync(livePath,live);
  const snapshot=path.join(s.state,'credentials/a.json');
  const before=fs.readFileSync(snapshot);
  const time=new Date().toISOString().slice(11,16);
  fs.writeFileSync(path.join(s.state,'autoswitch.json'),JSON.stringify({order:[],warmup:[{account:'a',time}]}));
  ok(core('daemon-step',[],'',s.env));
  assert.equal(fs.readFileSync(livePath,'utf8'),live,'same-account warmup must not write live credentials');
  assert.deepEqual(fs.readFileSync(snapshot),before,'same-account switch must not mutate its snapshot either');
  assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'a');
  assert.equal(s.json('warmup_state.json')[`a|${time}`].status,'ok');
  assert.equal(fs.readFileSync(path.join(s.home,'agent-calls'),'utf8').trim().split('\n').length,1);
});

test('same-account warmup does not read a corrupt snapshot or recreate missing live credentials', t => {
  const s=sandbox(t);s.account('a');
  fs.writeFileSync(path.join(s.state,'current'),'a');
  fs.writeFileSync(path.join(s.state,'credentials/a.json'),'corrupt snapshot');
  const time=new Date().toISOString().slice(11,16);
  fs.writeFileSync(path.join(s.state,'autoswitch.json'),JSON.stringify({order:[],warmup:[{account:'a',time}]}));
  ok(core('daemon-step',[],'',s.env));
  assert.equal(fs.existsSync(path.join(s.home,'.claude/.credentials.json')),false);
  assert.equal(fs.readFileSync(path.join(s.state,'credentials/a.json'),'utf8'),'corrupt snapshot');
});

test('Rust daemon warmup runs once per local day and restores the original account', t => {
  const s=sandbox(t);s.account('a',{accessToken:'fake-a'});s.account('b',{accessToken:'fake-b'});
  fs.writeFileSync(path.join(s.state,'current'),'b');
  const time=new Date().toISOString().slice(11,16);
  fs.writeFileSync(path.join(s.state,'autoswitch.json'),JSON.stringify({order:[],warmup:[{account:'a',time}]}));
  for(let i=0;i<2;i++)ok(core('daemon-step',[],'',s.env));
  assert.equal(fs.readFileSync(path.join(s.state,'current'),'utf8'),'b');
  assert.equal(s.json('warmup_state.json')[`a|${time}`].status,'ok');
  assert.equal(fs.readFileSync(path.join(s.home,'agent-calls'),'utf8').trim().split('\n').length,1);
});

test('Rust daemon rejects second instance and cleans PID state on SIGTERM', async t => {
  const s=sandbox(t);fs.writeFileSync(path.join(s.state,'autoswitch.json'),'{"order":[]}');
  const child=spawn(binary,['daemon'],{env:s.env,stdio:'ignore'}); t.after(()=>child.kill('SIGKILL'));
  const finished=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  const pid=path.join(s.state,'autoswitch.lock');
  const deadline=Date.now()+5000;while(!fs.existsSync(pid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.ok(fs.existsSync(pid));assert.equal(core('daemon',[],'',s.env).status,1);
  child.kill('SIGTERM');
  const result=await Promise.race([finished,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('daemon termination timeout')),5000);timer.unref();})]);
  assert.equal(result.code,0);assert.equal(fs.existsSync(pid),false);
});

test('stdin JSON preserves ordering, Unicode, unknown fields and large integers', () => {
  const input = '{"z":"中文\\n\\\"","a":184467440737095516160000000000000000,"extra":[true,null]}';
  const output = ok(core('format-json', [], input));
  assert.match(output, /184467440737095516160000000000000000/);
  assert.ok(output.indexOf('"z"') < output.indexOf('"a"'));
  assert.equal(JSON.parse(output).z, '中文\n"');
  assert.equal(ok(core('access-token', [], '{"claudeAiOauth":{"accessToken":"fake-only"}}')), 'fake-only\n');
  assert.equal(ok(core('access-token', [], '{"claudeAiOauth":null}')), '\n');
  const failed = core('format-json', [], '{"fake-secret":"DO-NOT-LOG",');
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stderr, /DO-NOT-LOG/);
});

test('file readers match Python on valid metadata, optional fields and discovery truthiness', t => {
  const f = fixture(t);
  f.write({ model: '中文 " \\ $HOME', version, oauthAccount: { emailAddress: 'fixture@example.test' } });
  for (const [op, script, args] of [
    ['provider-field', 'provider_field', [f.file, 'model']],
    ['provider-field', 'provider_field', [f.file, 'missing']],
    ['read-version', 'read_version', [f.file]],
    ['account-email', 'grab_email_from_claude_json', [f.file]],
  ]) assert.equal(ok(core(op, args)), ok(python(script, args)));
  for (const value of [false, null, 0, '', [], {}, true, 'yes', [1]]) {
    f.write({ discover_models: value });
    assert.equal(ok(core('provider-discover', [f.file])), ok(python('provider_discover', [f.file])));
  }
  fs.writeFileSync(f.file, 'corrupt');
  assert.equal(ok(core('account-email', [f.file])), '\n');
});

test('configuration operations match Python and preserve unknown fields', t => {
  const f = fixture(t);
  const legacy = path.join(f.dir, 'legacy.json');
  const seed = { order: ['b', 'a'], thresholds: { a: 73 }, locks: [], warmup: [], future: { nested: ['keep'] } };
  f.write(seed); fs.writeFileSync(legacy, JSON.stringify(seed));
  const operations = [
    ['reorder', 'a,b'], ['lock-add', 'a'], ['lock-add', 'a'], ['unlock', 'b'], ['unlock', 'a'],
    ['warmup-add', 'a', '06:00'], ['warmup-add', 'a', '06:00'], ['warmup-add', 'a', '08:00'],
    ['warmup-add', 'b', '06:00'], ['warmup-pause'], ['warmup-resume'],
    ['warmup-remove', 'a', '06:00'], ['warmup-remove', 'a', ''], ['warmup-remove', 'missing', ''],
  ];
  for (const [op, ...args] of operations) {
    assert.equal(ok(core(op, [f.file, ...args])), ok(python(op.replaceAll('-', '_'), [legacy, ...args])), op);
    assert.deepEqual(f.read(), JSON.parse(fs.readFileSync(legacy)), op);
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  }
  assert.deepEqual(f.read().future, seed.future);
  assert.equal(fs.readdirSync(f.dir).filter(n => n.startsWith('.relay-write-')).length, 0);
});

test('bad configuration or failed replacement does not truncate state or leak input', t => {
  const f = fixture(t);
  for (const text of ['{bad-secret', '[]', '{"locks":null}', '{"locks":"SECRET"}']) {
    fs.writeFileSync(f.file, text);
    const result = core('lock-add', [f.file, 'a']);
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), text);
    assert.doesNotMatch(result.stderr, /SECRET|bad-secret/);
  }
  const directory = path.join(f.dir, 'target-dir'); fs.mkdirSync(directory);
  const result = core('provider-add', [], '', {
    RELAY_PROVIDER_PATH: directory, RELAY_PROVIDER_BASE_URL: 'https://example.test', RELAY_PROVIDER_TOKEN: 'DO-NOT-LOG',
  });
  assert.equal(result.status, 1);
  assert.ok(fs.statSync(directory).isDirectory());
  assert.doesNotMatch(result.stderr, /DO-NOT-LOG/);
  assert.equal(fs.readdirSync(f.dir).filter(n => n.startsWith('.relay-write-')).length, 0);
});

test('concurrent config mutations do not lose updates', async t => {
  const f = fixture(t); f.write({ locks: [], future: 42 });
  await Promise.all(Array.from({ length: 24 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(binary, ['lock-add', f.file, 'account-' + i], { timeout: 10000 });
    let stderr = ''; child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  assert.equal(f.read().locks.length, 24);
  assert.equal(new Set(f.read().locks).size, 24);
  assert.equal(f.read().future, 42);
});

test('provider and run settings keep secret values off argv and produce equivalent JSON', t => {
  const f = fixture(t), legacy = path.join(f.dir, 'legacy.json');
  for (const run of [false, true]) {
    const prefix = run ? 'RELAY_RUN' : 'RELAY_PROVIDER';
    const variable = run ? 'RELAY_RUN_SETTINGS_FILE' : 'RELAY_PROVIDER_PATH';
    const env = {
      [`${prefix}_BASE_URL`]: 'https://example.test/中文', [`${prefix}_TOKEN`]: 'fake "token" \\ $VALUE',
      [`${prefix}_MODEL`]: 'fixture-model', [`${prefix}_SUBAGENT_MODEL`]: 'sub',
      [`${prefix}_DISCOVER`]: '1', RELAY_PROVIDER_AGENT: 'codex',
    };
    ok(core(run ? 'run-settings' : 'provider-add', [], '', { ...env, [variable]: f.file }));
    ok(python(run ? 'run_settings' : 'provider_add', [], { ...env, [variable]: legacy }));
    assert.deepEqual(f.read(), JSON.parse(fs.readFileSync(legacy)));
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  }
});

test('explicit core selection rejects missing or mismatched binaries without fallback', { skip: process.platform === 'win32' }, t => {
  const s = sandbox(t);
  for (const selection of ['relative/core', path.join(s.home, 'missing')]) {
    assert.equal(s.run(['version'], '', { RELAY_CORE_BIN: selection }).status, 1);
  }
  const fake = path.join(s.bin, 'wrong-core');
  fs.writeFileSync(fake, '#!/bin/sh\necho "relay-core 99 0.0.0"\n', { mode: 0o755 });
  const mismatch = s.run(['version'], '', { RELAY_CORE_BIN: fake });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /protocol\/version mismatch/);
  assert.equal(s.run(['version'], '', { RELAY_CORE_BIN: binary }).status, 0);
});

test('core write failures propagate through public CLI without a false success', { skip: process.platform === 'win32' }, t => {
  const s = sandbox(t); s.account('a');
  fs.writeFileSync(path.join(s.state, 'autoswitch.json'), '{"locks":null}');
  const result = s.run(['lock', 'a'], '', { RELAY_CORE_BIN: binary });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.text, /Locked/);
  assert.match(result.stderr, /locks must be an array/);
});

test('selected helper operations do not invoke Python; core errors never retry Python', { skip: process.platform === 'win32' }, t => {
  const s = sandbox(t);
  for (const name of ['python3', 'python']) {
    fs.writeFileSync(path.join(s.bin, name), '#!/bin/sh\necho "Python must not run" >&2\nexit 92\n', { mode: 0o755 });
  }
  const result = s.run(['provider', 'add', 'fixture', '--base-url', 'https://example.test', '--token', 'fake-only'], '', { RELAY_CORE_BIN: binary });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.json('providers/fixture.json').auth_token, 'fake-only');
  const listing = s.run(['provider', 'list'], '', { RELAY_CORE_BIN: binary });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.text, /https:\/\/example.test/);
  const fake = path.join(s.bin, 'failing-core');
  fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = protocol ]; then echo 'relay-core 1 ${version}'; else exit 23; fi\n`, { mode: 0o755 });
  const failed = s.run(['provider', 'add', 'failed', '--base-url', 'https://example.test', '--token', 'fake-only'], '', { RELAY_CORE_BIN: fake });
  assert.equal(failed.status, 23);
  assert.equal(fs.existsSync(path.join(s.state, 'providers/failed.json')), false);
  assert.doesNotMatch(failed.text, /added/);
});

test('configuration lock interoperates with POSIX flock and releases after holder termination', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = fixture(t); f.write({ locks: [] });
  // The legacy runtime uses fcntl.flock. A separate process holds the same
  // stable sidecar inode while Rust is started, then is forcibly terminated.
  const holder = spawn('python3', ['-u', '-c',
    'import fcntl,sys,time\nf=open(sys.argv[1],"w")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("ready",flush=True)\ntime.sleep(30)',
    f.file + '.lock'], { timeout: 12000 });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('error', reject);
    holder.once('exit', code => reject(new Error('lock holder exited: ' + code)));
  });
  const child = spawn(binary, ['lock-add', f.file, 'after-release'], { timeout: 10000 });
  t.after(() => child.kill('SIGKILL'));
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('core exit: ' + code)));
  });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, 'core must wait while the POSIX flock holder is alive');
  assert.deepEqual(f.read().locks, []);
  holder.kill('SIGKILL');
  await completed;
  assert.deepEqual(f.read().locks, ['after-release']);
  ok(core('lock-add', [f.file, 'next-process']));
  assert.deepEqual(f.read().locks, ['after-release', 'next-process']);
});

test('default configuration matches Python ordering, thresholds and warmup schema', t => {
  const f = fixture(t);
  for (const op of ['lock-default-config', 'warmup-ensure-config']) {
    const paths = ['new', 'old'].map(n => path.join(f.dir, op, n));
    for (const dir of paths) {
      fs.mkdirSync(path.join(dir, 'credentials'), { recursive: true });
      for (const name of ['z', 'a', 'b']) fs.writeFileSync(path.join(dir, 'credentials', name + '.json'), '{}');
      fs.writeFileSync(path.join(dir, 'order'), 'z\nz\nstale\na\n');
    }
    const args = dir => [path.join(dir, 'credentials'), path.join(dir, 'autoswitch.json')];
    ok(core(op, args(paths[0])));
    ok(python(op.replaceAll('-', '_'), args(paths[1])));
    for (const name of ['autoswitch.json', 'order']) {
      const a = fs.readFileSync(path.join(paths[0], name), 'utf8'), b = fs.readFileSync(path.join(paths[1], name), 'utf8');
      if (name.endsWith('.json')) assert.deepEqual(JSON.parse(a), JSON.parse(b));
      else assert.equal(a, b);
    }
    const cfg = path.join(paths[0], 'autoswitch.json');
    ok(core('lock-add', [cfg, 'a']));
    ok(core(op, args(paths[0])));
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg)).locks, ['a'], 'late initializer must not reset a completed mutation');
  }
});

test('initialization and config mutations serialize without resetting previous values', async t => {
  const f = fixture(t), creds = path.join(f.dir, 'credentials');
  fs.mkdirSync(creds); fs.writeFileSync(path.join(creds, 'a.json'), '{}');
  const children = Array.from({ length: 20 }, (_, i) => new Promise((resolve, reject) => {
    const init = spawn(binary, ['warmup-ensure-config', creds, f.file], { timeout: 10000 });
    init.once('error', reject);
    init.once('exit', code => {
      if (code !== 0) return reject(new Error('init failed'));
      const add = spawn(binary, ['lock-add', f.file, 'account-' + i], { timeout: 10000 });
      add.once('error', reject); add.once('exit', c => c === 0 ? resolve() : reject(new Error('lock mutation failed')));
    });
  }));
  await Promise.all(children);
  assert.equal(new Set(f.read().locks).size, 20);
});

test('structured config save preserves existing data and malformed input leaves bytes intact', t => {
  const f = fixture(t), old = path.join(f.dir, 'old.json');
  const seed = { locks: ['a'], warmup: [{ account: 'a', time: '06:00' }], future: { keep: true } };
  f.write(seed); fs.writeFileSync(old, JSON.stringify(seed));
  const input = JSON.stringify({ order: ['a'], thresholds: { a: 75 }, poll: { low_minutes: 10, high_minutes: 2, high_threshold: 50 } });
  ok(core('config-save', [f.file], input));
  ok(python('config_save', [old], {}, input));
  assert.deepEqual(f.read(), JSON.parse(fs.readFileSync(old)));
  const before = fs.readFileSync(f.file);
  for (const malformed of ['{"secret":"NOT-FOR-LOGS",', '[]', 'null']) {
    const result = core('config-save', [f.file], malformed);
    assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /NOT-FOR-LOGS/);
    assert.deepEqual(fs.readFileSync(f.file), before);
  }
});

test('ordering picker and cycle text match Python for shorthand, named and invalid input', () => {
  for (const accounts of [['a', 'b', 'c'], Array.from({ length: 12 }, (_, i) => 'a' + i)]) {
    for (const raw of ['', '312', '2 1', '2,1', '0 99999999999999999999999 1', 'b,a', '2 2 1', '  3\t1\n2  ', '中文 1']) {
      assert.equal(ok(core('prompt-reorder', [raw, ...accounts])), ok(python('prompt_reorder', [raw, ...accounts])), raw);
    }
  }
  for (const input of ['', 'a,b,c\n', '  a, b  ']) {
    assert.equal(ok(core('reorder-chain', [], input)), ok(python('reorder_chain', [], {}, input)));
  }
});

test('Codex models get/set/pick match the synchronized 2.9.1 Python behavior', t => {
  const f = fixture(t), old = path.join(f.dir, 'old.json');
  f.write({ auth_token: 'fake-only', future: { keep: true } }); fs.copyFileSync(f.file, old);
  for (const [op, ...args] of [
    ['codex-models-get'], ['codex-model-pick'], ['codex-models-set', ' alpha, beta ,,中文 '],
    ['codex-models-get'], ...Array.from({ length: 8 }, () => ['codex-model-pick']),
    ['codex-models-set', ',,'], ['codex-model-pick'],
  ]) {
    assert.equal(ok(core(op, [f.file, ...args])), ok(python(op.replaceAll('-', '_'), [old, ...args])));
    assert.deepEqual(f.read(), JSON.parse(fs.readFileSync(old)));
  }
});

test('concurrent Codex picks advance one shared cursor without lost writes', async t => {
  const f = fixture(t); f.write({ codex_models: ['a', 'b', 'c'], _codex_model_cursor: -1, auth_token: 'fake-only' });
  const output = await Promise.all(Array.from({ length: 30 }, () => new Promise((resolve, reject) => {
    const child = spawn(binary, ['codex-model-pick', f.file], { timeout: 10000 });
    let text = ''; child.stdout.on('data', b => { text += b; });
    // exit can precede stdout drainage (observed on native Linux). close waits
    // for the process and its stdio, so the assertion sees the complete result.
    child.once('error', reject); child.once('close', c => c === 0 ? resolve(text.trim()) : reject(new Error('pick failed')));
  })));
  for (const name of ['a', 'b', 'c']) assert.equal(output.filter(n => n === name).length, 10);
  assert.equal(f.read()._codex_model_cursor, 2);
  assert.equal(f.read().auth_token, 'fake-only');
});

test('lock, warmup and configuration displays match ANSI output exactly', t => {
  const f = fixture(t), state = path.join(f.dir, 'warmup_state.json');
  for (const warmup of [[], [{ account: 'a', time: '06:00' }, { account: '中文', time: '08:00' }]]) {
    f.write({ order: ['a', '中文'], locks: ['a'], thresholds: { a: 75, 中文: 0 }, poll: { low_minutes: 10, high_minutes: 2, high_threshold: 50 }, warmup, warmup_enabled: false });
    for (const [op, args] of [['lock-list', [f.file]], ['warmup-list', [f.file, state]], ['autoswitch-config-summary', [f.file]]]) {
      assert.equal(ok(core(op, args)), ok(python(op.replaceAll('-', '_'), args)), op);
    }
    for (const status of ['ok', 'ping_failed', 'missed', 'missing_account', 'custom']) {
      fs.writeFileSync(state, JSON.stringify({ 'a|06:00': { status, date: '2026-09-08' } }));
      assert.equal(ok(core('warmup-list', [f.file, state])), ok(python('warmup_list', [f.file, state])));
    }
  }
});

test('warmup health preserves the last-2000-lines window and failure denominator', t => {
  const f = fixture(t), log = path.join(f.dir, 'events.jsonl');
  f.write({ warmup: [{ account: 'a', time: '06:00' }, { account: 'a', time: '08:00' }, { account: 'b', time: '06:00' }] });
  const lines = Array.from({ length: 2100 }, () => JSON.stringify({ event: 'warmup_missed', account: 'b', time: '06:00' }));
  lines.push(...Array.from({ length: 2000 }, () => '{}'));
  lines.push('malformed', ...Array.from({ length: 3 }, () => JSON.stringify({ event: 'warmup_ping', account: 'a', ok: false })));
  lines.push(JSON.stringify({ event: 'warmup_ping', account: 'a', ok: true }));
  fs.writeFileSync(log, lines.join('\n') + '\n');
  const output = ok(core('warmup-health', [f.file, log]));
  assert.equal(output, ok(python('warmup_health', [f.file, log])));
  assert.match(output, /3\/4/); assert.doesNotMatch(output, /warmup: b/);
});

test('autoswitch status matches cached utilization, skipped thresholds, locks and next marker', t => {
  const s = sandbox(t), cfg = path.join(s.state, 'autoswitch.json');
  const value = { order: ['a', 'b', 'c'], thresholds: { a: 75, b: 80, c: null }, locks: ['a', 'b'] };
  fs.writeFileSync(cfg, JSON.stringify(value));
  fs.writeFileSync(path.join(s.state, 'usage_cache.json'), JSON.stringify({ a: { data: { five_hour: { utilization: 80.9 } } }, b: { data: { five_hour: { utilization: 20 } } }, c: null }));
  const log = path.join(s.state, 'autoswitch.log');
  fs.writeFileSync(log, JSON.stringify({ event: 'switch', frm: 'a', to: 'b' }) + '\n');
  for (const current of ['a', 'b', 'missing']) {
    assert.equal(ok(core('autoswitch-status', [cfg, current], '', s.env)), ok(python('autoswitch_status', [cfg, current], s.env)));
  }
  fs.appendFileSync(log, 'bad-json\n');
  assert.equal(ok(core('autoswitch-status', [cfg, 'a'], '', s.env)), ok(python('autoswitch_status', [cfg, 'a'], s.env)));
});

test('event timestamps match Python local time across UTC, Taipei and DST boundaries', t => {
  const f = fixture(t);
  const events = [
    ...Array.from({ length: 22 }, (_, i) => ({ event: 'start', ts: 1700000000 + i })),
    { event: 'switch', ts: 1710064799, frm: 'a', to: 'b', usage: 80 },
    { event: 'all_over_threshold', ts: 1730624400, selected: 'c' },
    { event: 'start', ts: -0.5 }, { event: 'switch', ts: 1710064800 }, { event: 'unknown', ts: 0 },
  ];
  fs.writeFileSync(f.file, events.map(e => JSON.stringify(e)).join('\n') + '\nmalformed\n');
  for (const TZ of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
    assert.equal(ok(core('autoswitch-log', [f.file], '', { TZ })), ok(python('autoswitch_log', [f.file], { TZ })), TZ);
  }
});

test('session display matches project ordering, size boundary and local timestamps', t => {
  const f = fixture(t), base = path.join(f.dir, 'projects');
  fs.mkdirSync(base);
  assert.equal(ok(core('sessions', [base])), ok(python('sessions', [base])));
  for (const project of ['z-project', 'a-project']) {
    const dir = path.join(base, project); fs.mkdirSync(dir);
    for (const [i, size] of [0, 1024, 1048576, 1048577].entries()) {
      const file = path.join(dir, 'session-' + i + '.jsonl'); fs.writeFileSync(file, ''); fs.truncateSync(file, size);
      fs.utimesSync(file, 1700000000 + i * 60, 1700000000 + i * 60);
    }
    fs.writeFileSync(path.join(dir, '.hidden.jsonl'), '');
  }
  for (const TZ of ['UTC', 'Asia/Taipei', 'America/Los_Angeles']) {
    assert.equal(ok(core('sessions', [base], '', { TZ })), ok(python('sessions', [base], { TZ })), TZ);
  }
});

test('public config and display paths work with Python execution blocked', { skip: process.platform === 'win32' }, t => {
  const s = sandbox(t); s.account('a'); s.account('b');
  for (const name of ['python3', 'python']) fs.writeFileSync(path.join(s.bin, name), '#!/bin/sh\nexit 92\n', { mode: 0o755 });
  const env = { RELAY_CORE_BIN: binary };
  for (const args of [['lock', 'a'], ['lock'], ['warmup', 'add', 'a', '06:00'], ['warmup', 'list'], ['warmup', 'pause'], ['warmup', 'resume'], ['autoswitch', 'status']]) {
    const r = s.run(args, '', env); assert.equal(r.status, 0, args.join(' ') + r.stderr);
  }
  const result = s.run(['autoswitch', 'config'], '2 1\n70\n80\n10\n2\n50\n', env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(s.json('autoswitch.json').locks, ['a']);
  assert.equal(s.json('autoswitch.json').warmup[0].time, '06:00');
  assert.deepEqual(s.json('autoswitch.json').order, ['b', 'a']);
  const before = fs.readFileSync(path.join(s.state, 'autoswitch.json'));
  const failed = s.run(['autoswitch', 'config'], '\nnot-a-number\n80\n10\n2\n50\n', env);
  assert.equal(failed.status, 1); assert.doesNotMatch(failed.text, /Config saved/);
  assert.deepEqual(fs.readFileSync(path.join(s.state, 'autoswitch.json')), before);
});

test('synchronized public Codex rotation preserves explicit model precedence', { skip: process.platform === 'win32' }, t => {
  const s = sandbox(t), env = { RELAY_CORE_BIN: binary };
  assert.equal(s.run(['provider', 'add', 'rotation', '--base-url', 'https://example.test', '--token', 'fake-only'], '', env).status, 0);
  assert.equal(s.run(['provider', 'codex-models', 'rotation', 'alpha,beta'], '', env).status, 0);
  for (const model of ['alpha', 'beta', 'alpha']) {
    const result = s.run(['run', 'rotation', '--codex', '--', 'a prompt'], '', env);
    assert.equal(result.status, 0, result.stderr);
    const call = JSON.parse(fs.readFileSync(path.join(s.home, 'agent-call.json')));
    assert.ok(call.args.includes(`model="${model}"`));
    assert.ok(call.args.includes('a prompt'));
  }
  const provider = s.json('providers/rotation.json'); provider.model = 'pinned';
  fs.writeFileSync(path.join(s.state, 'providers/rotation.json'), JSON.stringify(provider));
  assert.equal(s.run(['run', 'rotation', '--codex'], '', env).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(s.home, 'agent-call.json'))).args.includes('model="pinned"'));
  assert.equal(s.json('providers/rotation.json')._codex_model_cursor, 0);
});
