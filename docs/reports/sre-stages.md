# 分階段 SRE 報告索引

統一驗收與比較：[原版與 Rust core SRE 總結](sre-v2.9.0-vs-rust-core.md)。已補 ds-home 真實 OAuth／systemd 11/11、跨平台回歸、行覆蓋率及配對效能量測；不代表正式發布／成對 rollout 已完成。

最新修復驗收：[階段 09](stage-09-warmup-fix-sre.md) 已修復同帳號預熱回退 live 憑證的 P1，本機回歸通過；正式發布閘門仍未完成。[階段 08](stage-08-acceptance.md) 保留原始失敗證據。

最新跨平台覆蓋：[階段 12](stage-12-portable-core-coverage-sre.md) 的 31 個 core 操作在 macOS、Linux、Windows portable suite 通過；完整分支及整合覆蓋仍未完成。[階段 11](stage-11-remote-cross-platform-sre.md) 已驗證兩台隔離安裝與 Linux core 原生打包。主套件自動配對尚未驗收。

每一階段獨立保留測試邊界與結果，不覆寫歷史 artifact 的量測，也不把本機測試換算成 SLA。

| 階段 | 範圍 | 報告 | 狀態 |
|---|---|---|---|
| 01 | 拆檔、組合、安裝與更新 | [拆檔驗證](stage-one-validation.md)、[更新驗收](update-acceptance.md)、[遠端安裝](remote-install-validation.md) | 歷史 2.9.0 artifact 已驗收 |
| 02 | 初期 Rust core 與首次效能比較 | [SRE 比較](rust-core-sre-comparison.md)、[驗收](rust-core-validation.md) | 歷史 32-operation snapshot，本機驗證 |
| 03 | 憑證鎖 fail-closed、等待限制、清理 | [獨立 SRE](stage-03-credential-lock-sre.md) | 本機驗證 |
| 04 | Rust HTTP 與兩條版本查詢 | [獨立 SRE](stage-04-update-query-sre.md)、[效能](stage-04-rust-core-sre-comparison.md) | 本機驗證 |
| 05 | usage/status/refresh 共用 Rust 層 | [獨立 SRE](stage-05-usage-refresh-sre.md) | 本機驗證 |
| 06 | Rust 下載與成對更新閘門 | [獨立 SRE](stage-06-download-sre.md) | 下載器驗證；成對 rollout 未完成 |
| 07 | daemon 與剩餘五程式整合 | [獨立 SRE](stage-07-daemon-sre.md)、[效能](stage-07-rust-core-sre-comparison.md) | 本機驗證；正式平台未發布 |
| 08–09 | 驗收失敗與同帳號預熱修復 | [驗收](stage-08-acceptance.md)、[修復](stage-09-warmup-fix-sre.md) | 保留首次失敗與修復證據 |
| 10 | 原生 core 打包 | [SRE](stage-10-core-package-sre.md) | macOS arm64 隔離安裝 |
| 11 | 遠端跨平台驗收 | [SRE](stage-11-remote-cross-platform-sre.md) | 兩台安裝通過，Linux core 回歸通過 |
| 12 | Portable core 操作覆蓋 | [SRE](stage-12-portable-core-coverage-sre.md) | 三平台各 10/10 群組，非完整覆蓋 |
| 後續 | OAuth／usage／daemon／download／平台發布 | 每一完成階段新增報告 | 未完成，不預填結果 |

這些是實作子階段；原始交付順序仍是「拆檔與組合 → 完成 Rust core → 後續全平台 Rust CLI」。目前沒有新的正式發布。整體進度：[Rust core 開發紀錄](../development-rust-core.md)。
