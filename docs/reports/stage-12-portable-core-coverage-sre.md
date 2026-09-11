# Stage 12：Portable core 跨平台覆蓋

日期：2026-09-09；版本：2.9.2 migration 工作樹。此階段新增測試與 CI 配置，沒有修改 Rust runtime，也沒有發布。

## 結論與分母

新增 `tests/core/portable.test.cjs`，10 個測試群組在 macOS arm64、ds-home Linux x64、cf-windows Windows x64 全數通過，各為 **10/10**。不依賴 Python oracle、Bash、HTTP、真實 OAuth、Keychain 或服務；每個案例使用獨立暫存目錄及 HOME。

測試執行 31 個業務/helper operation，加上 protocol、artifact-info，共 33 個入口。40 個 production 業務/helper operation 中，**31/40 有本次三平台正向 fixture 執行證據**。這是操作入口計數，不是行／分支覆蓋率，也不是 31 個功能的所有情境均已完成。其餘 9 個不能因不在 portable suite 就視為不存在或已通過。test-only daemon-step 不列入 production 分母。

## 平台證據

| 平台 | 二進位 | 測試群組 | 並行模型輪替 |
| --- | --- | --- | --- |
| macOS arm64 / Node 22.20.0 | 本機 release | 10/10 | 30 個程序，a/b/c 各 10 次，cursor=2 |
| ds-home Linux x64 / Node 24.16.0 | stage 11 native release | 10/10 | 同上 |
| cf-windows Windows x64 / Node 24.6.0 | stage 11 native debug MSVC | 10/10 | 同上 |

Windows 仍未測 release binary。本次 final suite Linux 約 239.8 ms、Windows 約 1111.4 ms，包含多程序啟動及測試框架，且 build profile、硬體不同，**不可據此宣稱平台差距或 Rust 相對 Python 的加速幅度**。

## 操作 × 平台 × 失敗情境矩陣

「三平台」指上述三台／三種原生 binary；下列列舉所有 40 個 production 業務/helper operation。

| 操作 | 本次平台覆蓋 | 正向 fixture | 負向／邊界 |
| --- | --- | --- | --- |
| provider-field、provider-discover、account-email、read-version | 三平台 | Unicode、布林、email、版本 | excess arguments；email 缺檔容錯、version 缺檔拒絕 |
| access-token、format-json | 三平台 | token、超過 JS safe integer 的整數 | malformed stdin 拒絕，stderr 不洩漏輸入；excess arguments |
| provider-add、run-settings | 三平台 | environment → 原子 JSON 寫入，含替換既有檔 | 缺環境不改原檔；provider 寫入目錄失敗、保留 sentinel、清理 temp；excess arguments |
| reorder、lock-add、unlock | 三平台 | 排序、鎖增刪、重複鎖不重複 | unknown fields 保留；excess arguments |
| warmup-add、warmup-remove、warmup-pause、warmup-resume | 三平台 | 排程增刪／重複、啟停 flag | unknown fields 保留；excess arguments |
| lock-default-config、warmup-ensure-config | 三平台 | defaults 從 credentials 產生 order | 不覆寫既有 config；excess arguments |
| config-save | 三平台 | 合併並保留未知欄位 | malformed JSON、array、null 拒絕且原檔 bytes 不變；excess arguments |
| codex-models-get、codex-models-set、codex-model-pick | 三平台 | 30 程序並行輪替、分配與最終 cursor | 確認無 lost writes、未知欄位保留；excess arguments |
| prompt-reorder、reorder-chain | 三平台 | shorthand、Unicode account、cycle | reorder-chain excess arguments；prompt 的變長引數不列 excess 檢查 |
| lock-list、warmup-list、warmup-health | 三平台 | 鎖顯示、排程、missed 3/3 | excess arguments；尚非所有格式錯誤分支 |
| autoswitch-config-summary、autoswitch-status、autoswitch-log | 三平台 | threshold、last-switch、event log | excess arguments；僅受測 fixture，非所有 timezone 分支 |
| sessions | 三平台 | 隔離 project/session 列表 | 缺目錄拒絕；excess arguments |
| warmup-test | 三平台 | 既有 no-op 行為 | excess arguments；不代表真實預熱已執行 |
| latest-version、check-update-bg | 未新增 Windows 證據 | stage 11 Linux core suite 有既有證據 | 真實網路與平台失敗矩陣待補 |
| render-table、status-once、refresh-all、sync-current | 未新增 Windows 證據 | stage 11 Linux core suite 有既有 fixture 證據 | 真實 OAuth、Windows credential adapter 覆蓋待補 |
| download-update | 未新增 Windows 證據 | 既有 POSIX fixture suite | Bash 驗證依賴／平台適用性、成對更新回滾待補 |
| credential-lock、daemon | 未新增 Windows 證據 | 既有 POSIX fixture suite | POSIX FIFO／service 邊界不視為 Windows 適用；正式 service 及強制終止等缺口仍保留 |

另外 protocol、artifact-info 的正向與 excess-argument 拒絕在三平台通過；unknown operation 的診斷不洩漏 supplied argument。excess-argument 測試共 32 個入口（33 減 prompt-reorder）。

## 持續驗證與證據路徑

- `scripts/test-core.cjs` 已納入 portable suite，避免只靠一次手動驗收。
- 整合後本機 runner 完整重跑 exit 0：Rust unit 8/8、既有 integration 38/38、新 portable 10/10、POSIX adapter／oracle 20/20；`git diff --check` 通過。
- `.github/workflows/core.yml` 增加 Windows native build + portable test job。**僅配置完成，未推送、未取得 GitHub CI 執行證據。**
- 遠端 final logs：stage 11 兩個隔離目錄內的 `portable-core.log`。Linux `/tmp/relay-stage-11-eg7IIrrw`；Windows `C:\Users\ssh-justin\AppData\Local\Temp\relay-stage-11-b389e47d05d942e6a0f8243ed0c84b9b`。
- context-mode 用於彙整測試日誌；報告分母取自實際 TAP 結果，沒有將省略輸出當作略過測試。

## 未完成項目

行／分支覆蓋率仍 **UNKNOWN**。真實 credential store、OAuth、Windows 非 portable operations 的平台契約、daemon 終止／正式遷移回滾、成對更新與完整 release matrix 尚未驗收；不得宣稱完整 core coverage 已達成。本階段把 Windows 從編譯 smoke 推進為 31 個操作的實際功能 fixture 驗證，未提前實作完整 Rust CLI。

本次沒有新舊版配對 benchmark、長時間壓測或 production SLI，因此不新增性能改善百分比、SLA 或可用性數字。
