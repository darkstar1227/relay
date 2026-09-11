# Relay：原版與 Rust core 驗收／SRE 總結

整理日期：2026-09-10。範圍：拆檔後的 2.9.2 工作樹、Rust core、自動化跨平台驗收及 ds-home 真實 OAuth／systemd 驗證。全平台公開 CLI 的 Rust 重寫不在本輪範圍。

## 結論

本輪新增的 core 隔離測試、Linux 更新回歸，以及獲授權的 ds-home 真實測試已執行完畢。真實測試 **11/11 通過**；原設定逐位元恢復、原 Python daemon 恢復 active／enabled，輪替後的新 OAuth 憑證保留且再次查詢成功。

這是 **core 受測範圍的驗收結果，不是整體 migration 或正式發布全部完成的宣告**。目前仍為 `RELAY_CORE_BIN` opt-in，主套件尚未預設改用 Rust。成對安裝／更新、自動服務遷移回滾與完整發布平台矩陣的剩餘工作列於文末，不以手動測試恢復冒充已實作正式 rollout。

## 1. 版本與證據邊界

- 原版：v2.9.0，commit `b40c791cab7ece474119071db8f15f840453dab0`。
- 候選：v2.9.2，HEAD `81121a7c45942fe053a83c862c696bfb3ff9fdd5` 加未提交 migration 工作樹；沒有建立新版本、commit、push 或 publish。
- 自動化／效能資料：2026-09-09；真實 ds-home 驗收：2026-09-10 09:30:40–09:30:43 UTC（台北 17:30）。
- 原版單檔 SHA256：`5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d`。
- 效能候選 shell SHA256：`a09507a7c28fd43c73eefc2d324896ef16fa431c03828c83095a6d9c15ba53d3`。
- 效能候選 macOS core SHA256：`fdd71b059281daef891a4e9b93d4e94badd73fbfb2ad3c303999d87713491305`。
- 真實驗收 Linux core SHA256：`16463580fdce871a0592dceee5e541e386ec2470cc644440438c0d9e2e4c62d0`，5,859,424 bytes。
- 重新傳送的 source tar SHA256：`a5ce9f19c72a5120514b6b9f686475da6fab6b59273b97c2d78789c076f5b8e2`，115 個白名單項目，未包含真實憑證、`.ssh` 或 `.git`。

2026-09-10 原遠端暫存目錄已消失，因此重新建置 Linux release core 後才執行真實測試；沒有把舊目錄的存在或舊測試推定為當日結果。

## 2. 自動化與跨平台驗收

| 檢查 | macOS arm64 | ds-home Linux x64 | cf-windows Windows x64 |
| --- | --- | --- | --- |
| 基礎／更新 suite | 46/46 | 46/46，包含原先未跑的 16 項 update | POSIX suite 不適用 |
| Rust unit／loopback HTTP | 12/12 | 12/12 | 12/12 |
| 既有 core integration 加 daemon 恢復 | 40/40 | 40/40 | 不執行 POSIX／Python oracle suite |
| Portable suite | 10 通過、1 Windows-only 略過 | 10 通過、1 Windows-only 略過 | 11/11 |
| 新 OAuth fixture suite | 5/5 | 5/5 | 5/5 |
| POSIX public adapter／legacy oracle | 20/20 | 20/20 | 不適用 |
| 原生 release 建置 | 通過 | 通過 | 通過 |
| Release portable | 受測 production binary 通過 | 10 通過、1 略過 | 11/11 |
| 兩條公開版本查詢 | unit 控制端點證據 | 實際網路查詢通過 | 實際網路查詢通過 |
| Core 套件離線安裝／毀損拒絕 | 通過 | 通過 | 未提供 Windows core package |
| 主 npm 套件安裝 | 通過 | 階段 11 通過 | 階段 11 通過，PowerShell refresh 3/3 |

測試群組、操作數及重複執行不能相加為獨立功能分母。20 項 POSIX suite 中包含 4 項 Python daemon oracle，不全部代表 Rust daemon 測試。

Portable suite 驗證 31 個業務/helper operation 及 2 個 metadata 入口；新 OAuth suite 補 `sync-current`、`render-table`、`status-once`、`refresh-all`；另實測 `latest-version`、`check-update-bg`。Windows 的 `daemon`、`download-update`、`credential-lock` 屬 POSIX 契約，驗證的是明確拒絕，不宣稱 Windows automation 功能相容。既有 POSIX integration 驗證這三項的適用情境。

### 本輪補齊的案例

- 真實 loopback HTTP：form encoding、Bearer/header、body size 上限、malformed JSON、302 不跟隨、401／429／503、request timeout。
- 合成 OAuth：輪替後寫回目前帳號 live store、未知欄位保留、回應型別／expiry 溢位拒絕、失敗不破壞原檔。
- Usage：401 最多一次 refresh retry、120 秒快取命中不打網路、失敗不污染快取、12 帳號並行合併。
- 並行狀態查詢：10 程序對同一過期憑證，僅一次 token refresh。
- Daemon：SIGTERM 中止預熱子程序並恢復原帳號；SIGKILL 遺留 PID 後可重新取得 singleton ownership。
- Linux 更新：傳送已核對 SHA256 的 v2.9.0 單檔 fixture，補跑全部 16 項更新案例，不需傳送 Git 歷史。
- Windows release binary：portable 操作與 POSIX-only fail-closed 契約。

