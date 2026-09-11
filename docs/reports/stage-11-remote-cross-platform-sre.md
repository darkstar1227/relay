# Stage 11：遠端跨平台驗收

日期：2026-09-08 環境確認，2026-09-09 授權後驗收。版本：2.9.2；基準 HEAD：`81121a7c45942fe053a83c862c696bfb3ff9fdd5`，測試目標包含未提交的 Rust migration 工作樹。

結論：两台同一份 npm 套件隔離安裝通過；Linux Rust core 回歸與原生打包通過。Windows 公開 CLI 仍為 PowerShell，Rust 只驗證 native debug 編譯與協定／metadata 查詢，不能宣稱全平台 CLI 已 Rust 化或可全面發布。

## 已實測

| 目標 | 連線結果 | 原生環境 |
| --- | --- | --- |
| cf-windows 區網 `192.168.37.161:22` | SSH 逾時，exit 255 | 未經此路徑取得 |
| cf-windows-tailscale | SSH 成功，exit 0 | LAPTOP-5KP19K2P；ssh-justin；Node 24.6.0；Cargo 1.98.0 |
| ds-home | SSH 成功，exit 0 | DESKTOP-BQ8SQUF；Linux x86_64；Node 24.16.0；Cargo / rustc 1.93.1；Python 3.14.4；`cc` 可用，`cmake` 不在 PATH |

本機 `scripts/verify-package.cjs --pack-dir dist/remote-stage-11` 成功：2.9.2 tarball 已在 macOS arm64 / Node 22.20.0 的隔離 prefix 安裝並通過既有 smoke checks。

| 驗收 | Linux | Windows |
| --- | --- | --- |
| 拆檔組合 build check | 通過 | 通過 |
| 同一份 npm tarball 隔離安裝、postinstall、version、help | 通過 | 通過 |
| 基礎回歸（不含 update） | 30/30 | 未執行 POSIX suite |
| PowerShell expiry refresh fixtures | 不適用 | 3/3，PowerShell 5.1.26100.9168 |
| Rust unit | 8/8 | 未執行 |
| Rust core integration 首次 | 37/38 | 未執行 |
| Rust core integration 修正測試後 | 38/38 | 未執行 |
| POSIX adapter／legacy daemon oracle | 20/20 | 不適用 |
| Rust 原生建置 | release 通過 | debug 通過，MSVC linker 資訊 warning |
| 原生 core package 安裝、size/hash 毀損檢查 | 通過 | 未提供 Windows package |

分母不能直接相加為獨立功能數；POSIX 20 項包含 4 項 Python daemon oracle。Windows 原生二進位回報 `relay-core 1 2.9.2`，target 為 `x86_64-pc-windows-msvc`、profile=debug、test_fixtures=false。

## 初次失敗與修正

Linux 並行 Codex picker 測試首次失敗：預期每個模型 10 次，其中一個讀到 0 次。測試在子程序 `exit` 時就結算 stdout，程序退出不保證 pipe 已讀完。僅將測試改為等待 `close`，Rust runtime 未變更，完整重跑達 38/38，unit 8/8、POSIX adapter 20/20。並行案例追加 10 輪全部通過，每輪 30 個程序，總計 300 次 picker invocation。保留首次失敗，不能記為首次全綠。

## Artifact 證據

- 封存檔 SHA256：`522a70672e7a074ef99d6124db701365efca0e5fa2a0d0a171fb80ea472a3a2e`；兩台遠端均與本機一致。
- 主套件 `dst-justin-relay-2.9.2.tgz` SHA256：`4ec59834021a2159401b53c9f8dd53c8c1afd7128edc7f86dc709281d7156574`。本機與 Linux 直接驗證；Windows 由相同封存檔取得。
- Linux core tarball：`dst-justin-relay-core-linux-x64-2.9.2.tgz`，SHA256 `38cc12f8c5292c829db8429e8b2641c73276726f36bcbe7d779b8283721a56a5`。
- Linux core binary 5,859,424 bytes；tarball 2,503,778 bytes；原生 release 建置約 50.3 秒（單次觀測，不是 runtime latency）。
- 首次 payload 後另傳修正的 integration test；runtime 和主 tarball 沒有改動。

## 授權與安全邊界

第一次 SCP 傳送遭安全審核拒絕；使用者於 9 月 9 日明確同意後才傳送並執行。沒有繞過拒絕。

封存白名單：`package.json`、`Cargo.toml`、`Cargo.lock`、`crates/`、`src/`、`scripts/`、`tests/`、公開 launcher、`postinstall.js`、`README.md`、此次 npm tarball。沒有包含 `.git`、`.ssh`、使用者憑證或整個工作目錄。

全部使用隔離 HOME、prefix 及合成憑證，沒有修改正式安裝、真實帳號憑證或既有服務。Cargo 依 lockfile 下載建置依賴。未 commit、push 或 publish。

遠端證據與產物暫留：

- Linux：`/tmp/relay-stage-11-eg7IIrrw`。`acceptance-results.json` 保留首次結果，`rust-core-retest.log` 為完整重測，`cursor-repeat-1.log` 至 `cursor-repeat-10.log` 為追加驗證。
- Windows：`C:\Users\ssh-justin\AppData\Local\Temp\relay-stage-11-b389e47d05d942e6a0f8243ed0c84b9b`，結果於 `acceptance-results.json`。

## 未驗證與發布限制

- 遠端 update suite 16 項需要未傳送的 Git history，未執行。
- Windows 未執行完整 Rust core operations suite、POSIX daemon/FIFO 功能或 release package 驗證。
- Linux ARM64、macOS x64 無此次 native 證據；MSRV 1.89 未驗證。
- 主套件精確版本自動配對、預設 Rust 啟用、正式服務遷移／回滾尚未完成。
- cf-windows 使用 Tailscale 備援，不代表區網路由恢復。Linux locale 與 macOS provenance tar header 警告未阻止測試。

本次沒有執行新舊版配對效能基準；p50/p95、CPU/RSS 改善幅度、長時間穩定性、真實 OAuth 成功率及 SLA 均為 **UNKNOWN**。不能以跨主機建置時間或測試通過率代替正式服務可靠性。本階段不是全面發布 GO。
