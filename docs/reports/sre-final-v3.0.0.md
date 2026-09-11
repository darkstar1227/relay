# Relay 3.0.0 最終 SRE 評估：Python 與 Rust core

日期：2026-09-11。發布程式碼：`e609cdcb0e550eccaf18ec061cfa74d677e0d7f7`，tag `v3.0.0`。

## 結論

**Rust core 在受測短命令中明顯降低延遲，但沒有證據顯示整個 CLI 的記憶體或長期可用性同步改善。** 本次以 3.0.0 重新量測，不沿用候選版性能數字：

- 對照同版、同樣拆檔的 Python 路徑，helper p50 降低 **87.2%**，完整 `relay lock` p50 降低 **43.5%**。
- 對照未移轉的 v2.9.0，完整 `relay lock` p50 降低 **42.7%**，p95 降低 **44.6%**。
- 180 個量測樣本全部成功；這是隔離測試成功率，不是生產可用率。
- Linux、macOS、Windows 的 GitHub CI 及六組主套件安裝矩陣全部通過。
- 可發布的範圍是「拆檔 CLI＋opt-in Rust core」。**不是 Python 已全面移除、全平台 CLI Rust 化或自動服務遷移完成。**

## 1. 比較設計與證據身分

| 組別 | 定義 | 用途 |
| --- | --- | --- |
| 原版 Python | v2.9.0，`b40c791cab7ece474119071db8f15f840453dab0` | 完整 CLI 的移轉前基準 |
| 3.0.0 Python | 新版組合產物，未選用 Rust core | 控制拆檔與其他版本變更，觀察 core 選擇的差異 |
| 3.0.0 Rust | 相同新版 CLI，以 `RELAY_CORE_BIN` 選用 release core | 移轉後受測路徑 |

Helper 的兩個 Python 組別執行相同 Python helper；只有完整 CLI 原版組別執行歷史 v2.9.0 單檔。不能把 helper 組別當成兩個不同歷史實作。

性能量測時間：2026-09-11 04:32:34 UTC（台北 12:32）。Apple M4、macOS Darwin 27.0.0、Node 22.20.0、Python 3.14.5、Rust 1.96.1；每組 5 次預熱、30 次量測，三種實作交錯執行，逐次檢查退出碼及 stdout。

原始逐次樣本與環境：[stage-14-rust-core-benchmark.json](stage-14-rust-core-benchmark.json)。檔名是量測工具的編號慣例，本文件為唯一新增的最終版 SRE 報告。

| Artifact | SHA256 |
| --- | --- |
| v2.9.0 shell | `5104e006112b8b2b48ecef7f07c1735b42385590dd18d50ccd3d6607ec2f050d` |
| 3.0.0 shell | `027dd601b7f0fa21176097fdcf9f92af3591e3e86924ba73aa2237f9835f9e81` |
| 本次 macOS release core | `5975f171fd579645b3aae87c52c39803f4b61e62a3767db50a2a2a8c2887cb92` |

Core 大小 4,601,056 bytes。這是本機受測 binary，不代表 CI 在其他主機建出的 binary 具有相同 hash。

## 2. 延遲與資源比較

### 完整延遲分位數

單位皆為 ms；每組 n＝30。使用與既有 benchmark 相同的 **nearest-rank**：將 wall time 遞增排序後，取第 `ceil(n × p)` 筆（1-based），不做線性插值。p10／p25／p50／p75／p95／p99 分別對應第 3／8／15／23／29／30 筆。

| 工作負載 | 實作 | p10 | p25 | p50 | p75 | p95 | p99 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| provider-field helper | 原版 Python 對照 | 38.185 | 38.673 | 39.192 | 39.899 | 40.552 | 40.725 |
| provider-field helper | 3.0.0 Python | 38.313 | 38.691 | 39.998 | 40.644 | 46.942 | 54.717 |
| provider-field helper | 3.0.0 Rust | 4.757 | 4.926 | 5.125 | 5.389 | 8.707 | 11.477 |
| `relay lock` 完整 CLI | v2.9.0 Python | 68.714 | 69.308 | 69.953 | 72.117 | 82.094 | 91.800 |
| `relay lock` 完整 CLI | 3.0.0 Python | 69.123 | 70.019 | 70.932 | 72.109 | 85.531 | 95.195 |
| `relay lock` 完整 CLI | 3.0.0 Rust | 39.133 | 39.569 | 40.061 | 40.854 | 45.493 | 65.681 |

