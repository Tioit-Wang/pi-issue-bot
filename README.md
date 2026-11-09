# pi-issue-bot

用 PI SDK（`pi-host` / `agent-runtime`）构建的 Issue / PR 自动处理平台。

**当前阶段：设计定稿 v0.4 + 技术方案 v1.0，实现未开始。**

| 项 | 状态 |
|---|---|
| 需求与设计 | v0.4，已定稿（`docs/plan.md`） |
| 视觉稿 | `docs/plan.html`（同一份计划的排版版本，浏览器直接打开） |
| 技术方案 | v1.0，已定稿（`docs/tech-plan.md`） |
| 实现 | 未开始（从 M0 起） |

## 它做什么

- 自动给 issue 分类打标
- 判断 issue 是否符合仓库的报告标准，并自动回复
- 被授权人员 `@机器人 /命令` 时执行技能（`/review-pr`、`/issue-triage`、`/issue-repro`）
- 自动创建 issue（带指纹去重与日配额）
- 自动推 `bot/*` 分支并开 PR
- 提供 Web 统计面板（吞吐、成本、自动执行后被人改回的次数、审计）

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

## 下一步：实现 M0

按 `docs/tech-plan.md` §12 的里程碑推进。M0 必须先用真实 pi-host bundle 验证两个风险：`PI_DESKTOP_BASH` 覆盖是否覆盖全部命令路径（R1），以及单 pi-host 多 session 的并发上限（R2）。
