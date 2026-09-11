#!/usr/bin/env node
'use strict';
// Local synthetic benchmark. Never contacts OAuth or uses the real HOME.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { sandbox, root } = require('../tests/support/sandbox.cjs');
const stage = process.argv[2] || '';
const rawOnly = process.argv[3] === '--raw-only';
if (process.argv.length > (rawOnly ? 4 : 3) || (stage && !/^stage-\d{2}$/.test(stage))) throw new Error('Usage: node scripts/benchmark-core.cjs [stage-NN] [--raw-only]');
const basename = stage ? `${stage}-rust-core` : 'rust-core';
if (process.platform !== 'darwin') throw new Error('This collector requires macOS /usr/bin/time -l; do not compare different collectors');
const cleanup = [];
const s = sandbox({ after: fn => cleanup.push(fn) });
const binary = path.join(root, 'target/release/relay-core');
const baseline = 'b40c791cab7ece474119071db8f15f840453dab0';
const count = 30;
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1];
try {
  s.account('a'); s.account('b');
  const config = path.join(s.state, 'autoswitch.json');
  fs.writeFileSync(config, JSON.stringify({ order: ['a','b'], locks: ['a'], warmup: [], thresholds: {a:80,b:80} }));
  const provider = path.join(s.home, 'provider.json');
  fs.writeFileSync(provider, JSON.stringify({model:'fixture-model', future:{keep:true}}));
  const old = path.join(s.home, 'baseline-relay');
  fs.writeFileSync(old, execFileSync('git', ['show', baseline+':relay'], {cwd:root}));
  const variants = [
    {name:'original-2.9.0', script:old, version:'2.9.0', core:''},
    {name:'modular-python', script:path.join(root,'relay'), version:require('../package.json').version, core:''},
    {name:'modular-rust', script:path.join(root,'relay'), version:require('../package.json').version, core:binary},
  ];
  const rows = [];
  for (const workload of ['provider-field helper', 'relay lock (full CLI)']) {
    const samples = variants.map(() => []);
    let reference;
    // Alternate execution order to reduce time/order bias; five discarded warmups each.
    for(let round=-5; round<count; round++) for(let offset=0; offset<variants.length; offset++) {
      const i=(round+5+offset)%variants.length, v=variants[i];
      fs.writeFileSync(path.join(s.state,'.update_cache'), `${Math.floor(Date.now()/1000)}:${v.version}`);
      const command = workload.startsWith('relay') ? ['/bin/bash',v.script,'lock']
        : v.core ? [binary,'provider-field',provider,'model']
        : ['python3',path.join(root,'src/python/provider_field.py'),provider,'model'];
      const start=process.hrtime.bigint();
      const r=spawnSync('/usr/bin/time',['-l',...command],{cwd:s.home,env:{...s.env,RELAY_CORE_BIN:v.core},encoding:'utf8',timeout:15000});
      const wall=Number(process.hrtime.bigint()-start)/1e6;
      if(r.error || r.status!==0) throw new Error('Benchmark failed: '+v.name+' '+r.stderr);
      if(reference===undefined) reference=r.stdout;
      if(reference!==r.stdout) throw new Error('Output mismatch: '+workload+' '+v.name);
      const rss=r.stderr.match(/(\d+)\s+maximum resident set size/);
      const cpu=r.stderr.match(/([\d.]+)\s+user\s+([\d.]+)\s+sys/);
      if(!rss || !cpu) throw new Error('Unrecognized time output');
      if(round>=0) samples[i].push({wall_ms:wall,max_process_rss_bytes:Number(rss[1]),cpu_ms:(Number(cpu[1])+Number(cpu[2]))*1000});
    }
    samples.forEach((values,i)=>rows.push({workload,variant:variants[i].name,n:values.length,failures:0,p50_ms:percentile(values.map(x=>x.wall_ms),.5),p95_ms:percentile(values.map(x=>x.wall_ms),.95),rss_p50_bytes:percentile(values.map(x=>x.max_process_rss_bytes),.5),cpu_p50_ms:percentile(values.map(x=>x.cpu_ms),.5),samples:values}));
  }
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const metadata={date:new Date().toISOString(),baseline,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,os:os.release(),cpu:os.cpus()[0].model,node:process.version,python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim(),rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),baseline_sha256:hash(old),candidate_sha256:hash(path.join(root,'relay')),core_sha256:hash(binary),core_bytes:fs.statSync(binary).size};
  metadata.warmups_per_group = 5;
  metadata.samples_per_group = count;
  const out=path.join(root,'docs/reports');
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,`${basename}-benchmark.json`),JSON.stringify({metadata,rows},null,2)+'\n');
  if (rawOnly) { console.log(rows.map(({samples,...r})=>r)); return; }
  const lines=['# Rust core 階段性 SRE 本機量測','',`量測時間：${metadata.date}。原版基線：\`${baseline}\`（2.9.0）；候選：${metadata.head} 的未提交工作樹。`,'',`環境：${metadata.cpu} / ${metadata.platform} ${metadata.arch} / ${metadata.os} / Node ${metadata.node} / ${metadata.python} / ${metadata.rust}。`,'','## 延遲與資源','', '| 工作負載 | 版本 | n | 失敗 | p50 ms | p95 ms | RSS p50 MiB | CPU p50 ms |','|---|---|---:|---:|---:|---:|---:|---:|',...rows.map(r=>`| ${r.workload} | ${r.variant} | ${r.n} | ${r.failures} | ${r.p50_ms.toFixed(2)} | ${r.p95_ms.toFixed(2)} | ${(r.rss_p50_bytes/1048576).toFixed(2)} | ${r.cpu_p50_ms.toFixed(0)} |`),''];
  for(const workload of [...new Set(rows.map(r=>r.workload))]){const a=rows.find(r=>r.workload===workload),b=rows.find(r=>r.workload===workload&&r.variant==='modular-rust');lines.push(`${workload}：Rust 相對原版 p50 延遲降低 ${(100*(1-b.p50_ms/a.p50_ms)).toFixed(1)}%，速度比 ${(a.p50_ms/b.p50_ms).toFixed(2)}×；RSS p50 差異 ${(100*(b.rss_p50_bytes/a.rss_p50_bytes-1)).toFixed(1)}%。`,'');}
  lines.push('## 方法與限制','','- 每組 3 次預熱、30 次量測，交錯順序；同一 fixture、逐次確認退出碼與 stdout 相同。不是冷啟動／高併發／長時間 soak test。','- helper 的原版與 modular-python 都執行未改寫的 provider_field.py；完整 CLI 才執行 git 中原版單檔。','- wall 包含 Node spawn 與 time 包裝成本。macOS time -l 的 RSS 不是整棵程序樹同時峰值；CPU 只有 10 ms 輸出精度，0 不表示沒有消耗。','- CLI 使用隔離 HOME、合成帳號、Node 安全 shim（包含 uname）；有固定 harness 開銷，不能視為真實使用者的絕對延遲。未呼叫 OAuth 或真實服務。',`- Rust release binary 大小：${metadata.core_bytes} bytes；目前未納入 npm 發布，不能當成已安裝套件大小。`,'- 原版 → 現版也包含拆檔與可靠性修正；modular-python 對照用來區分 Rust 路徑影響。','- 0/30 失敗只是樣本結果，不是 SLA、99.9% 可用率或正式環境錯誤率。','- 正式環境 uptime、MTTR、MTBF、OAuth 成功率、daemon 長期 CPU/RSS、Windows/Linux Rust 效能、部署頻率均 UNKNOWN。','- 目前為部分 Rust core，Python 仍必要；不能外推為整個產品的 Rust 加速倍數。','','原始樣本與 SHA-256： [rust-core-benchmark.json](rust-core-benchmark.json)。重跑：`cargo build --release --locked && node scripts/benchmark-core.cjs`。','');
  fs.writeFileSync(path.join(out,`${basename}-sre-comparison.md`),lines.join('\n').replace('每組 3 次預熱','每組 5 次預熱').replaceAll('rust-core-benchmark.json',`${basename}-benchmark.json`).replace('node scripts/benchmark-core.cjs`',`node scripts/benchmark-core.cjs ${stage}\``));
  console.log(rows.map(({samples,...r})=>r));
} finally {for(const fn of cleanup.reverse()) fn();}
