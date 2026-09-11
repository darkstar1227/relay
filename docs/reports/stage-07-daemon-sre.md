# 階段 07 SRE：Rust daemon 與剩餘五程式整合

日期：2026-09-08。候選為 2.9.2 `81121a7` 工作樹，保留另一 session 的 Codex /v1 修正；恢復遭覆蓋的組合／測試指令、publish gate 和 Windows 5.1 修正。沒有額外 bump、commit、push 或發布。

五個原始程式（render_table、status_once、refresh_all、download_update、autoswitch_daemon）均有 Rust 實作與呼叫路徑。加上共用 `sync-current`，累計 40 個 production named operations，另有僅供測試的 daemon-step；warmup-test 仍保留原本警告 stub，不是新增的功能。

## daemon 行為與可靠性

- 保留 ordered cycling、依 threshold 決定鎖帳號是否排除、manual switch 保護、快慢輪詢、每 30 分鐘 proactive refresh、machine-local warmup 與 15 分鐘 grace window。
- warmup 使用現有 Claude 子程序，30 秒 timeout，成功或失敗後嘗試還原；只有 current 仍是預熱帳號才還原，避免覆蓋期間的手動切換。
- Rust singleton 使用穩定 advisory instance lock，並檢查既有 Python PID；正常退出移除自己的 PID 檔。signal flag 讓 SIGTERM/INT 在主迴圈安全處理，不在 signal handler 做檔案操作。
- startup 保留 log 超過 500 行時留下末 200 行的行為。增加 stop、cycle_error 事件；錯誤內容不包含 token 或原始 parser input。
- Rust opt-in 明確 `autoswitch start` 才部署 Bash wrapper 與獨立複製的 core；不默默把現有 Python service 改指向 Rust。舊 copied core 暫不自動清除，以保留 wrapper 回退可能；不是完整自動 rollback。

Context7 未找到正確 signal crate 索引後，改查 [signal-hook 官方 API](https://docs.rs/signal-hook/0.3.18/signal_hook/flag/fn.register.html)。使用 signal-hook 0.3.18；原生 Windows daemon 不在本次範圍。

## 本機驗收

| 檢查 | 結果／邊界 |
|---|---|
| 預設回歸 | 44/44 通過，Python default |
| Rust unit | 8 項：HTTP 7 項 + release version 形狀 1 項 |
| Core differential／failure／integration | 35 項，含剩餘五程式 |
| 公開 CLI／lock／legacy daemon oracle | 20 項；其中 4 項刻意使用 Python oracle，不能算成 Rust daemon coverage |
| Python 不在 PATH | version/list/switch/status/lock/warmup/daemon deployment 通過；隔離 synthetic HOME |
| daemon 專用 | ordered target、all-blocked、config 重讀、manual 保護、每日 warmup 一次與還原、拒絕第二實例、idle SIGTERM 清理 |
| HTTP 測試穩定性 | 發現 macOS accepted socket 非阻塞 WouldBlock；修成 blocking 且讀完整 headers 後，連續 10 輪 × 7 項通過 |
| npm tarball 隔離安裝 | macOS arm64 / Node 22.20.0 通過；套件仍不包含 Rust binary |
| 原版比較 | 2.9.0 固定基線與候選各 15/15 既有行為通過 |
| 靜態與建置閘門 | build check、fmt check、Clippy all-targets/all-features warnings denied、release build、diff check 通過 |

各套件涵蓋重疊，不加總為獨立 coverage 百分比。fixture HTTP 不代表正式 OAuth，也沒有運行真實服務。

## 效能與限制

本階段 release binary 的 30-sample paired 本機量測另存 [效能報告](stage-07-rust-core-sre-comparison.md) 與 [raw samples / hashes](stage-07-rust-core-benchmark.json)。它比較 provider-field helper 和完整 relay lock；**不包含 daemon 長時間 CPU/RSS、warmup 延遲或真實 OAuth／下載網路耗時**。只使用同一輪數值比較，不混用先前 snapshot。

SIGTERM 測試只涵蓋 idle 狀態，不保證阻塞在 HTTP、Keychain、cache lock 時 1 秒內退出。child timeout 只控制直接子程序，不是完整 process-tree 管理。Rust credential lock 等待有 30 秒上限；其他 I/O 還需故障注入。PID 重用／舊 Python instance race、SIGKILL 殘留、active daemon 移轉與 service 啟動失敗回退仍有待驗收。

剩餘工作不再是這五個 Python 程式的初步 port，而是 production rollout：原生 macOS Keychain/Linux/Windows 驗收、無 Python 的正式 npm artifact、MSRV/架構矩陣、script/core 成對更新、daemon 遷移與完整 rollback、soak 與 SRE 終版。預設 Python fallback 尚未移除；全平台 Rust public CLI 仍是後續階段。生產 uptime、MTTR、MTBF、error budget、OAuth 成功率均 UNKNOWN。
