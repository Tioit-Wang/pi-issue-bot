# 开发计划 · v1.0（项目经理）

> 输入：`docs/plan.md` v0.4（设计事实源）、`docs/tech-plan.md` v1.0（技术方案，正被 S4 修订为 v1.1）、
> 三份专项报告（后端切片 / 面板契约 / 对抗性评审），以及当前已并行的 4 个 session 的真实分工。
>
> 本文只回答三件事：**谁做什么、按什么顺序、什么算做完**。技术细节一律回到 `tech-plan`。

---

## 0. 一页纸

| 项 | 结论 |
|---|---|
| 编排模型 | 三层：**PM（我）→ session（文件所有权边界）→ 子代理（角色工具箱）** |
| 当前并行度 | 4 个 session（S1 验证 / S2 契约 / S3 骨架 / S4 方案修订），0 冲突路径 |
| 开工判定 | **评审发现 4 个 Blocker，S4 修完 + M0 Gate ⛔ 项全绿才允许写业务代码** |
| 最短可演示路径 | S3（骨架）→ S2（契约）→ B5（RACP 客户端）+ B13（worker 闭环）→ 第一条真实事件端到端（GitHub 零副作用） |
| 关键路径 | `骨架 → 契约 → RACP 客户端 → pi-host 监督 → worker 汇合 → 审批/写执行器 → 时间闸 → 检出 → 写回` |
| 瓶颈切片 | **B3 契约** 与 **B13 worker 汇合**，两者决定后面 6 个切片能否并行 |
| 不可并行的事 | 契约冻结、迁移序号、队列定义、路由表、`shared` 叶子包 |

---

## 1. 编排模型：session 是边界，子代理是工具

```
PM（本会话：分派、收敛、Gate 判定、契约变更仲裁）
├─ S1 session ── 可用 @fixer @code-reviewer        （验证类：脚本 + 结论，产物 docs/spec + scripts/spike）
├─ S2 session ── 可用 @fixer @code-reviewer        （契约类：只写 docs/spec/contract-*.md）
├─ S3 session ── 可用 @fixer @code-reviewer        （骨架类：只写根配置 + 空包）
├─ S4 session ── 可用 @code-reviewer               （修订类：只写 docs/tech-plan.md + contract-skill.md）
└─ 后续 B* / M* session ── 按 §4 表格分配，UI 类可用 @ui-designer
```

三条硬规则（这是"多 session 不打架"的全部秘密）：

1. **一个 session 只拥有一组文件**（表见 §2）。所有权冲突在目录层面就被排除，不靠"记得先拉代码"。
2. **契约先冻结再并行**。契约（枚举 / 信封 schema / DB / OpenAPI / 事件 kind / 技能 schema / 仓库配置 schema）冻结前，任何页面或 worker 都不许开工。
3. **子代理不跨 session 复用**：`@fixer` 在 S5 里改的文件，S6 不许碰；评审类（`@code-reviewer`）永远是只读。

---

## 2. Session 台账

