# 階段 06 SRE：Rust 下載更新

日期：2026-09-08。`download_update.py` 的對應實作為 `download.rs`，已接到 `download-update`。未發布。

| 驗收項目 | 結果 |
|---|---|
| HTML／錯誤頁 | 拒絕，原檔 bytes 不變 |
| Bash 語法錯誤 | 拒絕，原檔 bytes 不變 |
| embedded version 不符 | 拒絕，原檔 bytes 不變 |
| 正確腳本 | 替換成功，mode 0755，無剩餘 .relay-update 暫存檔 |
| release version 形狀 | 有效 release/prerelease/build 接受，路徑與空 suffix 拒絕 |

相較 Python 下載器，Rust 增加 8 MiB 回應上限、明確 HTTP status 檢查、不跟隨 redirect，並在 rename 前同步檔案、Unix rename 後同步父目錄。仍保留 shebang、Bash syntax、embedded-version 驗證與同目錄原子替換。下載 deadline 為 15 秒；沒有量測真實 CDN 下載 p95 或大檔吞吐。

這些 fixture 只驗證受控回應到落盤路徑，不是供應鏈簽章驗證。SIGKILL 仍可能留下私有暫存檔；rename 成功後 directory fsync 失敗，會明確回報「已替換但持久化未確認」，不能當成完全未更新。

**成對更新閘門仍關閉**：當前 Rust opt-in 執行 `relay update`，若 latest 與目前版本不同，會拒絕只更新腳本，避免下一次 script/core handshake 不符。原本 Python 更新路徑保留。Rust updater 的低階下載操作已移轉，不代表平台 binary 發布、成對下載、升級或回滾已驗收。

完整回歸與安裝證據見 [階段 07](stage-07-daemon-sre.md)；此階段沒有獨立下載效能百分比，不虛填 MTTR 或 SLA。
