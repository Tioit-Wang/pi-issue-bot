# .secrets/ —— 本地凭据目录（**绝不入库**）

这个目录由 `.gitignore` 整目录忽略（只放行本 README），里面是这台机器上跑
pi-issue-bot 所需的 GitHub App 凭据。**不要提交、不要贴到 issue/日志、不要打包进镜像。**

## 里面有什么

| 文件 | 内容 | 用途 |
|---|---|---|
| `github-app.env` | App ID / installation ID / webhook secret / host token / 模型 key | `serve` 启动时的环境变量来源 |
| `pi-issue-bot-tioit.private-key.pem` | GitHub App 私钥（RSA，`-----BEGIN RSA PRIVATE KEY-----`） | 换 installation token，评论以 `pi-issue-bot-tioit[bot]` 身份发出 |

## github-app.env 的键（只列键名，值看文件本身）

```
PI_BOT_GITHUB_APP_ID                 # App 名 pi-issue-bot-tioit，拥有者 Tioit-Wang
PI_BOT_GITHUB_APP_PRIVATE_KEY_PATH   # 指向本目录的 .pem
PI_BOT_GITHUB_INSTALLATION_ID
PI_BOT_WEBHOOK_SECRET                # 必须与 GitHub 仓库 webhook 上的 secret 逐字一致
PI_BOT_HOST_TOKEN                    # RACP 设备令牌，与 data/host/pi-host/credentials.json 配对
PI_BOT_MODEL_API_KEY
PI_BOT_MODEL_BASE_URL
PI_BOT_MODEL_NAME
PI_BOT_MENTION                       # 评论里 @ 的名字（= App slug）
```

## 怎么用

`serve` 不会自动读这个文件（项目没有 dotenv 依赖）。启动前把它加载进当前进程环境：

```powershell
# 逐行注入（注释与空行会被跳过）
Get-Content .secrets\github-app.env |
  Where-Object { $_ -match '^\s*[A-Z_]+=' } |
  ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$k" -Value $v
  }

# 其余运行参数（库、端口、bundle、数据目录）仍照常给
$env:PI_BOT_PG_DSN = 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot'
$env:PI_BOT_HOST_BUNDLE_DIR = '<pi-host bundle 目录>'
$env:PI_BOT_DATA_DIR = 'C:\Users\Administrator\.pi-bot\data'
node --experimental-strip-types apps/server/src/cli.ts serve
```

## 三条硬约束

1. **webhook secret 必须与仓库 webhook 一致**：不一致的表现是 `/webhook` 全部返回 401，
   `webhook_deliveries.signature_valid = false`，`decision_reason = signature-invalid`。
   这是 2026-11-12 issue #30/#31 那次排查的根因。
2. **host token 必须与 host 侧登记的设备配对**：不配对时 `run-task` 报
   `RACP_CONNECT_FAILED / UNAUTHORIZED`（Host 拒绝握手）。换机器或重建 `data/host` 后
   需要重跑 `pi-bot bootstrap-host`。
3. **换密钥后要重启 serve**：环境变量只在进程启动时读一次。

## 轮换 / 吊销

- 私钥泄露：到 GitHub App 设置页重新生成私钥，覆盖本目录的 `.pem`，删掉旧私钥。
- webhook secret 泄露：在仓库 webhook 设置里换 secret，同步改 `github-app.env`，
  重启后重新投递一次确认 `signature_valid = true`。
