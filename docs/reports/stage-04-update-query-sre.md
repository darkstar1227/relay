# 階段 04 SRE：Rust 版本查詢與 HTTP 基礎

日期：2026-09-08。狀態：本機驗證通過，尚未發布。接入 `latest-version`、`check-update-bg`，兩個 Python 程式共用一份 Rust 查詢實作；累計 34 個操作（含專用 credential holder）。

## 可靠性與行為

| 面向 | 先前 Python | Rust 候選 |
|---|---|---|
| 來源優先順序 | GitHub → npm | 相同 |
| HTTP 時間限制 | urlopen timeout 6 秒 | 每個來源總 request timeout 6 秒、connect timeout 6 秒 |
| 回應大小 | 無顯式上限 | 最多 1 MiB，超過轉備援來源 |
| 重新導向 | 自動跟隨 | 不跟隨，3xx 當成來源失敗並轉備援 |
| 版本欄位 | 直接印出 | 要求字串、數字開頭、最多 128 字元、僅 ASCII 英數與 .-+ |
| 診斷 | 例外通常被吞掉 | 固定錯誤訊息、不輸出回應內容 |
| TLS | 系統 Python TLS | reqwest 0.13.4 + rustls、平台驗證器，未停用驗證 |

版本字元檢查不是完整 SemVer 驗證；直接下載更新仍有原本獨立版本驗證。兩個來源連續逾時可能約 12 秒，不能將單一來源 6 秒誤當作整個指令上限。

API 實作依據：[reqwest 官方 blocking client](https://github.com/seanmonstar/reqwest/blob/master/src/blocking/client.rs)。使用 Context7 確認 timeout、redirect、blocking 與 rustls feature；沒有新增 endpoint 環境覆寫後門。

## 本次驗證

- Rust HTTP 單元測試 7/7：GitHub 成功不查備援、429 備援、損壞 JSON 備援、型別／控制字元拒絕、超大回應備援、3xx／503 失敗、總 request deadline。
- 測試使用 loopback 真實 TCP HTTP server，測試 client 禁用 proxy；不接觸 GitHub/npm/OAuth，不代表正式 TLS、DNS、企業 proxy 已驗證。
- 逾時測試配置 50 ms deadline，確認在 1 秒內失敗；這是測試斷言，不是生產延遲分布。
- `npm test`：44/44；`npm run test:core`：HTTP 7/7、core 25/25、CLI/daemon/鎖安全 20/20。
- Clippy warnings denied 與 release build 通過。release build 本機這次 31.27 秒，含新增相依套件的首次 release 編譯；沒有同條件舊版 clean build，不能計算建置改善率。

## 效能與成本

完整樣本：[階段 04 效能報告](stage-04-rust-core-sre-comparison.md)、[原始 JSON](stage-04-rust-core-benchmark.json)。每組 30 次、交錯執行，6 組共 180 次皆退出成功且輸出一致。

- 完整 `relay lock` p50：原版 85.34 ms、當前 Python 87.83 ms、Rust 44.46 ms。Rust 比本輪原版低約 47.9%；RSS p50 幾乎不變。
- provider-field helper p50：原版 Python 39.06 ms、Rust 5.17 ms；不能外推成所有指令都快 7.56 倍。
- release binary：711,440 → 4,448,288 bytes（前一份 core snapshot 對比本階段，約 6.25 倍）。這是未壓縮本機 binary，不是 npm 安裝體積。
- Cargo.lock 現有 173 個 package entries，加入 reqwest 時 resolver 回報新增 125 個；包含跨平台／條件相依，不能當成全部都會連結進本機 binary，也不是漏洞數量。
- 各輪負載不同，不能將前一份 68.98 ms 原版結果與本輪 44.46 ms Rust 結果拼在一起計算改善率。
- 這兩項 benchmark 不包含新版本 HTTP 查詢的網路時間；新增 HTTP 功能本身的生產效能仍 UNKNOWN。

## 尚未完成

仍有 5 個原始 Python 程式在 adapter 之外：usage table、status、refresh-all、daemon、download-update。全產品 Python 移除、平台打包、成對更新／回滾、原生遠端驗收尚未完成。MSRV 1.89 尚未實跑；新增相依需進入跨平台／MSRV 驗證。生產 uptime、MTTR、MTBF、真實 OAuth 成功率均 UNKNOWN。
