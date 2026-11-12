# pi-issue-bot

用 PI SDK（`pi-host` / `agent-runtime`）构建的 Issue / PR 自动处理平台。

**当前阶段：v2.1 已实现并完成集成，可编译、可跑（`pnpm -r typecheck` 6/6 全绿、v2.1 集成测试 42/42 全绿），但静态审查结论仍为 `IS_PASS: NO` —— 6 条 BLOCKER 等语义缺陷未修，尚未放行；真实环境验收（含 PostgreSQL 依赖用例）仍待目标机。**

| 项 | 状态 |
|---|---|
| 需求与设计 | v0.4 已定稿（`docs/plan.md`）；v2.1 需求正文 `docs/requirements.html`（FR 26 / BR 12 / AC 25），接口冻结 `docs/v21-contract.md`，需求审查标尺 `docs/v21-requirements-summary.md`，静态审查与最终执行结果 `docs/v21-static-review.md` |
| 视觉稿 | `docs/plan.html`（同一份计划的排版版本，浏览器直接打开） |
| 技术方案 | v1.1，已定稿（`docs/tech-plan.md`） |
| 契约 | 已冻结：`docs/spec/contract-{db,api,envelope}.md` + `packages/contract`（zod）+ `openapi/pi-bot.openapi.json`；v2.1 跨模块接口以 `docs/v21-contract.md` 为准 |
| 实现 | 控制面/执行面/面板全部落代码，见下方「实现状态」；v2.1（WS1–WS6）已接入运行时，但静态审查 `IS_PASS: NO`，遗留清单见 `docs/v21-static-review.md` §5.5 |

## 它做什么

- 自动给 issue 分类打标
- 判断 issue 是否符合仓库的报告标准，并自动回复
- 被授权人员 `@机器人 /命令` 时执行技能（`/review-pr`、`/issue-triage`、`/issue-repro`）
- 自动创建 issue（带指纹去重与日配额）
- 自动推 `bot/*` 分支并开 PR
- 提供 Web 统计面板（吞吐、成本、自动执行后被人改回的次数、审计）
- v2.1：事件级触发开关与提示词模板、评论闸门、七类动作产出与目标态写回（含评论槽位）、会话常驻与上下文压缩引擎 —— **已实现并接入运行时，静态审查仍列出待修项，见 `docs/v21-static-review.md`，不视为已全部达标**

## 它不做什么

- 不合并 PR（代码层不实现 merge，分支保护强制人工 review）
- 不设置信阈值（判定靠证据，不靠模型自评分）
- 不做事前审批与事后复核（只保留异常兜底通知）
- 不支持多租户、GitLab、GHES

## 关键决策

| # | 决策 |
|---|---|
| D1 | 单组织自托管，一个 GitHub Org、少量仓库，单机 |
| D2 | GitHub.com + GitHub App（安装级 token，1 小时过期） |
| D3 | 打标 / 评论 / 建 issue / 推 commit / 开 PR 全自动；没有合并能力 |
| D4 | 真实检出：clone + 装依赖 + 跑测试，每任务独立 worktree |
| D5 | Docker 一任务一容器；agent 在宿主机，只有命令进容器 |
| D6 | 不设置信阈值；关闭 issue 走确定性条件 |
| D7 | 公网放行，私网与云元数据地址阻断 |
| D8 | 取消事前审批与事后复核，只保留异常兜底 |
| D9 | < 100 事件/天，2–4 并发 |

## 文档

- [`docs/plan.md`](docs/plan.md) — 需求与设计，唯一事实源
- [`docs/plan.html`](docs/plan.html) — 同一份计划的排版版本（视觉效果，内容以 `plan.md` 为准）
- [`docs/tech-plan.md`](docs/tech-plan.md) — 技术方案 v1.0：选型、逐组件成熟库/自研判定、面板与后端结构
- [`docs/dev-plan.md`](docs/dev-plan.md) — 开发计划：session 编排、切片波次、验收闸门、并行冲突规则

**v2.1（当前迭代）**

- [`docs/requirements.html`](docs/requirements.html) — 需求正文（FR 26 / BR 12 / AC 25）
- [`docs/v21-contract.md`](docs/v21-contract.md) — 开发期接口冻结（配置形状 / 判定 / 占位符 / 产出 / 写回 / 会话 / 文件归属 / 验收映射；文末附录补记实现状态与已知偏离）
- [`docs/v21-requirements-summary.md`](docs/v21-requirements-summary.md) — 需求审查标尺（7 组审查机器人的统一输入，只讲口径不预判实现）
- [`docs/v21-static-review.md`](docs/v21-static-review.md) — 静态审查结论（`IS_PASS: NO`）+ 最终执行结果 + 遗留清单（§1–§4 是集成前快照，§5 是最终执行结果）

## 技术方案要点

| 项 | 结论 |
|---|---|
| 后端语言 | Node 24 + TypeScript（否决 Go：pi-host 本身就是 Node 程序，RACP 契约是 TypeBox schema） |
| 框架 | Fastify 5 + zod 4 → OpenAPI 3.1 |
| 队列与持久化 | 单个 PostgreSQL 16+，队列用 pg-boss 12（不引入 Redis） |
| agent 调用 | RACP-WS（JSON-RPC over loopback WebSocket），pi-host bundle 作子进程 |
| 命令进容器 | `PI_DESKTOP_BASH` 覆盖 + 15 行 shim → `docker exec`，工作树按同路径挂载 |
| GitHub 集成 | Octokit 5 + `@octokit/auth-app` + `@octokit/webhooks`（不用 Probot） |
| 面板 | React 19 + Vite 8 + Tailwind 4 + shadcn/ui + Recharts + TanStack Query |