| Session | 主题 | 文件所有权 | 可用子代理 | 完成信号 |
|---|---|---|---|---|
| **S1** | B0 沙箱桥与 RACP 并发验证 | `docs/spec/b0-spike.md`、`scripts/spike/**` | `@fixer` `@code-reviewer` | 4 条断言（V1 前台 / V2 后台 / V3 超时 kill / V4 并发）各有判定标准 + 可在 Linux 宿主执行的脚本 |
| **S2** | 契约冻结 | `docs/spec/contract-db.md`、`contract-api.md`、`contract-envelope.md` | `@fixer` `@code-reviewer` | 16+ 表列定义、9 个接口响应结构、信封 JSON Schema 正反例；末尾给出「相对 tech-plan §7.2 的差异清单」 |
| **S3** | 工程骨架与门禁 | 根配置 + `apps/**` `packages/**` 空骨架 + `images/` `deploy/` `scripts/` 占位 + `docs/spec/dev-setup.md` | `@fixer` `@code-reviewer` | `pnpm -r typecheck/test`、`pnpm lint`、`cli --help` 四条真跑通；依赖方向规则能被故意违反触发失败 |
| **S4** | 技术方案修订 v1.1 | `docs/tech-plan.md`、`docs/spec/contract-skill.md` | `@code-reviewer` | F1–F10 逐条落地 + 修订记录表 + 每条一句验证方法 |
| S5 | B5 RACP 客户端 | `packages/racp-client/**` | `@fixer` `@code-reviewer` | mock host 单测（binary frame / 非 loopback / 版本不匹配）+ 实机 `initialize` |
| S6 | B2+B9 数据与队列 | `apps/server/src/db/**`、`migrations/**`、`apps/server/src/queue/**` | `@fixer` `@code-reviewer` | 空库迁移幂等；`singletonKey` 重复 send 只 1 job |
| S7 | B7 沙箱与 doctor | `apps/server/src/sandbox/**`、`deploy/sandbox-bash`、`images/**`、`doctor.ts` | `@fixer` `@code-reviewer` | `docker inspect` 断言只读根 fs / 内存上限；容器内 `$PWD` = 宿主 worktree |
| S8 | B13 worker 闭环 | `apps/server/src/worker/**` | `@fixer` `@code-reviewer` | 一条真实事件跑到信封入库，`actions` 行数 = 0（GitHub 零副作用） |
| S9 | B11+B10 API 与 webhook | `apps/server/src/http/**`、`src/queries/**` | `@fixer` `@code-reviewer` | webhook <2s 且重投不新增；面板数字与手写 SQL 逐字段相等 |
| S10 | P0 面板壳层 | `apps/panel/src/{routes.tsx,lib/**,components/ui/**,mocks/**}` | `@ui-designer` | 7 路由可达、四态齐备、`format.ts` 六类单测 |
| S11+ | 面板页面 S1..S7 | 每页独占 `routes/*.tsx` + 自己的 `mocks/handlers/<page>.ts` | `@ui-designer` | 每页 DoD（§6） |

> 说明：`@fixer` / `@ui-designer` / `@code-reviewer` 的模型覆盖当前**未授权**（委托模型开关未开），全部继承会话默认模型。这是平台约束，不是计划缺陷。

---

## 3. 开工前置：4 个 Blocker

评审（`@code-reviewer`）对 `tech-plan` v1.0 给出的 4 个 Blocker，全部成立，且都**必须在写第一行业务代码之前改掉**——它们不是实现细节，是方案层的结构错误。

| # | 问题 | 不改的后果 | 处理 |
|---|---|---|---|
| F1 | shim 转发 `docker exec`，而它是 pi-host 的子进程 → 必须能读 docker socket；但方案又说「socket 只在 bot」 | M0 第三天就二选一：给 pi-host 树 socket 权（逃逸面进 agent 可达进程树），或 shim 跑不起来；plan §8.4 红线 1 名存实亡 | **S4**：改成 bot 侧 unix socket exec 代理，`<job>/.pi-bot/exec.sock`，容器名由代理查表（顺带解决 `pwd` 变 cwd 就找不到容器的 Major） |
| F2 | 身份挂载下容器可写 worktree 全部字节，推送只校验 `actions` 声明，不校验内容 | `postinstall` 往 worktree 塞一个 workflow 或改 README，agent 只声明 `push_branch`，控制面照推 → **陌生代码直接进仓库** | **S4**：写回闸门 = 声明路径 ∩ 实际编辑路径，禁 `.git/`、workflows、submodule、hooks；列入 M4 ⛔ |
| F3 | 单命令超时 `timeout` 在宿主侧，容器内进程存活 | agent 超时后发下一条命令，两条同写一个 worktree；容器继续吃 2 CPU / 2 GB 到任务级 20min | **S4**：超时下沉进容器 `docker exec … timeout …`，宿主侧再 `pkill` 兜底 |
| F4 | 没有存「缺失项集合」与「最近人工回复」 | plan §6.2「只在缺失项变化时再回复」与 §7「48h 未变 + 无人回复」**在数据模型上不可判定** → 重复催办、拍脑袋关闭 | **S4** 加 `issue_states` 表；**S2** 并入契约（已发增量消息） |

另有 4 个 Major 同批处理（`socket/超时` 之外）：队列等待闸门与 10 秒应答路径错误（`expireIn` ≠ 排队时长，应答必须在 webhook handler 内）、重试矩阵缺判定优先级（超时会被当容器崩溃重试）、评论隐藏标记含 task id 导致跨任务去重失效、`racp.schema.json` 无来源钉扎规则。

**Gate-0（修订验收）**：S4 交回后，我逐条确认「F1–F10 已改 + 每条有一句验证方法」，才把 `tech-plan` 标记为 v1.1 并允许 S5 之后开工。

---

## 4. 后端切片与波次

