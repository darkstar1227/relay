# Rust core 階段驗收：2026-09-08

結論：本機回歸與安裝檢查通過，已繼續將 POSIX 憑證鎖 holder 接入 Rust；不是全面 Rust 化完成或正式上線核准。尚未提交／發布。本次仍以同步後的 2.9.1 工作樹為候選。

## 本次實際執行

| 檢查 | 結果 | 邊界 |
|---|---|---|
| `npm test` | 39/39 通過 | 預設 Python 路徑，含 Windows 靜態 guard，不是 Windows 原生執行 |
| `npm run test:core` | 25/25 core、15/15 CLI/daemon 通過 | 仍有未移轉 Python 操作；兩組不可當成不重疊涵蓋率 |
| `node scripts/compare-baseline.cjs` | 原版與候選各 15/15 通過 | 固定 2.9.0 commit，同一既有行為套件 |
| `npm run test:package` | 通過 | 本機隔離 npm 安裝、預設 Python runtime；Rust binary 尚未打包發布 |
| build check、fmt check、Clippy warnings denied、release build、diff check | 全部通過 | macOS arm64，非所有平台 |
| 交錯效能量測 | 6 組各 30 次，180/180 成功且輸出一致 | 另有每組 3 次預熱；非生產可用率 |

完整效能結果與方法：[rust-core-sre-comparison.md](rust-core-sre-comparison.md)。原始樣本、版本與 artifact 雜湊：[rust-core-benchmark.json](rust-core-benchmark.json)。

## 可靠性已有的證據

- 24 個並行 Rust 設定寫入不遺失資料；20 個初始化／設定競爭保留所有結果。
- 30 個並行 Codex 模型輪替，三個模型各取得 10 次；這是單次合成測試，不是高流量服務證據。
- 無效 JSON、不合法設定型別、寫入失敗檢查：不截斷既有狀態，不在診斷印出測試秘密。
- 新增憑證鎖 holder 測試：Rust 持鎖時 Python 的 nonblocking flock 必須失敗；FIFO EOF 正常退出或 SIGKILL 後可重新取得鎖。新鎖檔 mode 0600。
- 已選擇但缺失／版本錯誤的 core 會拒絕啟動；不會靜默回退 Python。

以上是候選的故障注入和行為證據。沒有對原版逐項執行同一套故障注入，所以不能捏造原版失敗率或 MTTR 改善百分比。

## 未解決風險與發布閘門

- 憑證鎖 Shell 包装仍沿用舊 FIFO 協定：FIFO 建立失敗會直接執行原操作，holder 在 ready 前失敗可能使呼叫者等待；這些既有 fail-open／缺乏逾時行為尚未修復。因此本次不是完整 credential-lock hardening。
- 只替換持鎖程序，不代表所有 OAuth refresh 路徑都已在同一鎖內重新讀取 token；single-use refresh token 競爭仍待專門 HTTP fixture 驗證。
- 設定 sidecar lock 與 credential.lock 是不同協定；多數旧 Python 設定寫入者不參與新的 sidecar lock，不能宣稱混合版本並行安全。
- 仍有 7 個原始 Python 程式在 opt-in adapter 以外：usage table、status、refresh-all、daemon、背景更新查詢、版本查詢、下載更新。預設 runtime 仍使用 Python。
- 跨平台 Rust npm artifact、無 Python 安裝、成對更新／回滾、daemon 長時間運行及 cf-windows／ds-home 的新 artifact 原生測試尚未完成。
- 生產 uptime、MTTR、MTBF、正式流量錯誤率、OAuth 成功率、部署頻率均 UNKNOWN；本機短測不能換算 SLA。

下一步先補齊憑證鎖錯誤／逾時處理與 refresh 共用鎖，再移轉 HTTP、快取、daemon 和 updater；全平台 Rust CLI 仍放在 core 完成之後。
