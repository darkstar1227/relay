# 階段 09 SRE：同帳號預熱憑證回退修復

日期：2026-09-08。候選：2.9.2、HEAD `81121a7` 的未提交工作樹。

**結論：階段 08 的 P1 已修復並通過本機回歸；不是正式發布放行。** 未操作真實憑證、未部署服務、未發布。保留[原始驗收失敗紀錄](stage-08-acceptance.md)。

## 修復與行為邊界

在 `oauth.rs` 的共用 `switch_locked` 中，取得 credential.lock 並讀取 current 後，若目標等於 current，立即成功返回，不讀 snapshot、不寫 live、不改 current。

因此同帳號預熱不再將舊 snapshot 回寫 live。這是「不做憑證切換」，不是以 snapshot 修復遺失或損壞的 live 憑證；snapshot 也不會被順帶更新。正常不同帳號切換仍保留原有備份／切換流程。

## 缺陷重現到修復驗證

新增兩項正式回歸測試，先用未修復 binary 執行，結果 **0/2 通過、2/2 失敗**；加入修復後納入完整 core suite，兩項皆通過：

1. current=a、snapshot 為舊 token、live 為新 token：當分鐘預熱 a 後，live 與 snapshot bytes 均維持原值，current 不變，仍執行一次 Claude ping。
2. current=a、snapshot 損壞、live 不存在：同帳號切換不讀損壞 snapshot，也不以 snapshot 重建 live。

只使用一次性 HOME、合成憑證與假 Claude，不把結果當成真實 OAuth 成功率。

## 本次完整驗證

| 檢查 | 結果 |
|---|---|
| Rust unit | 8/8 通過 |
| Core integration/differential | 37/37 通過，含新增 2 項、不同帳號預熱還原、並行 token refresh、無 Python PATH |
| CLI／lock／legacy daemon oracle | 20/20 通過；其中包含 Python oracle，不全是 Rust daemon 測試 |
| 預設回歸 | 44/44 通過 |
| 組合檔一致性 | build:check 通過 |
| fmt／Clippy all-targets all-features warnings denied | 通過 |
| release build | 通過 |
| npm tarball 隔離安裝 | macOS arm64、Node 22.20.0 通過；仍是 Python default 套件 |
| diff whitespace check | 通過 |

## SRE 判讀與後續閘門

本階段的改善是兩個已知失敗案例由失敗轉為通過，不可換算為生產 uptime、MTTR 或可用率提升。未重新量測延遲／RSS；先前 benchmark 對應修復前 binary，不視為本次 artifact 的效能證據。

P1 修复不會自動完成 Rust npm 平台包、script/core 成對升級與 rollback、active daemon 遷移、真實 Keychain、MSRV／架構矩陣或 cf-windows／ds-home 新 artifact 驗收。上述發布閘門仍未完成，預設 Python fallback 保留。