切片编号沿用后端报告（B0–B13 + M1-*/M2-*/M3-*/M4-*）。规模为估算，用于判「能否一个 session 一天做完」。

| 切片 | 目标 | 依赖 | 可并行兄弟 | 里程碑 |
|---|---|---|---|---|
| **B0** | 真实 bundle 验证 R1（三条命令路径）/ R2（多 session 并发） | — | B1, B3 | M0 |
| B1 | 骨架 + `shared`（pino redact、Result、`runWithDeadline`、错误分类） | — | B0, B3 | M0 |
| B2 | Drizzle 全量表 + 首个迁移 + dev compose PG16 | B1 | B3, B4, B5, B9 | M0 |
| **B3** | 冻结契约：枚举 + 9 条 GET 的 zod + `openapi.json` 入 git | B1 | B4, B5, B9 | M0 |
| B4 | envelope 包：JSON Schema + Ajv + 动作白名单 + 正反例 | B1 | B3, B5 | M0 |
| B5 | racp-client：帧层、Bearer/子协议/文本帧、`after` 重放、错误映射 | B0 | B3, B4 | M0 |
| B6 | pi-host 子进程监督 + `bootstrap-host` 配对 + 令牌加密落库 | B2, B5 | B7, B9 | M0 |
| B7 | 沙箱：exec 代理 + HostConfig 映射 + 身份挂载 | B0, B1 | B6, B9 | M0 |
| B8 | `doctor`（docker/磁盘/镜像/cgroup/金丝雀/nftables/pg/host ping） | B2, B6, B7 | — | M0 |
| B9 | pg-boss 封装 + 队列定义 + 重试矩阵 + `singletonKey`/`expireIn` | B2 | B3, B10 | M0 |
| B10 | webhook：raw body 验签 → 去重 → 入队 + 10s 应答 + `replay` | B2, B9, B12 | B11 | M0 |
| B11 | Fastify + `/healthz` `/metrics` + swagger + `queries/` + 只读 API | B2, B3 | B10 | M0/M3 |
| B12 | GitHub App 认证 + Octokit 工厂 + 限流头 + merge 扫描断言 | B1 | B10, B13 | M0 |
| **B13** | worker 闭环：register→create→subscribe→turn→事件→diff→信封 | B2,B4,B5,B6,B7,B9,B12 | — | M0 |

**波次编排**（每波次收口后我才起下一波，避免半成品互相等待）：

| 波次 | 并行 session | 说明 |
|---|---|---|
| Wave 1（已开） | S1=B0、S2=B3 草案、S3=B1、S4=F1–F10 | 四个 session 文件零重叠；S4 最长，但不阻塞 S1/S3 |
| Wave 2 | S6=B2+B9、S5=B5、S7 雏形 | 依赖 B1（S3）与 B3 草案 |
| Wave 3 | S9=B10+B11、S8=B13、S10=P0 面板 | B13 依赖 B6，故 B6 与 B13 同 session 串行做 |
| Wave 4 | S11+ 面板 S1..S7（2 路）、B8 doctor、M1-1/2/3 | 面板靠 mock 全速跑，不等后端 |
| Wave 5+ | M1-4 回放、M2-*、M3-*、M4-* | 每里程碑 2–4 路，按 Gate 放行 |

**为什么 B3 与 B13 是瓶颈**：B3 阻塞面板全部页面 + 后端 4 个切片的 schema；B13 是「第一条端到端」的汇合点，它不通，M1 之后全部无法验收。这两个切片不允许边写边改，且必须单 session 独占。

---

## 5. 面板切片与并行策略

| 切片 | 内容 | 依赖 | 与谁并行 |
|---|---|---|---|
| **P0** | 壳层：Layout + 路由 + 守卫 + `api.ts`/`queries.ts`/`format.ts` + `DataTable` + `openapi.yaml` + MSW 骨架 | 契约（B3） | 阻塞其它页面，但只做骨架 |
| S1 | `/` 总览（4 StatCard + 趋势 + 分布 + 失败 Top5） | P0 | S2/S4/S5/S7 |
| S2 | `/tasks` 列表（5 筛选 + 游标 + URL 同步） | P0 | S1/S4/S5 |
| S3 | `/tasks/:id` 详情（时间线 / 信封 / diff 三 Tabs） | P0 | S2 |
| S4 | `/costs`（模型堆叠 + 命令条形 + 最贵十任务） | P0 | S1/S5/S7 |
| S5 | `/quality`（改回率 + 按 intent 堆叠条 + 记录） | P0 | S1/S4 |
| S6 | `/audit`（筛选 + CSV 导出 + 截断提示） | P0 | S2 |
| S7 | `/system`（doctor 逐项 + 保留期 + 降级横幅） | P0 | S1/S4 |

