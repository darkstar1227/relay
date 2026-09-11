# 第一階段追加驗收：更新路徑

日期：2026-09-06。使用者要求由代理驗收，確認更新可用。

追加結果：後續已完成 cf-windows 原生安裝驗收並修正 PowerShell 5.1 相容性；
最新套件雜湊與 ds-home 連線限制見[遠端安裝驗收](remote-install-validation.md)。
下列 tarball 雜湊為 Windows 修正前的歷史產物。

## 結論

**本機隔離環境的 POSIX 更新驗收通過。** 共 38 項測試通過，其中 16 項針對更新。
已測試發布版 `v2.9.0` 的舊更新器下載本次候選腳本，更新後可啟動；也測試候選
更新器的下載成功與失敗路徑、真實 npm 的隔離升級、真實 Git worktree 的本地
fast-forward 更新，以及 daemon 部署成功／重啟失敗的處理。

此結論不代表新版已對外發布。目前 `package.json` 仍為 `2.9.0`，候選改動未提交、
未推送、未升版、未發布。一般使用者執行 `relay update` 尚不會取得這份候選版。

## 驗收發現與修正

| 發現 | 修正 |
| --- | --- |
| 原版下載、npm 或 Git 更新失敗可能仍退出 0，甚至顯示 Updated | 傳遞失敗狀態，不再報成功；npm 檢查實際安裝版本 |
| 單檔安裝沒有 package.json 時版本為 unknown，daemon 不會依版本重新部署 | 建置時從 package.json 嵌入版本，單檔可獨立辨識版本 |
| 相對 symlink 以呼叫者目錄解析，可能誤判安裝來源 | 逐層以 symlink 所在目錄解析，支援 macOS readlink |
| package 路徑插入 Python 原始碼，含單引號時讀取失敗 | 改為 argv 傳入，不做程式碼字串插值 |
| Git worktree 的 .git 是檔案，會被誤判為 npm | 支援 .git 檔案，pull 使用 --ff-only |
| 下载任意成功回應後直接覆蓋可執行檔 | 檢查 Bash shebang、語法及存在時的嵌入版本，再原子替換；失敗保留舊檔並清理暫存 |
| daemon 重啟失敗仍寫入新版本並報已重啟 | 保留備份，失敗恢復舊 daemon 與版本標記並顯示錯誤；不宣稱健康 |

這些是追加驗收修正，超出最初的純分檔變更。因此初次驗收文件中的逐位元一致性
只適用於最初分檔產物；現在的候選版本含上述有意的行為修正。

## 測試方式與結果

本機：macOS arm64、Node 22.20.0、Bash 3.2.57。測試建立臨時 HOME、憑證與安裝目錄，
不修改真實 Relay 安裝、Keychain、排程或帳號。

| 驗證 | 結果與邊界 |
| --- | --- |
| `npm run build:check` | 通過；35 份 Python 來源、15 份 Shell 模組與產物同步 |
| `npm test` | 38 通過、0 失敗；包含 Bash 語法及所有 Python 來源解析 |
| 舊更新器 → 本次產物 | 執行固定提交 b40c791 的原始更新器，以受控 HTTP 回應提供候選脚本，檔案替換後 version/help 通過 |
| 候選單檔更新 | 通過成功替換、相對 symlink 保留、0755 權限及更新後版本讀取 |
| 下載失敗 | HTTP 503、HTML 內容、Bash 語法錯誤、嵌入版本不符均拒絕替換並回傳失敗 |
| npm 更新 | 使用真實 npm 在臨時 global prefix 升級 0.0.1 測試包至 2.9.0 候選包；測試替身只將固定版本套件定位到本機 tarball，沒有公開 registry 發布 |
| npm 失敗 | 非零退出與退出成功但版本未安裝均被拒絕 |
| Git 更新 | 使用真實本地 bare remote 與 worktree 執行 fast-forward，驗證新 revision 檔案及版本 |
| 版本查詢 fallback | GitHub 回應失敗時使用受控 npm registry 回應 |
| daemon 更新 | 驗證輸出 daemon 原始碼、版本及 service restart 呼叫；服務管理器是替身，不是實際 OS 服務驗證 |
| daemon 重啟失敗 | 恢復舊部署與版本標記，顯示錯誤而非宣稱成功 |
| 原版／候選共同行為 | 舊版 15/15、候選 15/15 帳號與 daemon 行為測試通過 |
| 最終 npm tarball | 真實 postinstall、隔離安裝後 version/help 通過；同一 tarball 重驗通過 |
| `git diff --check` | 通過 |

## 重跑與產物

```sh
npm run build:check
npm test
node scripts/compare-baseline.cjs
npm run test:package -- --pack-dir dist
npm run test:package -- --tarball dist/dst-justin-relay-2.9.0.tgz
```

| 產物 | SHA-256 |
| --- | --- |
| 原版 relay | `5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d` |
| 修正後候選 relay | `d45eef65b96acae25e5423f85039c572f0739c3fd33f6b88ad8705a1f61d5ff4` |
| 本次候選 npm tarball | `9d2fb85c4b0f31045442a70b1f52469f3c7614f6b0872f60af9084768213a173` |

## 尚未驗證與後續

- 遠端 CI 尚未執行；Linux 原生結果、Node 16，以及真實
  launchd/systemd/cron/Keychain 整合不列為本機已通過項目。
- Windows／Node 24 原生安裝追加驗收已通過，範圍與限制見遠端安裝驗收文件。
- 受控 HTTP 測試驗證更新流程，不代表 GitHub/npm 公開下載、TLS 或網路環境實測。
- 下載驗證目前是內容與語法檢查，不是第二階段規劃的 binary checksum 配送流程。
- 第一階段本機驗收已由代理完成；Rust core 與兩階段完成後的 SRE Markdown 比較
  仍是後續工作。未因本機測試推論 production uptime、SLA/SLO 或效能提升。