自研只有 5 处（RACP-WS 客户端、重复输出熔断、容器生命周期策略、自动审批策略、被人改回判定），合计约 1200–1600 行，其余全部使用成熟开源库。

## 实现状态

代码已按 `docs/tech-plan.md` §12 的 M0–M4 切片落地，`docs/dev-plan.md` §13 记录波次、文件所有权与验收证据。

| 层 | 已实现 | 关键文件 |
|---|---|---|
| 契约 | 16 表列定义、9 接口、信封 JSON Schema 正反例、`.github/pi-bot.yml` 与技能 frontmatter 的 zod | `packages/contract`、`packages/envelope`、`docs/spec/contract-*.md` |
| 数据/队列 | drizzle schema + `0000_init` 迁移、pg-boss 封装、`failure_class` 优先级、重试矩阵、排队闸门、429 熔断 | `apps/server/src/{db,queue}` |
| agent 侧 | RACP-WS 客户端（帧/传输/18 条白名单 op、断线不重发、游标重放）、pi-host 监督与配对、AES-GCM 令牌、自动审批、turn 驱动 | `packages/racp-client`、`apps/server/src/runtime` |
| 执行面 | HostConfig 映射（身份挂载/只读/分档内存）、exec 代理 + shim（容器内 `timeout` + `PI_CMD_ID` 兜底）、生命周期与 OOM 采集 | `apps/server/src/sandbox`、`scripts/sandbox-bash`、`images/`、`deploy/` |
| GitHub | App 认证、Octokit 工厂与限流头、六动作执行器（隐藏标记去重、标签归属、无 merge） | `apps/server/src/github` |
| 闭环 | worker 全链（信封→写回闸门→审计）、重复输出熔断、M1 分类/合规/不重复催办、关闭闸门、定时作业（聚合/对账/保留期/清扫） | `apps/server/src/{worker,degeneracy,skills,workflows,jobs,git}` |
| HTTP/面板 | webhook 九步管线 + handler 内 10 秒应答、8 个只读接口、独立 `/metrics`、7 页面板（四态 + MSW） | `apps/server/src/{http,queries,app}`、`apps/panel` |

## 怎么跑

```powershell
pnpm install
pnpm -r typecheck; pnpm -r test; pnpm lint   # 三条门禁
pnpm gen:openapi                              # 由 zod 重新生成 openapi/pi-bot.openapi.json
pnpm cli -- --help                            # pi-bot CLI（serve / doctor / bootstrap-host / replay / migrate）
docker compose -f deploy/compose.yaml up -d postgres   # 或自备 PG16+
pnpm cli -- migrate --dsn postgres://…        # 建 16 张表 + schema_migrations
pnpm --filter @pi-issue-bot/panel dev         # 面板（MSW 假数据，`?mock=empty|error|unauthorized|slow`）
```

### 模型端点（标准 OpenAI / DeepSeek / MiMo 兼容）

agent 的模型请求由 pi-host 代发，我们只负责把端点配置交过去，**不做 provider 客户端**：
任何说 OpenAI 兼容协议（`/chat/completions`、`/models`）的端点都能直接用。

| 变量 | 说明 | 兼容别名 |
|---|---|---|
| `PI_BOT_MODEL_BASE_URL` | base URL，形如 `https://api.deepseek.com/v1`（尾部 `/` 会被吃掉） | `OPENAI_BASE_URL`、`DEEPSEEK_BASE_URL` |
| `PI_BOT_MODEL_NAME` | 模型名，`deepseek-chat` / `gpt-4o-mini` / MiMo 对应模型名 | `PI_BOT_MODEL` |
| `PI_BOT_MODEL_API_KEY` | 模型 API key | `OPENAI_API_KEY`、`DEEPSEEK_API_KEY` |

- 三者都会以「我们自己的名字 + 标准 `OPENAI_*` 名」两种形式交给 pi-host（可信侧），**永不进任务容器**。
- 配了 key 却没配模型名 → 启动即报错（不让它伪装成「任务失败」）。
- `pi-bot doctor` 新增第 13 项 `model-endpoint`：`GET <base>/models` 验证「端点可达 + 凭证被接受」，
  不烧 token；没配是 `warn`（dry-run 不需要），401/403 与不可达是 `fail`。
- 完整变量清单见 [`deploy/env.example`](deploy/env.example)。

## 还需要真实环境才能验的部分（诚实账）

1. **`vendor/pi-host/<version>/` 尚未 vendored**：`PIN.json` 校验、`connection/initialize` 实机握手、`PI_DESKTOP_BASH` 三条命令路径（R1）、单 pi-host 并发矩阵（R2）都必须在拿到 bundle 后跑 `docs/spec/b0-spike.md` 的脚本。
2. **GitHub App 凭证**：`GitHub 零副作用`在 e2e 里用假 client 验过（非 GET 计数 = 0、`actions` 0 行），真投递与写回需要装 App。
3. **`deploy/nftables.conf` 只写不跑**：本机（Windows + VPN）`canary-network` 项为 `fail`（内网可达），需在目标 Linux 机 apply 后复验。
4. **面板鉴权**：OAuth 流程留了注入点与 TODO，未接真 OAuth App。