**并行机制**：`apps/panel/openapi.yaml` 是唯一事实源 → `openapi-typescript` 生成类型 → `openapi-fetch` 客户端 → **MSW 拦截 `/api/*`**。不用 Vite proxy 到 stub，理由：两个 session 会抢端口；且 MSW 能用 `?mock=empty|error|unauthorized|slow` 一键验四态。后端就绪后只改 `gen:api` 的 source，页面代码不动。

**必须先冻结的最小契约集**：`/api/session`（第 9 个接口）、`/api/overview` 全量、`/api/tasks` 列表项与游标语义、`/api/costs` 的 `by_model`/`series`，以及全局约定（时间/金额/token/耗时单位、`null` 与 `0` 必须可区分、比例 0–1、游标分页、筛选参数名、错误结构）。

---

## 6. 验收闸门

原则：**能不看源码验，能贴命令验**。⛔ 项不通过禁止进入下一里程碑。

### M0 最小闭环

| 检查项 | 判定方式 | 通过标准 |
|---|---|---|
| ⛔ 命令真的在容器里 | 跑任务期间多次采样宿主进程表，统计含 `bash -lc` 的宿主进程数；容器内 `hostname`、`cat /proc/1/cgroup` | 宿主计数恒为 0；覆盖前台 / 后台 / 超时 kill 三条路径 |
| ⛔ socket 归属自洽 | 检查 pi-host 进程的打开文件描述符中是否存在 docker socket | 为 0，且方案文本与实际一致（F1 修完的证明） |
| ⛔ GitHub 零副作用 | Octokit 非 GET 调用计数 + 三个 `gh api` 快照（comments / labels / pulls） | 写调用 = 0，三快照相等 |
| ⛔ doctor 拒绝启动 | 逐项破坏（删镜像 / 假磁盘 / 清 nftables）后 `systemctl start` | 每项破坏都启动失败；`pi-bot doctor` 退出码非零 |
| 幂等重投 | 同一 `X-GitHub-Delivery` POST 20 次 | `webhook_deliveries` = 1 行、`pgboss.job` = 1 行 |
| 金丝雀网络 | 容器内探 `169.254.169.254`、`http://10.0.0.1`、`::ffff:169.254.169.254`，再探公网 DNS | 三个内网目标全部失败；公网解析成功 |
| 契约钉扎 | bundle 与 `racp.schema.json` 的 `sha256` 记入日志/DB | 无 `HOST_VERSION_MISMATCH`，文件在仓库内 |

### M1–M4 关键 ⛔ 项（其余见评审报告）

| 里程碑 | ⛔ 项 | 通过标准 |
|---|---|---|
| M1 | 不重复催办 / 不动人打的标签 | 连发 3 次 `edited` 评论数不变；人先打的 `bug` 仍在且 `bot_labels` 无该行 |
| M1 | 面板数字 = SQL | overview/tasks 四个数字逐个整数相等 |
| M2 | 10 秒应答（积压场景） | 先堆 5 个任务，再 `@bot /review-pr`，p95 < 10s |
| M2 | 超时不自动重试 + 真的杀进程 | `runs` 恰好 1 条 `timed-out`；容器内 `pgrep -f 'sleep 400'` 为空 |
| M2 | OOM 归类 | `failure_class='sandbox'`、`attempt=1` |
| M3 | 改回口径可核对 | 人造 5 例（删标签 / request_changes / 关未合并 PR / 删 bot 评论 / revert commit）全部计入 |
| M3 | 鉴权无绕过 | 未登录 `/api/*` 401、非组织成员 403、公网不可达 `/metrics` |
| M4 | 容器内容不得流入 PR（F2） | 注入 `injected.txt` 后，推送分支不含未声明变更 |
| M4 | 关闭路径不误触发 | 4 种反例（48h 内有回复 / 缺失项变化 / 缺标签 / 已 reopen）下 `close_issue` 计数 = 0 |

---

## 7. 并行冲突规则

多 session 同写一个仓库，冲突不在「代码风格」而在**共享文件**。逐项定规则：