**這批 n＝30 的 p99 就是該組最大觀測值**，對單次排程抖動敏感；僅描述本次樣本，不是可靠的母體 p99 估計、尾延遲保證或生產 SLO。未為了美化結果排除較慢樣本。

### 資源與成功率

| 工作負載 | 實作 | n | 失敗 | p50 ms | p95 ms | RSS p50 MiB | CPU p50 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| provider-field helper | 原版 Python 對照 | 30 | 0 | 39.192 | 40.552 | 23.61 | 20 |
| provider-field helper | 3.0.0 Python | 30 | 0 | 39.998 | 46.942 | 23.61 | 20 |
| provider-field helper | 3.0.0 Rust | 30 | 0 | 5.125 | 8.707 | 5.89 | 0 |
| `relay lock` 完整 CLI | v2.9.0 Python | 30 | 0 | 69.953 | 82.094 | 38.89 | 50 |
| `relay lock` 完整 CLI | 3.0.0 Python | 30 | 0 | 70.932 | 85.531 | 38.89 | 50 |
| `relay lock` 完整 CLI | 3.0.0 Rust | 30 | 0 | 40.061 | 45.493 | 38.92 | 30 |

改善率採 `(Python − Rust) / Python`，正值表示降低：

| Rust 相對基準 | helper p50 | helper p95 | 完整 CLI p50 | 完整 CLI p95 |
| --- | ---: | ---: | ---: | ---: |
| 原版 Python 對照／v2.9.0 CLI | 86.9% | 78.5% | 42.7% | 44.6% |
| 同版 3.0.0 Python | 87.2% | 81.5% | 43.5% | 46.8% |

Helper RSS 降低約 75.0%；完整 CLI RSS 反而增加約 0.08%，視為沒有可主張的改善。完整 CLI CPU p50 從 50 ms 降至 30 ms，但取樣工具只有 10 ms 精度；helper 的 0 ms 不代表沒有 CPU 消耗。

### 量測限制

- wall time 包含啟動程序、`time -l`、測試 fixture／shim 的成本；RSS 不是整棵程序樹的同時峰值。
- 每組只有 30 個樣本，各分位數是這批樣本的描述統計，未估信賴區間；列出的 p99 不構成可靠的母體尾端估計。
- 只測 helper 與 `relay lock`，不涵蓋真實 OAuth 網路延遲、所有 list/status 命令或 daemon 長期負載。
- 只有 macOS arm64 性能數據；跨平台 CI 通過不代表 Linux／Windows 有相同比例加速。
- 新舊兩次量測的絕對時間不同；不以跨日期結果推論效能回退或改善，以上百分比都來自本次同一批對照。

## 3. 功能可靠性與發布驗證