首次 Linux 並行 picker 測試曾因使用 Node `exit` 而未收完 stdout 失敗。改為 `close` 後完整重測成功；歷史失敗保留於[階段 11](stage-11-remote-cross-platform-sre.md)，沒有刪除或美化首次結果。

## 3. ds-home 真實驗收

使用者明確授權使用 `personal`、向官方 OAuth 送 refresh token、輪替憑證及暫停／恢復 daemon 後執行。主機 DESKTOP-BQ8SQUF，Linux x64，Node 24.16.0，Cargo/rustc 1.93.1。

測試前原 Python daemon 為 active／enabled。`personal` 有 access／refresh token；`work` 為原選取帳號，但 token 為空，屬既有狀態，本輪未替它登入或改寫。

| 檢查 | 結果 | 證據 |
| --- | --- | --- |
| 備份與暫停原服務 | 通過 | 私有備份後停止原 unit |
| 真實 OAuth refresh | 通過 | 561 ms；access 與 refresh token 均輪替、expiry 在未來、未知欄位保留 |
| 真實 usage | 通過 | 617 ms；有正常 5hr usage，非 expired/error 輸出 |
| systemd 啟動 Rust daemon | 通過 | active，MainPID 與 credential state PID 一致 |
| Singleton | 通過 | 第二個 daemon 被拒絕 |
| Graceful stop | 通過 | 20 ms，PID 檔清除 |
| 無效候選 | 通過 | 不存在的 executable 被 systemd exec-type unit 拒絕 |
| 原 current／live store | 通過 | 測試前後 hash 相同 |
| Daemon 後憑證可用性 | 通過 | 再次真實 usage 成功 |
| 測試服務停止 | 通過 | transient unit 已停止／回收；重複 stop exit 5 為 unit 已不存在，不視為仍在運行 |
| 原設定與服務恢復 | 通過 | 原 config bytes 相同、unit 未改寫、active／enabled |

另開 SSH 連線獨立確認：原服務 `active/running`、`Result=success`，PID 653422；config 與備份逐位元相同；備份目錄 0700、personal snapshot 0600。

測試服務有 RuntimeMaxSec=90、TimeoutStopSec=35、control-group kill boundary。Rust 候選服務測試期間關閉排程 warmup 與帳號切換，**沒有由測試腳本或 Rust 候選服務發出真實 Claude ping／付費模型請求**，因此不宣稱真實預熱功能已端到端驗收。原 Python 服務恢復後照原排程運作，其後活動不算本次隔離觀測。Singleton／startup refresh 使用真實 service 與帳號。整段測試約 3.3 秒，不是長時間 soak。

沒有將舊 token 還原；refresh 輪替後的舊 token 可能失效，保留新憑證才是正確復原。歷史 log 由 366 行增至 374 行，這次未觸發 Rust 的長 log 裁切。

## 4. 覆蓋率

使用與 Rust 相同 LLVM 22.1.8 的工具、獨立 instrumented target 目錄及所有測試 subprocess 的 profile 檔案收集。僅統計 `crates/relay-core/src/`：

**1,904／2,107 行，90.37%。**

這個分母包含 unit-test／test-fixture 編譯路徑；不是 production-only 覆蓋率，也不是 100% 完整情境保證。未執行路徑包含部分平台 adapter 與錯誤分支。這份 stable instrumentation 沒有可用的 branch denominator，因此分支覆蓋率為 **UNKNOWN**，不能用行覆蓋率代替。

