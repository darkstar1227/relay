# 階段 03 SRE：憑證鎖失敗處理

日期：2026-09-08。狀態：本機測試通過，未發布；不是整體 Rust migration 完成。

## 相較上一階段

| 情境 | 上一階段 | 本階段 |
|---|---|---|
| FIFO 建立失敗 | 不持鎖仍執行切換 | 回報失敗，不改 current／憑證 |
| holder 無法開啟 lockfile | 可能無限等 ready | 30 秒等待上限後取消；可設定 1–300 秒 |
| 暫存 IPC 命名 | PID 固定名稱 | mktemp 私有目錄 |
| 完成／錯誤清理 | 依賴正常走完函式 | subshell EXIT trap 終止並回收 holder、移除 IPC |
| PID 管理 | 包裝程序與 holder 可能不同 | 背景 exec，$! 對應真正 holder |

回歸：預設路徑 44/44；Rust core 25/25；Rust CLI／daemon／鎖安全 20/20。新增 5 項測試分別涵蓋 mktemp、mkfifo、holder 失敗、非法 timeout、連續成功切換；Python 與 Rust 路徑皆通過。

故障測試設定等待上限 1 秒，逐次確認總耗時小於 5 秒、沒有建立 current 或 live credentials、暫存目錄清空。這是故障路徑處理上限，不是生產 MTTR。正常切換測試連續切換 a→b→a，确认狀態與清理結果。

效能：本階段未重跑延遲／RSS benchmark；不能沿用上一份 artifact 的數值當作本階段測量。先前結果保留在 [階段性比較](rust-core-sre-comparison.md)，其中 SHA-256 識別先前 artifact。

## 剩餘風險

- read timeout 約束等待 ready，不是整個 callback 執行時間上限。
- SIGKILL 無法執行 Shell trap；父程序被強制終止時的孤兒 holder 回收尚待完善。holder 在 callback 進行中意外死亡也尚無監督取消機制。
- callback 使用子 Shell，現有唯一 caller 的副作用是檔案寫入；新增 caller 若依賴父 Shell 變數更新，必須重新檢查。
- OAuth refresh 多路徑仍未统一持鎖；不宣稱已解決 single-use token race。
- Windows/Linux 新 artifact、正式 uptime、MTBF、部署頻率、長時間 soak 均未測量。

下一階段：Rust HTTP 基礎與版本查詢；另產獨立報告，不覆寫本階段證據。