| 冲突面 | 规则 |
|---|---|
| 契约（zod / OpenAPI） | M1 前冻结并打 tag；此后**只准加字段，禁改名**；改契约需单独 PR + 通知所有 session |
| `migrations/` | 序号由 PM 分配（如 `0007_xxx.sql`），**禁止自行 generate**；每人只加新文件；合并后跑 `drizzle-kit check` |
| 队列定义 | 单文件 `queue/definitions.ts`，改动需 review；启动自检 `createQueue` |
| 面板路由表 | `routes.tsx` 一次冻结（7 路径），页面按 `routes/*.tsx` 独占，新页面才动路由表 |
| `packages/shared` | 叶子包，先冻结 JSDoc 契约；改动走专门 PR，其他 session 不排队等它 |
| `queries/` | 只引 `db/schema` 的类型，禁裸字符串列名；`dependency-cruiser` 卡依赖方向 |
| `deploy/` `images/` | 单 owner（S7）；`doctor` 期望值与文件同 PR 改 |
| `docs/` | schema 变更必须同 PR 改文档与 `.github/pi-bot.yml` 示例（CI 校验示例能过 schema） |
| 文案 / 格式化 | 不引 i18n 框架；文案就近放页面；格式化唯一出口 `lib/format.ts`（单 owner） |

---

## 8. 汇报与收敛协议

1. **每个 session 交回 ≤40 行结构化汇报**：产出了什么、关键取舍 3 条、自测结论（贴命令与输出摘要）、还剩什么、阻塞谁。
2. **PM 动作固定**：`status` 看进度 → `result` 取逐字汇报 → `accept` 记录验收结论；未通过则 `send` 回同一 session 复核（不新开 session，避免丢上下文）。
3. **跑偏 / 超时处理**：`cancel` 停掉，把该 session 的产物目录标为未完成，由 PM 决定重派或并入下一 session。**绝不并行起第二个 session 改同一批文件**。
4. **Gate 由 PM 判，不由作者自评**。⛔ 项必须由非作者 session 或我本人在真实环境执行。

---

## 9. 变更控制

| 变更类型 | 批准人 | 流程 |
|---|---|---|
| 契约加字段 | 对应 owner session | 直接加，PR 说明即可 |
| 契约改字段 / 改语义 | PM | 单独 PR + `send` 通知全部 session + 同步本文 §7 |
| 技术选型变更 | PM + 走一遍 `@code-reviewer` | 先改 `tech-plan` 再动代码 |
| 需求变更（`plan.md`） | 需求方 | 设计已冻结，本阶段不受理 |

---

## 10. 当前状态（截至本次提交的快照）

| Session | 主题 | 状态 | PM 验收结论 |
|---|---|---|---|
| S1 | B0 沙箱桥与并发验证 | completed（已按 v1.1 重做） | **通过**：shim 改成 exec.sock 客户端、代码里不再出现 `docker`、代理桩能查表映射容器名；a1 契约 C0–C11 在本机 Git Bash 真跑（C2/C3/C9 因非 Linux SKIP）。同时报出 2 个新缺陷，见 E6/E7 |
| S2 | 契约冻结 | **failed** | **未交付**：`contract-{db,api,envelope}.md` 均未落盘，两轮共 10 条增量仍在队列；会话已失败，需重开一个 session 接手 |
| S3 | 工程骨架与门禁 | completed | **通过**（见 §10.1，PM 自验） |
| S4 | 技术方案修订 | completed（v1.1 + 3 处勘误） | **通过**：E1 `/work` 作废、E2 握手常量、E3 代理最小实现均已落文；修订记录表 11 行（F1–F10 + E1） |
| S5 | B5 RACP 客户端 | **cancelled**（被平台取消） | **未完成**：只有 `schema.ts`、`errors.ts` 雏形，缺 `frames.ts`/`transport.ts`/`client.ts`/`ops.ts` 与全部测试 |

### 10.1 PM 自验证据（不采信自评）

| 命令 | 结果 |
|---|---|
| `pnpm -r typecheck` | exit 0，6 个包全 Done（含半成品的 racp-client） |
| `pnpm -r test` | exit 0，apps/server 13 tests + packages/shared 1 test 通过，其余无测试文件退出码 0 |
| `pnpm lint` | exit 0，0 error；2 warning 落在 `scripts/spike/lib/racp-drive.mjs` |

### 10.2 Gate-0 判定（收口时点）

**conditional pass**：

