# 階段 08：獨立驗收結果

日期：2026-09-08。版本：2.9.2，HEAD `81121a7` 加未提交工作樹。

**結論：不通過正式驗收（NO-GO）。** 自動化測試與本機安裝通過，但補充驗收重現一個會回退 live 憑證的 Rust daemon 缺陷。先前階段報告的測試通過不等於本次驗收通過。這次沒有修改產品程式、發布或操作真實憑證。

## P1：預熱目前帳號會將 live token 回退到舊 snapshot

位置：`crates/relay-core/src/oauth.rs:279` 的 `switch_locked`，由 `crates/relay-core/src/daemon.rs:140` 的 warmup 呼叫。

根因：函式先將目標 snapshot 讀入 `target`，再把目前 live 憑證備份到 snapshot，最後仍將先前讀到的舊 `target` 寫回 live。當目標就是 current，備份更新後的 snapshot 並沒有更新記憶體裡的 target。

本次重現使用 `tests/support/sandbox.cjs` 建立一次性 HOME、假 Claude 與假憑證，執行 test-fixtures binary 的 `daemon-step`，完成後清除暫存資料：

1. current=a；a 的 snapshot 放舊 access/refresh token。
2. live credential 放較新的 access/refresh token。
3. 設定當分鐘預熱 a，order 設為空，排除 autoswitch 干擾。
4. 執行一個 daemon tick。

| 判斷 | 實際結果 |
|---|---|
| 程序退出碼 | 0 |
| live 憑證維持原值 | false |
| live 被改為舊 snapshot | true |
| snapshot 有備份較新的 live | true |

影響：可能使使用中的帳號退回過期 access token 或已輪替失效的 refresh token，造成後續請求／refresh 失敗。重現證明本機狀態被回退，未呼叫真實 OAuth，不能聲稱已觀察到生產登入故障。現有「預熱後還原」測試只涵蓋預熱另一帳號，沒有涵蓋此情境。

建議修復：同帳號操作在鎖內保留 live 憑證，不將舊 snapshot 寫回；新增同帳號預熱回歸，再重跑不同帳號切換、並行 refresh、warmup 還原等測試。本次為驗收，未直接實作修復。

## 本次重新執行的檢查

| 檢查 | 結果 |
|---|---|
| `npm run build:check` | 通過 |
| `npm test` | 44/44 通過 |
| `npm run test:core` | Rust unit 8/8、core 35/35、CLI/legacy oracle 20/20 通過 |
| 無 Python PATH 測試 | 包含在 core 35 項內，通過；使用測試 feature 與隔離 fixture |
| `npm run test:package` | macOS arm64 / Node 22.20.0 隔離安裝通過 |
| `cargo fmt --all -- --check` | 通過 |
| Clippy all-targets/all-features、warnings denied | 通過 |
| 補充同帳號預熱驗收 | **失敗，阻擋放行** |

這些測試組有重疊與 Python oracle，不加總為唯一涵蓋率。没有新增效能量測；前一階段效能不能抵銷正確性失敗。

## 即使修復缺陷，仍需完成的發布閘門

- package.json 的發布清單沒有 Rust binary；此次 npm 安裝成功驗證的是仍有 Python 預設路徑的套件，不是完整 Rust 安裝。
- Rust opt-in 的跨版本自動更新仍被程式明確拒絕，script/core 成對更新及 rollback 尚未驗收。
- cf-windows／ds-home 的歷史測試不是本次 Rust artifact；本次沒有重新連線做原生驗收。
- active daemon 移轉、服務啟動失敗回退、MSRV／架構矩陣、真實 Keychain、長時間 soak 尚未驗收。

目前只可維持隔離開發驗證，不應啟用此 Rust daemon 管理真實帳號。下一次驗收須先證明上述 P1 不再重現，再分開評估 core 正確性與正式發布條件。
