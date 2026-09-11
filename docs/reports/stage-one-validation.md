# 第一階段驗收：分檔與單檔組裝

日期：2026-09-06。範圍僅為已確認計劃的第一階段；Rust core 尚未實作。

**此文件記錄初次分檔驗證。** 使用者後續要求由代理驗收並確認更新可用，追加
測試發現原版更新缺陷並完成修正。最新結果見
[更新驗收報告](update-acceptance.md)；下方 22 項測試、逐位元一致性及候選產物
hash 僅適用於初次分檔版本，不是修正後候選版的現況。

## 結果

已將 POSIX 原始碼分為 15 個 Shell 模組、35 個 Python 來源檔，透過明確的
manifest 順序組裝為根目錄 `relay`。38 個 Python 嵌入位置保留原有的引號、
stdin 與參數語意；相同的 access-token 程式共用來源。

對照發布版 `v2.9.0`（包含 `relay proxy`）的提交
`b40c791cab7ece474119071db8f15f840453dab0`，移除一行生成註解後，組裝產物與
原始腳本逐位元一致。未變更功能行為、資料格式或 Python 執行依賴。

| 項目 | 本機結果 |
| --- | --- |
| `npm run build:check` | 通過，生成產物與來源同步 |
| Bash 語法 | 通過，本機 `/bin/bash` 為 3.2.57 |
| Python 原始碼語法 | 35 個檔案全部可解析 |
| `npm test` | 22 項，22 通過、0 失敗 |
| 發布版行為測試 | 15 項，15 通過、0 失敗 |
| 分檔版同組行為測試 | 15 項，15 通過、0 失敗 |
| npm 打包與隔離安裝 | 通過，含真實 postinstall 與安裝後 version/help |
| 同一 tarball 重驗 | 通過，沒有重新打包 |
| Workflow YAML 解析 | 通過；不等同 GitHub Actions 實際執行 |
| `git diff --check` | 通過 |

本機環境：macOS arm64、Node 22.20.0。CLI 測試使用臨時資料與受控服務替身，
包括 Linux 憑證檔案 adapter；不代表真實 macOS Keychain 已完成驗證。

## 可重現證據

```sh
npm run build:check
npm test
node scripts/compare-baseline.cjs
npm run test:package -- --pack-dir dist
npm run test:package -- --tarball dist/dst-justin-relay-2.9.0.tgz
git diff --check
```

`compare-baseline.cjs` 會從固定 Git 提交擷取舊版至臨時目錄，檢查逐位元一致性，
再對舊版及候選版執行相同測試。它不會更換目前分支或修改使用者帳號資料。

| 產物 | SHA-256 |
| --- | --- |
| 原版 `relay` | `5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d` |
| 分檔版 `relay`（含生成註解） | `32dd8803aa9faa0733b4800f9a35ca9260ea2a7dc5787114ada04970df218bd1` |
| 本次驗證 tarball | `55328a7b698e5468e58fd2e7c7114cbde092de10ba6e60ec86f968b1318debba` |

本次 tarball 位於 `dist/dst-justin-relay-2.9.0.tgz`，僅供本機驗收，未發布。
它仍使用原有版本號，不可將它視為 registry 上現有 `2.9.0` 的相同產物；
未來正式發布仍需另行升版。此處 hash 記錄本次產物，不承諾不同 npm 版本的
壓縮包位元組一致；單檔腳本的可重現組裝另由 `build:check` 檢查。

## 已配置但未執行的遠端驗證

PR／main workflow 驗證 Linux、macOS 原始碼與行為，產生單一 npm tarball，
再以 Linux／macOS／Windows、Node 16／24 驗證同一安裝包。Tag workflow 等待
全部驗證完成、核對版本，最後發布該產物。尚未推送、建立 tag 或觸發 CI。

Windows／Linux 原生執行、Node 16／24 實際結果，以及真實服務管理器與
Keychain 整合目前均未實測。本機 YAML 解析不能替代上述檢查。

## 後續

使用者已將第一階段驗收交由代理執行；追加更新驗收結果記錄於上述新報告。
第二階段將完成按平台 npm 核心配送、舊版更新銜接與 daemon 遷移。

兩階段完成後，另輸出 `docs/reports/sre-v2.9.0-vs-rust-core.md`，包含舊新版
效能、資源、並發一致性、故障恢復、可觀測性及發布／回滾的 SRE 比較。
量測方法已記錄於 `docs/plans/2026-09-06-modular-rust-migration.md`。本文件是
第一階段驗收紀錄，沒有提前宣稱 Rust 效能提升或 production SLA/SLO。
