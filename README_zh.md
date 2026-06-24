# relay

Claude Code 多帳號快速切換工具。

## 安裝

```bash
git clone https://github.com/darkstar1227/relay.git
cd relay

# 給予執行權限
chmod +x relay

# 安裝（建立 symlink 到 /usr/local/bin）
./relay install
```

### 確認權限正確

```bash
# 確認腳本可執行
ls -l $(which relay)

# 資料目錄與憑證目錄需為僅限擁有者存取
ls -la ~/.claude-relay/
# 預期：drwx------

# 每個憑證檔案需為僅限擁有者讀寫
ls -la ~/.claude-relay/credentials/
# 預期：-rw-------  *.json
```

如果權限有誤，執行以下指令修正：

```bash
chmod 700 ~/.claude-relay ~/.claude-relay/credentials
chmod 600 ~/.claude-relay/credentials/*.json
```

## 使用

| 指令 | 說明 |
|------|------|
| `!relay` | 選單 + 5hr 用量 |
| `!relay 2` | 切到第 2 個帳號 |
| `!relay work` | 切到指定名稱 |
| `!relay status` | 目前帳號詳細用量 |

## 帳號管理

```bash
relay add <名稱>           # 新增帳號（需在 Terminal 執行，開瀏覽器登入）
relay save <名稱>          # 儲存目前登入狀態
relay rename <舊> <新>     # 重新命名帳號
relay list                 # 完整列表（含週用量）
relay remove <名稱>        # 刪除帳號
relay sessions             # Session 列表
relay uninstall            # 完全移除 relay 及帳號資料
```

## 原理

切換 macOS Keychain 內的 `Claude Code-credentials` OAuth 憑證。Sessions 存在 `~/.claude/projects/`，所有帳號共用，切換後 `claude -c` 直接繼續。

## 相容性

- macOS（使用 Keychain）
- 需要 `python3`、`claude` CLI

## 授權

MIT © [darkstar1227](https://github.com/darkstar1227)