- ✅ 已闭环：E1 / E2 / E3（S4 落文）；工程门禁四条命令（S3）
- ⛔ 未闭环：**E6**（命令级超时的 `pkill -f` 兜底匹配不到注入的环境变量标记，字面实现下「杀掉该条命令」只剩「销毁容器」一条退路）、**E7**（`cwd` 越界时「回退 job_dir」与「不在映射即 `NO_JOB_MAPPING`」二选一未定）
- 由此：**B7（沙箱代理）/ B13（端到端）不得开工**，直到 E6/E7 落文；B2（数据）/ B5（客户端）/ B9（队列）不受影响，可先做

---

## 11. 决策与勘误记录（PM 裁定）

| # | 事项 | 裁定 | 依据 |
|---|---|---|---|
| E1 | plan §8.1 的 `-v …:/work` 与身份挂载冲突 | **身份挂载优先，`/work` 作废** | 只有路径一致，Bash（容器内）与 Read/Write/diff（宿主）才在同一坐标系 |
| E2 | RACP 绑定常量在两份文档里都缺失（原 §4.2 引用了不存在的 §14a） | `ws://127.0.0.1:<port>/v1/racp/ws`，子协议 `pi-racp.v1.jsonrpc` | SDK 源码 `packages/shared/src/racp.ts:34`（子协议）、`:700`（路径） |
| E3 | `.sh` 行尾 | 加根级 `.gitattributes`：`*.sh`/`*.mjs` → `eol=lf` | `core.autocrlf=true` 会把脚本检出成 CRLF，Linux 上 `bad interpreter: /bin/sh^M` |
| E4 | exec 代理的信任边界（同 uid 进程可对任意 job socket 发 argv） | 作为**已知残余风险**接受，但代理必须最小实现：只收 `argv + cwd`、禁 env 透传、拒 shell 解释、单命令超时与输出长度上限、任务结束立即 `unlink` socket | 同 uid 互不可信无法靠代码解决，只能缩面 + 审计 |
| E5 | worker 镜像 uid 与 worktree 属主 | 统一 `1001:1001`（`pi`），`doctor` 增一条属主断言 | plan §8.1 |
| E6 | 命令级超时的兜底方式（S1 实测发现） | 标记写进**命令行**而非环境变量：`bash -lc "<cmd>" # PI_CMD_ID=<uuid>`，使 uuid 出现在 `/proc/<pid>/cmdline`，`pkill -f PI_CMD_ID=<uuid>` 才能命中；`-e PI_CMD_ID` 降为辅助。理由：`pkill -f` 只看 cmdline，注入 env 等于没有兜底 | S1 复现：扫 `environ` 能命中、`pkill -f` 命中不到 |
| E7 | `cwd` 越界时的行为（S1 发现 §4.5 自相矛盾） | **不回退**：上溯 ≤4 层必须命中 `.pi-bot/exec.sock`，命中但 `cwd` 不在该 job 目录内 → 报 `CWD_OUTSIDE_JOB` 退 3；未命中 → `NO_EXEC_ENDPOINT` 退 2。禁止静默把 cwd 改成 `job_dir`（否则是「悄悄换目录执行」，比失败更危险） | 静默回退会让写回闸门的「编辑路径」判定失真 |

---

## 12. 下一步

1. **重开契约 session**（S2 已 failed，10 条增量在队列里没被消费）：接手者只需写 `contract-{db,api,envelope}.md` 三份文件，brief 可原样复用，增量清单见 §10 与 tech-plan v1.1 §7.2。
2. **重开 B5 客户端 session**（S5 被平台 cancelled）：`packages/racp-client` 里已有 `schema.ts`/`errors.ts` 雏形可复用，缺 `frames.ts`/`transport.ts`/`client.ts`/`ops.ts` 与 mock host 测试；握手常量见 §11 E2。
3. **E6/E7 需回写进 tech-plan**（PM 已在 §11 拍定，文档尚未更新）：由 S4 或下一轮修订 session 落文，落完 B7 才能开工。
4. **并发上限实测为 4 个活跃 session**（S6 的 spawn 被 `LIMIT_EXCEEDED` 挡回）：排程必须按 4 算，S6=B9 队列封装排第一顺位补位。
5. 之后的顺序：B2（数据，等契约）→ B9（队列）→ B6（pi-host 监督）→ B7（沙箱代理，等 E6/E7）→ **B13 单路端到端**（第一个真实事件跑到信封入库、GitHub 零副作用）。
