# 遠端安裝驗收

日期：2026-09-06。驗收對象為尚未發布的 2.9.0 候選套件，不是 npm registry 現有版本。

## 結論

`cf-windows` 原生 Windows 安裝與啟動驗收通過；2026-09-08 重試後，`ds-home` Linux x64 安裝與啟動也通過。
這是兩台指定環境的隔離驗收，不是全平台或正式服務保證。Rust core 與第二階段 SRE 比較尚未完成。

## cf-windows：通過

- 透過既有 SSH 別名登入，使用 `ssh-justin` 帳號。
- Windows x64、Node 24.6.0、Windows PowerShell 5.1.26100.9168。
- 上傳本機打包的相同 npm tarball，遠端核對 SHA-256 後執行 `scripts/verify-package.cjs --tarball dist/dst-justin-relay-2.9.0.tgz`，退出碼 0。
- 真實 npm 離線安裝、postinstall、安裝後 `version` 與 `help` 通過。
- 預先確認 PowerShell `$HOME` 確實被隔離到測試目錄，再執行套件。
- 已安裝的 PowerShell 腳本通過 3 個 refresh 案例：`expires_in` 缺值、0、120。驗證新 token 寫入、既有額外欄位保留，以及有效期限計算。

Refresh 使用假憑證與替代 HTTP transport；沒有登入外部服務、使用真實 token，亦不代表真實 OAuth 端點可用。未變更正式全域安裝、使用者憑證或服務設定。

### 實測發現及修正

1. `relay.ps1` 原本 UTF-8 無 BOM，Windows PowerShell 5.1 以 ANSI 解讀非 ASCII 內容而解析失敗。加入 UTF-8 BOM。
2. 原本使用 PowerShell 7 才支援的 `??`，但 launcher 呼叫 Windows PowerShell 5.1。改用明確 null 判斷，並保留 `expires_in = 0` 的語意。

修正後重新打包並重跑遠端安裝驗收，全部通過。編碼依據：[PowerShell 官方文件](https://github.com/microsoftdocs/powershell-docs/blob/main/reference/7.7/Microsoft.PowerShell.Core/About/about_Character_Encoding.md)。

遠端保留測試來源與套件於 `C:\Users\ssh-justin\AppData\Local\Temp\relay-validation-d4aa4d41152549889f8fc0dbc4e3d052`，便於重現；驗證器建立的隔離安裝與假憑證目錄已清除。

## ds-home：2026-09-08 重試通過

- 既有 SSH 別名恢復可用，登入 `ds`，主機 `DESKTOP-BQ8SQUF`，Linux x64。
- 使用既有 NVM Node 24.16.0（非互動 SSH 的預設 PATH 未包含 Node），沒有額外安裝系統工具。
- Python 3.14.4、Bash 5.3.9。
- 核對與 Windows 相同的候選 tarball SHA-256，`build.cjs --check` 通過。
- 真實 npm 離線隔離安裝、postinstall、安裝後 version/help 與執行權限檢查通過。
- `node --test tests/build.test.cjs tests/cli.test.cjs tests/daemon.test.cjs`：22 通過、0 失敗、0 跳過。
- 使用臨時 HOME 與假憑證／服務替身，未變更正式安裝或使用者憑證。此次未在 ds-home 重跑需要歷史 Git 物件的 update suite，也未驗證真實 systemd／OAuth 整合。
- 測試來源、套件及 `test-results.log` 保留於 `/tmp/relay-validation-Z2VZcEhm`；驗證器的臨時安裝目錄已自動清理。

SSH 出現缺少 `zh_TW.UTF-8` locale 的警告；解包出現忽略 macOS 擴充屬性的警告，均未造成驗證失敗。

### 2026-09-06 連線阻擋紀錄（已解除）

依既有 SSH 設定使用 Tailscale DNS 名稱、連接埠 2222 與原有金鑰，結果如下：

| 嘗試 | 結果 |
| --- | --- |
| 既有 `ds-home` SSH 別名 | DNS 無法解析 |
| 使用既有快取 Tailscale IP 及相同連接埠 | TCP 連線逾時 |
| 經 `cf-windows` SSH jump host 連線 | SSH banner exchange 逾時 |

本機 Tailscale 狀態為 `Stopped`；快取 peer 資料不是主機目前在線的證明。未擅自啟動 VPN 或更改 SSH／網路設定。需要啟用 Tailscale 或提供目前可達的 IP／連接埠後才能繼續。

## 產物與本機回歸

macOS 與 cf-windows 使用的同一份 `dst-justin-relay-2.9.0.tgz` SHA-256：

```text
05df0ba034e6f852fc74f3b60de7e13563548066ce957153a6284c6a46aaf9f6
```

Windows 修正後，本機 macOS arm64／Node 22.20.0 回歸：`npm test` 38 通過、0 失敗；`npm run build:check`、相同 tarball 的 `test:package` 及 `git diff --check` 均通過。

此紀錄不涵蓋遠端 CI、Node 16、真實服務管理器整合或長時間可靠性。本次驗收沒有提交、推送、升版或發布；一般使用者更新仍不會取得此候選包。