[3.0.0 main CI](https://github.com/darkstar1227/relay/actions/runs/34562120643) 的 12 個 jobs 全部成功，對應上述程式碼 commit：

| 驗證面向 | 結果與邊界 |
| --- | --- |
| 拆檔／組合一致性 | 產物檢查與 Linux／macOS 回歸通過；不是直接手改組合產物 |
| 本機主程式回歸 | 46/46 通過 |
| 本機 Rust unit | 12/12 通過 |
| 本機 core integration | 40/40 通過 |
| 本機 portable | 10 通過、1 Windows-only 略過 |
| 本機 OAuth fixture | 5/5 通過；不使用真實憑證 |
| 本機 POSIX adapter／legacy oracle | 20/20 通過，其中 4 項為 Python oracle |
| 本機成對安裝／回滾 | 6/6 通過：原子切換、毀損／版本不符拒絕、篡改拒絕、鎖互斥、啟動失敗及切換失敗 |
| 遠端 CI core | Linux、macOS、Windows 全部成功；Windows 不宣稱支援 POSIX daemon |
| 同一份 npm tarball 安裝 | Linux／macOS／Windows × Node 16／24，6/6 jobs 通過 |

測試數與 job 數是不同分母，不能相加成「獨立功能覆蓋數」。通過不代表所有故障時點都被驗證。

發布 tag 另外觸發 [npm 發布工作](https://github.com/darkstar1227/relay/actions/runs/34562565674)，需再次通過驗證才執行 npm publish；本文件不以 tag 存在代替 registry 發布成功。

## 4. 一致性、故障恢復與操作風險

| 面向 | Rust core 受測結果 | SRE 判讀／仍有限制 |
| --- | --- | --- |
| 並行資料一致性 | 憑證鎖、原子 JSON 寫入、並行 refresh／cursor、未知欄位保留 | 降低受測競爭條件風險；未覆蓋所有 filesystem fault／斷電時點 |
| OAuth 重試 | 過期並行查詢僅一次 fixture refresh；401 有界 retry；失敗不污染快取 | 不代表官方 API 長期成功率已提升 |
| 網路失敗 | timeout、body 上限、malformed JSON、302／401／429／503 測試 | 具故障邊界；沒有跨版本生產錯誤率比較 |
| Daemon 恢復 | SIGTERM 子程序清理、帳號恢復、SIGKILL 後 singleton 重啟 | 不是長時間 soak 或正式服務 migration rollback |
| 安裝／回滾 | 離線配對、候選驗證、原子 active 指標、舊版驗證後回滾 | 尚未接入公開 updater；hash 不等於發布者簽章；程序崩潰可能需人工處理安裝鎖 |
| 可觀測性 | 泛化錯誤不印 token，測試結果可追溯 | `refresh-all` 個別失敗可能仍 exit 0，須判讀各帳號結果 |
| 依賴與維運 | opt-in 路徑可不執行 Python helper | 主 CLI 仍需 Bash／PowerShell、Node 與平台工具；新增 native artifact 版本／平台管理負擔 |

## 5. 歷史真實測試與覆蓋率：不可冒充 3.0.0 重測

以下是移轉候選版的既有證據，詳見[先前整合驗收](sre-v2.9.0-vs-rust-core.md)，**本次沒有重新操作真實帳號或重啟 ds-home 服務**：

- 2026-09-10 ds-home 真實 OAuth／systemd 驗收 11/11 通過；refresh 561 ms、usage 617 ms、graceful stop 20 ms，均為單次觀測，不是 p95 或 MTTR。
- 原設定 bytes、原 service unit 與 current/live store 驗證恢復／未變；原 Python daemon 恢復 active/enabled。OAuth 輪替後保留新 token，不回退失效舊 token。
- 整段約 3.3 秒；候選服務關閉排程 warmup／切換，不含真實付費預熱端到端驗證。
- 候選版 Rust 行覆蓋率 1,904/2,107＝90.37%，包含 test／fixture 編譯路徑，不是 production-only。3.0.0 本次未重跑 coverage；branch coverage UNKNOWN。

## 6. 不能由現有資料推得的指標

| 指標 | 狀態 | 缺少的證據 |
| --- | --- | --- |
| 生產可用率／SLO 達標率／error budget | UNKNOWN | 定義好的 SLI、觀測窗口與生產請求分母 |
| MTTR／MTBF／事故率改善 | UNKNOWN | 同口徑事故紀錄與持續運行時間 |
| Daemon CPU／RSS／記憶體成長 | UNKNOWN | 新舊同負載長時間 soak |
| 真實 OAuth 新舊延遲／成功率差 | UNKNOWN | 同條件對照；一次真實 refresh 不足以統計 |
| Linux／Windows 性能改善率 | UNKNOWN | 對應平台的新舊 benchmark |
| 雲端費用／整體成本節省 | UNKNOWN | 實際使用頻率、工作負載及計費資料 |

## 7. 最終驗收判定與後續邊界

**GO：以目前受測範圍發布 3.0.0 的拆檔 CLI 與 opt-in Rust core。**

**不作 GO 宣告的範圍：**預設全面取代 Python、全平台 Rust CLI、公開自動配對 core 安裝／更新、自動服務遷移與回滾、長期可用性提升。macOS 真實 Keychain、Windows 真實 OAuth、macOS x64、Linux arm64／musl 與 MSRV 1.89 仍缺對應本輪證據。

建議下一輪先完成公開成對發布／更新與可回滾部署，再補 Linux／Windows 同口徑 benchmark、daemon soak 及必要的平台原生憑證驗收；不因本次短命令明顯加速就直接預設切換所有使用者。
