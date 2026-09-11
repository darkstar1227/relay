# Rust core 階段性 SRE 本機量測

量測時間：2026-09-08T03:51:55.708Z。原版基線：`b40c791cab7ece474119071db8f15f840453dab0`（2.9.0）；候選：9c70db91c6e25b951d4d10c8d92c15566946f75a 的未提交工作樹。

環境：Apple M4 / darwin arm64 / 27.0.0 / Node v22.20.0 / Python 3.14.5 / rustc 1.96.1 (31fca3adb 2026-06-26) (Homebrew)。

## 延遲與資源

| 工作負載 | 版本 | n | 失敗 | p50 ms | p95 ms | RSS p50 MiB | CPU p50 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| provider-field helper | original-2.9.0 | 30 | 0 | 39.06 | 44.97 | 23.83 | 20 |
| provider-field helper | modular-python | 30 | 0 | 39.37 | 44.72 | 23.86 | 20 |
| provider-field helper | modular-rust | 30 | 0 | 5.17 | 5.84 | 5.98 | 0 |
| relay lock (full CLI) | original-2.9.0 | 30 | 0 | 85.34 | 115.75 | 38.98 | 70 |
| relay lock (full CLI) | modular-python | 30 | 0 | 87.83 | 134.95 | 39.00 | 70 |
| relay lock (full CLI) | modular-rust | 30 | 0 | 44.46 | 74.53 | 39.00 | 30 |

provider-field helper：Rust 相對原版 p50 延遲降低 86.8%，速度比 7.56×；RSS p50 差異 -74.9%。

relay lock (full CLI)：Rust 相對原版 p50 延遲降低 47.9%，速度比 1.92×；RSS p50 差異 0.0%。

## 方法與限制

- 每組 3 次預熱、30 次量測，交錯順序；同一 fixture、逐次確認退出碼與 stdout 相同。不是冷啟動／高併發／長時間 soak test。
- helper 的原版與 modular-python 都執行未改寫的 provider_field.py；完整 CLI 才執行 git 中原版單檔。
- wall 包含 Node spawn 與 time 包裝成本。macOS time -l 的 RSS 不是整棵程序樹同時峰值；CPU 只有 10 ms 輸出精度，0 不表示沒有消耗。
- CLI 使用隔離 HOME、合成帳號、Node 安全 shim（包含 uname）；有固定 harness 開銷，不能視為真實使用者的絕對延遲。未呼叫 OAuth 或真實服務。
- Rust release binary 大小：4448288 bytes；目前未納入 npm 發布，不能當成已安裝套件大小。
- 原版 → 現版也包含拆檔與可靠性修正；modular-python 對照用來區分 Rust 路徑影響。
- 0/30 失敗只是樣本結果，不是 SLA、99.9% 可用率或正式環境錯誤率。
- 正式環境 uptime、MTTR、MTBF、OAuth 成功率、daemon 長期 CPU/RSS、Windows/Linux Rust 效能、部署頻率均 UNKNOWN。
- 目前為部分 Rust core，Python 仍必要；不能外推為整個產品的 Rust 加速倍數。

原始樣本與 SHA-256： [stage-04-rust-core-benchmark.json](stage-04-rust-core-benchmark.json)。重跑：`cargo build --release --locked && node scripts/benchmark-core.cjs stage-04`。
