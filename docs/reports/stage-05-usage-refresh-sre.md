# 階段 05 SRE：usage、status、refresh-all

日期：2026-09-08。基線：2.9.0；候選：同步 2.9.2 `81121a7` 的未提交工作樹。三個原始程式已接到 `usage.rs`、`oauth.rs`、`http.rs`。尚未正式發布。

## 可靠性變化

| 面向 | 原始 Python 路徑 | Rust 路徑 |
|---|---|---|
| refresh | 各程式複製實作，refresh 請求前未統一持鎖 | 共用 credential.lock，鎖內重新讀取 access/refresh token，偵測其他程序已輪替 |
| 憑證寫入 | 直接覆寫 | 私有暫存檔、fsync、原子 rename；保留未知欄位 |
| usage cache | 多 worker／程序可能互相覆寫 | sidecar lock 下重讀與合併，各帳號不覆蓋他人更新 |
| HTTP | 各自實作 | 共用有逾時、1 MiB 上限、拒絕 redirect 的用戶端；保持原 URL |
| 表格並行 | 最多 6 workers | 最多 6 workers，分批收集並依既有順序輸出 |
| current 同步 | 無獨立同步鎖 | `sync-current` 與 refresh／switch 使用同一憑證鎖 |

## 實測證據

- quick/full、含 usage／no-usage、鎖徽章及 status 的 ANSI 輸出與 Python 在固定 fixture 下相同。
- 12 個帳號的 usage 更新後，快取保留全部 12 筆；隨後移除 HTTP fixture 仍可顯示快取。
- 10 個並行 status 程序讀取同一過期帳號：fixture request log 顯示只有 1 次 token 請求，最後保留 rotated refresh token。這是合成結果，不是正式 OAuth 成功率。
- 無效 access_token、refresh_token、expires_in 或缺欄位回應不截斷原檔；expires_in=0 保留零秒語意，未知欄位不遺失。
- 在 PATH 中沒有 Python 的隔離環境，version/list/switch/status/lock/warmup/daemon deployment 通過。

完整驗證結果見 [階段 07](stage-07-daemon-sre.md)。沒有為這三個網路操作量測真實服務延遲；不得套用 helper benchmark 的加速倍數。

## 限制

預設發布路徑仍為 Python，新的鎖保障只涵蓋 Rust 寫入者與既有 switch 鎖；舊 Python refresh/cache writers 不全面參與，混合程序不可宣稱安全。憑證 lock 等待最多 30 秒；cache lock 尚無等待上限。refresh-all 保留原本逐帳號警告與總退出碼 0 的行為，不可只以退出碼統計刷新成功率。

測試 transport 僅在 `test-fixtures` feature 編譯，release 未啟用。真實 token、企業 proxy、原生 Keychain、TLS／DNS 及 Windows/Linux 新 artifact 尚未驗證。macOS 仍透過 `security` CLI 更新 Keychain，token 可能出現在該子程序 argv；原生 Keychain API 遷移尚未完成，不宣稱已排除該暴露面。

Status 的網路錯誤訊息改成固定診斷，不再印出例外內容。失敗的詳細字串不是逐 byte 相容。超出正常利用率範圍的長條圖有配置上限，避免惡意數值造成過量配置。
