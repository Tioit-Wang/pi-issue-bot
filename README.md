# pi-issue-bot

GitHub issue 自动处理平台：webhook 接事件 → PostgreSQL 记事实 → pg-boss 排队 → Docker 隔离执行 → 写回 GitHub，全程可在面板回放。

一个 issue 对应一条常驻 agent 会话，同一 issue 的后续事件进入同一会话。

## 做什么

- 判格式、按模板回复（同一 issue 同一槽位只有一条评论，不刷屏）
- 分类打标（词表 / 白名单 / 互斥组 / 上限 / 人工否决，六级归一）
- 被 `@pi-bot /命令` 时执行技能（`/review-pr`、`/issue-triage`、`/issue-repro` 等）
- 建 issue（指纹去重 + 日配额）
- 推 `bot/*` 分支并开 PR（推送集 = 声明 ∩ 实际改动）
- 面板：吞吐、成本、改回率、审计、issue 会话回放

## 不做什么

- 不合并 PR：`apps/server/src/github/` 里没有合并方法，`no-merge.test.ts` 扫源码守住
- 不设置信阈值：判定要证据（`rule / quote / passed`），不要模型自评分
- 不做人工审批流：只保留异常兜底
- 不支持多租户 / GitLab / GHES
- 不让 agent 直接写 GitHub：容器内没有任何凭证

## 跑起来

前置：Node ≥ 24、pnpm ≥ 10、PostgreSQL 16+、Docker。

```powershell
pnpm install
pnpm -r typecheck; pnpm -r test; pnpm lint   # 门禁

$env:PI_BOT_PG_DSN = 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot'
pnpm cli -- migrate        # 16 张初始表 + schema_migrations

pnpm cli -- serve          # 3000；metrics 9464
pnpm cli -- doctor         # 13 项预检
pnpm --filter @pi-issue-bot/panel dev   # 面板 5173，/api 代理到 3000
```

完整步骤见 [快速开始](docs/quickstart.html)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm -r typecheck` | 逐包 `tsc --noEmit` |
| `pnpm -r test` | 逐包 `vitest run`（25 个文件需要真 PG） |
| `pnpm --filter @pi-issue-bot/panel test` | 面板测试（jsdom + MSW） |
| `pnpm lint` | ESLint，含依赖方向门禁 |
| `pnpm gen:openapi` | 由 zod 生成 `openapi/pi-bot.openapi.json` |
| `pnpm cli -- serve` / `doctor` / `bootstrap-host` / `replay <id>` / `migrate` | 服务端命令 |

`pnpm test:all` 不跑 `.test.tsx`（面板 21 个测试文件里有 17 个是 `.tsx`），面板请用上面的 filter 命令。

## 配置

| 变量 | 说明 |
|---|---|
| `PI_BOT_PG_DSN` | 数据库，别名 `PI_BOT_DATABASE_URL` |
| `PI_BOT_WEBHOOK_SECRET` | GitHub webhook 验签密钥 |
| `PI_BOT_MODEL_BASE_URL` / `_NAME` / `_API_KEY` | 任意 OpenAI 兼容端点；key 没配模型名则启动报错 |
| `PI_BOT_GITHUB_APP_ID` / `_APP_PRIVATE_KEY_PATH` / `_INSTALLATION_ID` | GitHub App 认证 |
| `PI_BOT_DRY_RUN` | **默认 `true`**：不写 GitHub，只算不执行 |
| `PI_BOT_DATA_DIR` / `PI_BOT_JOB_ROOT` / `PI_BOT_CACHE_ROOT` | 数据、工作树、clone 缓存 |
| `PI_BOT_HOST_BUNDLE_DIR` | pi-host bundle 目录（需含 `PIN.json`） |
| `PI_BOT_PANEL_AUTH` / `_WRITE` | 面板鉴权与写面开关；`off` 只在 loopback 安全 |

全量见 [`deploy/env.example`](deploy/env.example)。

## 目录

```
apps/server     控制面 + 执行面（Node 24，187 文件）
apps/panel      面板（React 19，13 条路由 + 4 条 legacy 重定向）
packages/       contract（zod + OpenAPI）· envelope · racp-client · shared
migrations/     0000–0011
openapi/        生成物，入 git
deploy/         env.example · nftables.conf · docker-network.md
images/         node22.Dockerfile
scripts/        sandbox-bash · spike/
```

## 文档

| 文档 | 内容 |
|---|---|
| [快速开始](docs/quickstart.html) | 10 分钟跑通第一个 issue |
| [项目说明](docs/project-overview.html) | 结构、一次事件的 14 步、数据与配置、边界、缺口 |
| [测试规范](docs/testing-standards.html) | 分层、骨架、假件、哪些改动必须有测试 |
| [开发规范](AGENTS.md) | 依赖方向、不变式、验证矩阵、提交格式 |
| [需求正文](docs/requirements.html) | FR 26 / BR 12 / AC 25 |

## 现状

功能已接通运行时，**但未放行**：静态审查仍有语义缺陷，真实环境验收未做（pi-host bundle 未 vendored、GitHub App 未装、`nftables` 只写不跑、面板 OAuth 未接、`python312` 镜像未建）。清单见[项目说明 §10](docs/project-overview.html#s10)。

门禁是本地三条命令，仓库没有 CI，也没有覆盖率门禁。