流程依 [Rust 官方 instrument-coverage 文件](https://github.com/rust-lang/rust/blob/main/src/doc/rustc/src/instrument-coverage.md) 核對；初次在受限 sandbox 的 loopback bind 被拒絕後，才於獲准環境重跑。受限環境失敗不是產品 HTTP 失敗。

重跑：`node scripts/coverage-core.cjs`。需要對應 LLVM 工具及本機 loopback 權限；輸出原始資料而非自動宣稱驗收完成。

## 5. 原版／現版 SRE 數據

本機 Apple M4、macOS Darwin 27.0.0、Node 22.20.0、Python 3.14.5、Rust 1.96.1。每組 5 次預熱、30 次量測，交錯原版、modular Python、modular Rust；逐次確認退出碼與 stdout。共 180 個量測樣本，失敗 0/180。

| 工作負載 | 版本 | n | p50 ms | p95 ms | RSS p50 MiB | CPU p50 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| provider-field helper | 原版 Python | 30 | 43.36 | 59.45 | 23.78 | 30 |
| provider-field helper | 拆檔 Python | 30 | 45.67 | 57.25 | 23.88 | 30 |
| provider-field helper | Rust | 30 | 5.80 | 6.69 | 5.98 | 0 |
| `relay lock` 完整 CLI | 原版 2.9.0 | 30 | 83.21 | 181.69 | 39.00 | 70 |
| `relay lock` 完整 CLI | 拆檔 Python | 30 | 92.35 | 176.65 | 39.00 | 70 |
| `relay lock` 完整 CLI | Rust core | 30 | 48.35 | 135.54 | 38.98 | 30 |

- Rust helper 相對原版 p50 降低 **86.6%**。
- Rust core 的 `relay lock` 完整路徑 p50 降低 **41.9%**；完整 CLI 的 RSS 幾乎沒有改善，不能用 helper 的 RSS 改善外推整個 CLI。
- 原版及拆檔 helper 都執行相同 Python helper；完整 CLI 才執行 Git 原版單檔，因此兩種工作負載的 baseline 定義不同。
- wall 包含 Node spawn、`time -l`、隔離 fixture／shim 開銷。RSS 不是程序樹同時峰值；CPU 輸出精度為 10 ms，0 不代表零耗用。
- 這不是 Windows/Linux 效能比較、daemon CPU/RSS soak、真實 list/status latency 或 OAuth 新舊對照；不能宣稱所有命令都加速 41.9%。真實 refresh／usage 各僅一次觀測，不具 p95 意義。

原始樣本：[stage-13-rust-core-benchmark.json](stage-13-rust-core-benchmark.json)。重跑：`cargo build --release --locked` 後 `node scripts/benchmark-core.cjs stage-13 --raw-only`。

## 6. 恢復、可觀測性與操作負擔

| 面向 | 已有證據 | 仍有限制 |
| --- | --- | --- |
| 一致性 | credential lock、並行 refresh／cursor、原子 JSON、欄位保留、同帳號不回退 live token | 不是所有程序崩潰時點／filesystem fault 都有覆蓋 |
| 失敗恢復 | HTTP 拒絕／timeout、下載內容驗證、size/hash 拒絕、SIGTERM/SIGKILL、真實服務恢復 | 無完整 power-loss／長時間 soak，未實作完自動配對 rollout |
| 可觀測性 | 泛化診斷不印 token；本次結果逐項布林與耗時；原始失敗保留 | `refresh-all` 個別失敗仍可能 exit 0，必須看每帳號結果；不能只用程序 exit 作 OAuth 成功率 |
| 依賴 | opt-in core 測試可阻擋 Python 執行；release 包不帶 test-fixtures | Bash／Node／平台工具仍存在，主套件目前仍 Python-default |
| CI | portable、OAuth、Windows release tests 已配置 | 未推送／觸發遠端 GitHub CI，不算 CI 已綠 |
| 運營 SLI | 此次真實單次成功與恢復證據 | uptime、SLA、MTTR、MTBF、部署頻率、長期錯誤率均 UNKNOWN |

## 7. 發布閘門與未驗證範圍

本輪 ds-home 授權不能替代其他平台或正式發布授權。以下未完成或未驗證，不能隱去：

1. 主套件精確版本 optional core 自動配對、手動 bootstrap／成對更新切換與正式自動回滾仍未完成；主套件保持 Python-default。
2. 本次用測試腳本暫停／恢復真實服務，證明受測服務與復原步驟可用，**不等於正式 updater 已具備自動 service migration rollback**。
3. macOS 真實 Keychain adapter 未動用使用者憑證驗證；ds-home 是 Linux，沒有 Keychain。Windows OAuth 使用合成 fixture，不是 Windows 真實帳號。
4. macOS x64、Linux arm64、musl 與 MSRV 1.89 無本輪原生證據；現有驗證的 Linux core 是 glibc x64。
5. 全平台 Rust 公開 CLI、正式 registry／Release assets 發布及長時間服務驗證仍在後續範圍。

## 8. 證據與復原資料位置

- 本機脫敏資料：[Linux](../../dist/core-acceptance/linux-results.json)、[Windows](../../dist/core-acceptance/windows-results.json)、[coverage](../../dist/core-acceptance/coverage-summary.json)、[ds-home 真實結果](../../dist/core-acceptance/live-dshome-results.json)。`dist/` 為本機產物，不是已發布或已提交證據。
- 覆蓋率完整原始 profile／export：`target/core-coverage-edhD4y/`。
- ds-home 新測試目錄：`/tmp/relay-stage-11-live-W8ZAqCwA`，`live-results.json`、`build.log` 及原生 binary 保留。
- ds-home 私有備份：`/tmp/relay-live-backup-UqxmHa`，0700 目錄／0600 檔案；**含舊憑證，未下載回本機，不可將舊 token 當成可安全還原的憑證**。暫存目錄可能被系統清除；本次 config 已恢復，不依賴備份維持正常運作。
- Live runner：`scripts/live-dshome-acceptance.cjs`，有主機／home／明確參數 guard，不納入自動 CI；再執行會操作真實 OAuth 與服務，須保有相應授權。

歷史階段報告繼續保留原始時間、分母與未完成狀態；本報告集中補上後續證據，不覆寫舊 artifact 的測量數字。
