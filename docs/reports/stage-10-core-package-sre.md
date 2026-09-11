# 階段 10 SRE：原生 Rust core 平台套件

日期：2026-09-08。版本：2.9.2，HEAD `81121a7` 的未提交工作樹。**macOS arm64 本機打包／離線安裝驗證通過，未正式發布。** 不變更主套件的預設 Python runtime、不更動真實服務。

## 本次產物

- 名稱：`@dst-justin/relay-core-darwin-arm64@2.9.2`
- [保留的 tarball](../../dist/core-stage-10/dst-justin-relay-core-darwin-arm64-2.9.2.tgz)（dist 為本機產物，不納入 git）
- tarball 大小：2,286,630 bytes；binary 大小：4,601,056 bytes。
- tarball SHA-256：`8ca77f99872d1521192ff0e861d9a267e8c19f21b49ee5ad5cad207fae91780a`
- 僅包含 `package.json`、`core-manifest.json`、`bin/relay-core`，沒有 lifecycle script 或安裝時編譯。

`scripts/core-package.cjs` 在一次性 staging 打包，離線安裝到含空白路徑的 prefix，驗證後才複製到指定輸出目錄。輸出若已存在會拒絕覆寫。測試中毀損的是一次性 installed copy，不是保留 tarball 或 release binary。

## 新增發布防護

`artifact-info` 回傳編譯時 version、protocol、Rust target、profile、test_fixtures。打包器拒絕版本／protocol 不符、目標架構或 libc 不符、非 release、fixture build。這是版本與建置錯配防護，不是對不可信 binary 的遠端認證。

manifest 保存 binary SHA-256 與大小，安裝後比對。故障注入分別增加 bytes 與原尺寸翻轉一個 byte，兩者均被拒絕。Checksum 可以偵測損壞，但 manifest 和 binary 一起被替換時沒有簽章保護，不能宣稱完整供應鏈驗證。

平台映射涵蓋 macOS arm64/x64 與 Linux glibc arm64/x64。本次只有 macOS arm64 原生量測；musl／Windows 套件不在此打包器的支援範圍。Linux/其他架構不因映射測試通過就視為已執行。

## 本次驗證結果

| 檢查 | 結果 |
|---|---|
| native core 打包、離線安裝、metadata/hash 比對 | 通過 |
| 安裝 core 的 CLI smoke | version、list --no-usage、lock 通過；Python shim 設為執行即失敗 |
| 實際 debug fixture binary 的 metadata | 被打包驗證器拒絕 |
| metadata 映射／拒絕條件 | 2 項新增 default tests 通過 |
| 預設回歸 | 46/46 通過 |
| Rust unit／core integration／CLI 與 legacy oracle | 8/8、38/38、20/20 通過；涵蓋重疊，不加總為唯一 coverage |
| 主套件 npm 隔離安裝 | 通過，仍是 Python default 套件 |
| build check／fmt check／Clippy warnings denied／release build／diff check | 通過 |

CLI smoke 使用「已安裝的 core binary + 工作樹的 Relay Shell」與隔離 synthetic HOME，不是兩個 npm 套件自動配對的 end-to-end 安裝。未查詢真實 OAuth、未啟動真實 daemon。沒有重新測效能或安裝耗時分布；套件 bytes 不是 RAM，用量與 SLA 不可由此推算。

## CI 與未完成項目

既有 reusable core CI 在 release build 後執行打包驗證，並上傳該 runner 的 native tarball；本次只修改設定，未在 GitHub 遠端執行。現有 publish 工作流仍只發布主套件，沒有自動發布這些 core 包。

下一步：所有必要 target 原生驗收、主套件 exact-version 相依與 core discovery、缺失／損壞套件錯誤路徑、平台包先於主套件的發布次序，再完成成對更新與 daemon 遷移 rollback。未發布的平台包現在不加入主套件相依，避免破壞既有安裝。正式發布閘門仍未全部完成。
