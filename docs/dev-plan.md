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

---

## 13. 本轮执行计划（v1.2 · PM 调度，2026-06）

> 上文 §0–§12 是 v1.0 的历史快照（Wave 1 的 4 个 session + 评审 + 4 个 Blocker）。本节是**重开的执行计划**：
> 复用已冻结的 `tech-plan` v1.1 与 `contract-skill.md`，把「S2 契约 failed、S5 被 cancel」之后剩下的 B2–B13 + 面板 P0–S7 全部重新排程。

### 13.1 环境事实（实测，不是假设）

| 项 | 实测值 | 对计划的后果 |
|---|---|---|
| OS / shell | Windows 10/11 + PowerShell | 脚本一律 `.ps1`/`node`，shell 脚本只写不跑 |
| Node | **v22.19.0**（`engines` 要求 ≥24，pnpm 仅告警） | 用 tsx 跑 TS；`--experimental-strip-types` 可用 |
| pnpm | 10.9.0，registry = npmmirror | 安装快，但新包可能 ETIMEDOUT 重试 |
| Docker | **有**：Docker 29.4.0，Linux 容器（WSL2 后端） | 容器验收**本机真跑**：`HostConfig` 实参、`docker exec`、超时 kill、OOM、金丝雀网络可达性 |
| PostgreSQL | **有**：容器 `postgres18`（PG 18.3）`127.0.0.1:5432`，`postgres/postgres`；已建专用库 `pi_issue_bot`（开发）与 `pi_issue_bot_test`（测试，可随时 drop） | 迁移、pg-boss、查询、聚合都在真库上验；**不许**再用 mock 冒充「已验证」 |
| Docker socket | Windows 下是命名管道 `//./pipe/docker_engine`（Linux 生产是 `/var/run/docker.sock`） | exec 代理的 socket 路径必须可配置：Linux 用 unix socket，Windows 用命名管道；断言脚本两种都要能跑 |
| `vendor/pi-host` | **不存在**（无 SDK checkout） | RACP 客户端只能对 **mock host** 验证；握手常量按 `tech-plan` §4.2 字面量实现 |

### 13.2 本轮 PM 裁定（新增，编号接 §11 的 E7）

| # | 事项 | 裁定 | 理由 |
|---|---|---|---|
| E8 | 面板契约的单一事实源（`dev-plan` §5 说 `apps/panel/openapi.yaml`，`tech-plan` §8.3 说由 zod 生成） | **单一事实源 = `packages/contract/src/**` 的 zod**；产物 `openapi/pi-bot.openapi.json` 由 `pnpm gen:openapi` 生成并入 git；面板类型只从 `@pi-issue-bot/contract` 取，不手写 DTO，不再有第二份 `apps/panel/openapi.yaml` | 两份契约必然漂移；zod 已是后端校验面，加一份 openapi 就够面板用 |
| E9 | 并行 session 抢 `pnpm-lock.yaml` | **lockfile 归 PM 独占**：所有依赖由 PM 一次预装完；session 一律不得 `pnpm add` / `pnpm install`，缺依赖写进汇报 | 4 路并发装包必然互相覆盖 lockfile 与 node_modules |
| E10 | 并行 session 的 git 写入 | **session 不执行 `git add/commit/push`**，工作树改动保留；每个波次收口后由 PM 统一提交并打波次说明 | 同一 index 并发写必冲突；PM 提交能让「谁改了什么」与波次对齐 |
| E11 | 本机 Docker / PG 可用性（原判「都没有」，已按实测更正） | **Docker 与 PG 都在本机真跑**：容器与数据库相关验收必须在本机执行；只有 `vendor/pi-host` bundle 与真实 GitHub App 凭证两类例外，才标注「需目标机/需凭证」 | 实测 Docker 29.4.0 + PG 18.3；有环境却只交 mock 等于漏验 |

### 13.3 波次与 session 台账（本轮）

并发上限实测 **4 个活跃 session**（插件 `pi.session-orchestrator` 每个 creator 4 个；`LIMIT_EXCEEDED` 见过）。每个 session 独占一组文件，**零重叠**。

| 波次 | Session | 主题 | 文件所有权（只写这些） | 完成判定（DoD） |
|---|---|---|---|---|
| **W1** | A | 契约冻结（B3 + B4） | `docs/spec/contract-{db,api,envelope}.md`、`packages/contract/**`、`packages/envelope/**`、`openapi/**` | 三份契约落盘；zod schema + Ajv 正反例单测通过；`openapi.json` 生成并入 git |
| W1 | B | 数据与队列（B2 + B9） | `apps/server/src/db/**`、`apps/server/src/queue/**`、`migrations/**` | 16 张表 drizzle schema + 首个迁移可离线生成；`idempotency_key`/`failure_class` 优先级/`singletonKey`/定时任务有单测 |
| W1 | C | RACP 客户端（B5） | `packages/racp-client/**` | 帧层/传输/客户端/ops + mock host 测试：binary frame 拒、子协议错、非 loopback 拒、版本不符、`after` 重放、断线拒 in-flight |
| W1 | D | GitHub 层（B12） | `apps/server/src/github/**` | App 认证与 Octokit 工厂（注入式）+ 限流头解析 + 写执行器骨架（隐藏标记纯函数）+ 假 octokit 单测；`no-merge` 断言仍绿 |
| **W2** | E | pi-host 监督与审批（B6） | `apps/server/src/runtime/**` | 子进程监督（退避重启）+ `bootstrap-host` 配对 + 令牌 AES-256-GCM 落库 + 自动审批策略表 + `runWithDeadline` 接入，全部单测 |
| W2 | F | 沙箱执行面（B7） | `apps/server/src/sandbox/**`、`scripts/sandbox-bash`、`images/**`、`deploy/**` | exec 代理（unix socket，查表→docker exec，含容器内 `timeout`）+ exec-client + HostConfig 映射 + 生命周期/水位 + shim（E6/E7 已定稿口径） |
| W2 | G | HTTP 面与仓库配置（B10 + B11 + B12 接入） | `apps/server/src/http/**`、`apps/server/src/config/**` | webhook 原始 body 验签 → 去重 → 入队 + handler 内 10 秒应答 + `/healthz` + 独立 `127.0.0.1:9464` metrics + `.github/pi-bot.yml` schema 校验 |
| W2 | H | 查询面 + 面板壳层（B11 + P0） | `apps/server/src/queries/**`、`apps/panel/**` | 7 条只读查询与 `openapi` 类型对齐；面板 7 路由可达、四态齐备、`format.ts` 六类单测、MSW 拦截 `/api/*` |
| **W3** | I | worker 闭环（B13） | `apps/server/src/worker/**`、`apps/server/src/degeneracy/**` | register→create→subscribe→turn→事件→diff→信封→写执行器全链（依赖注入可测）；三层时间闸 + `failure_class` 落库 + 重复输出熔断 |
| W3 | J | 面板页面 S1/S4/S5/S7 | `apps/panel/src/routes/{overview,costs,quality,system}.tsx` + 各自 `mocks/handlers/*.ts` | 每页数据源 = 契约字段；空/载/错/慢四态；数字格式化只走 `format.ts` |
| W3 | K | 面板页面 S2/S3/S6 | `apps/panel/src/routes/{tasks,task-detail,audit}.tsx` + 各自 `mocks/handlers/*.ts` | 游标分页 + URL 同步；详情三 Tabs；审计 CSV 导出的 blob 下载 |
| W3 | L | doctor + 部署面（B8） | `apps/server/src/doctor/**`、`scripts/doctor*` | 逐项 ok/warn/fail（含 `docker.sock` 归属、PIN 哈希、金丝雀）+ 退出码语义；docker 项标「需目标机执行」 |
| **W4** | M | M1 能力：分类/合规/评论/标签 | `apps/server/src/skills/**`、`workflows/**`（新建） | 技能 frontmatter 校验 + 标签归属（只动自己打的）+ `issue_states` 的 UPSERT/不重复催办 |
| W4 | N | M4 写回闸门与关闭闸门 | `apps/server/src/git/**` | 声明∩实际 + 拒收清单 + 临时 index 组 commit + `close_issue` 四反例单测 |

### 13.4 每个 session 的统一约束（brief 里逐条复述）

1. **只写自己那组文件**；`package.json`（根）、`tsconfig.base.json`、`eslint.config.js`、`vitest.config.ts`、`pnpm-workspace.yaml`、`docs/plan.md`、`docs/tech-plan.md`、`docs/dev-plan.md`、`README.md` 一律只读。
2. 依赖已由 PM 预装（tech-plan §2 全表），**不得 `pnpm add` / `pnpm install`**。
3. 不得 `git add/commit/push`。
4. 交回前必须：`pnpm -r typecheck`、`pnpm -r test`、`pnpm lint` 三条 exit 0；新功能必须带单测。
5. 本机 **有 Docker（Linux 容器）和 PG 18**：容器与数据库相关的东西必须在本机真跑；没有 `vendor/pi-host` bundle，RACP 实机握手除外。
6. 交回 ≤40 行结构化汇报：产出、关键取舍 3 条、自测输出摘要、未完成、阻塞。

### 13.5 本轮之后仍未覆盖（诚实记账）

- **依赖真实凭证的 Gate**：`GitHub 零副作用`（需真 App）、`vendor/pi-host` 实机握手（需 bundle）。Docker / PG 相关 Gate 现在都能在本机跑，不再算「需目标机」。
- `vendor/pi-host/<version>/` 尚未 vendored（需要一次显式 PR 拉 bundle + `PIN.json`）。
- M3 的改回检测（reconcile）与 M4 的 push/开 PR 真实链路依赖真实 GitHub App 安装，本机只到「注入式可测」。

### 13.6 PM 自验记录（Wave 1 收口）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm -r typecheck` | exit 0（6/6 包 Done） |
| 单测 | `pnpm -r test` | exit 0：server 165 / racp-client 86 / contract 37 / envelope 27 / shared 1，全通过 |
| 静态门禁 | `pnpm lint` | exit 0（0 error；6 warning 全在既有 `scripts/spike/*.mjs`） |
| 真库迁移 | `migrate(pool, migrations/)` 对 `pi_issue_bot_test` | `{"applied":["0000_init"],"skipped":[]}`；重跑 → `applied:[] , skipped:["0000_init"]`（幂等成立） |
| 表结构 | `information_schema.tables` | 17 张 = 16 张业务表 + `schema_migrations` |
| 队列 | `pg-boss.start + ensureQueues + registerSchedules` | `pgboss.queue` 6 条（`run-task`/`queue-gate`/`lifecycle-cleanup`/`metrics-rollup`/`reconcile`/`retention-cleanup`）；`pgboss.schedule` 5 条 cron（`* * * * *`×2、`10 0 * * *`、`0 * * * *`、`40 0 * * *`） |
| 契约产物 | `openapi/pi-bot.openapi.json` | 9 paths / 35 schemas；二次生成哈希一致 |

### 13.7 执行记录（波次收口，PM 自验）

四波、16 个 `pi.session-orchestrator` 会话，文件所有权零重叠，未发生抢改。会话 ID 保留在 `SessionTask` 台账里，可 `send` 回同一会话继续。

| 波次 | 会话 | 切片 | 结果 |
|---|---|---|---|
| W1 | `19d53c37` | A 契约冻结（B3+B4） | completed：三份契约 + zod/Ajv + `openapi.json` |
| W1 | `abbb97ac` | B 数据与队列（B2+B9） | completed：16 表 + `0000_init` + pg-boss 封装 |
| W1 | `78a4f4c4` | C RACP 客户端（B5） | completed：86 测试（二进制帧/子协议/断线/游标） |
| W1 | `a8a6545d` | D GitHub 层（B12） | completed：认证/工厂/限流/六动作骨架 |
| — | PM | `packages/shared` | 补位：logger + 值级脱敏 + `runWithDeadline` + `AppError` + Result（30 测试），解掉 runtime/http 的跨会话依赖 |
| W2 | `67b94442` | E pi-host 监督（B6） | completed：PIN 钉扎/AES-GCM/退避重启/审批矩阵/turn-driver |
| W2 | `e97aba18` | F 沙箱执行面（B7） | completed：HostConfig/exec 代理/shim/生命周期；**真容器 10 通过 1 跳过**（含 `State.OOMKilled`） |
| W2 | `5e5ca30d` | G HTTP 面（B10+B11） | completed：webhook 九步 + handler 内 10 秒应答 + 独立 metrics + CLI 接线 |
| W2 | `431a703f` | H 查询层 + 面板 P0 | completed：8 查询（真 PG）+ 7 路由壳 + 四态 + `format` 单测 |
| W3 | `d9ab1fb3` | I worker 闭环（B13） | completed（一次 `NETWORK_ERROR` 后 `send` 续跑并修完 `tsc`/lint） |
| W3 | `59862123` | J 面板 S1/S4/S5/S7 | completed：4 页 + 4 handler + 13 测试 |
| W3 | `a8ea243e` | K 面板 S2/S3/S6 | completed（同上，`send` 续跑）：列表游标/URL 同步、详情三 Tabs、CSV 导出 |
| W3 | `286c1f82` | L doctor（B8） | completed（同上，`send` 续跑）：13 项三态，真跑 7 ok / 4 warn / 1 fail |
| W4 | `0a756e00` | M 技能与 M1 工作流 | completed：技能校验/命令鉴权/triage/compliance/close 闸门 |
| W4 | `6d67ac08` | N git 与写回闸门（M4 ⛔） | completed：真 bare 仓库验 4 条反例（未声明改动/工作流篡改/hook/逃逸路径） |
| W4 | `dce712d3` | O 聚合与对账作业（M3） | completed：`metrics_daily` 幂等 UPSERT、7 天对账、90 天保留、生命周期清扫 |
| W4 | `d6c1212c` | P 装配与端到端 | completed：`createApplication` + `serve` 接线 + 4 条 e2e（真 PG + 假 host + 假 GitHub） |

**PM 最终自验（2026-06，本机）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm -r typecheck` | exit 0（6/6 包） |
| 单测 | `pnpm -r test` | exit 0：**server 66 文件 / 717 通过 / 2 跳过**；panel 66；racp-client 86；contract 37；envelope 27；shared 30 |
| 静态门禁 | `pnpm lint` | exit 0（0 error；6 warning 均为既有 `scripts/spike/*.mjs`） |
| 面板构建 | `pnpm --filter @pi-issue-bot/panel build` | exit 0（714 modules） |
| 真库迁移 | `migrate()` 对 `pi_issue_bot_test` | `0000_init` 应用成功；重跑 `applied=[]`（幂等） |
| 队列 | `pg-boss` 真启动 | 6 队列 + 5 条 cron |
| 真容器 | `test/sandbox-docker.test.ts` | 10 通过（只读根 fs、身份挂载 `pwd`、内存上限、`timeout` kill、**OOMKilled**） |
| 端到端 | `test/e2e-*.test.ts` | 5 用例通过：`actions` 0 行、**非 GET 调用计数 = 0**、同一 delivery 20 次仍 1 行 |

**两次失败与处理（不掩饰）**

1. W3 的 I / K / L 三个会话在同一时段返回 `NETWORK_ERROR`（provider 侧断流），产物已落盘但有自有文件缺陷（`consistent-type-imports`、未使用变量、`runTask` 返回类型缺 `sessionId/turnId`）。按 §8.3 用 `send` 回同一会话续跑修完，未新开会话、未抢文件。
2. `test/sandbox-shim.test.ts` 在一次**并行跑测试**时失败，单独复跑与整跑复验均通过——原因是多个会话的测试在争同一台机器的临时目录/进程。**结论：验收门禁必须串行执行，不要在被调度会话跑测试的同时跑整仓测试。**

**仍未覆盖（与 §13.5 一致，不新增）**：`vendor/pi-host` bundle、真实 GitHub App 凭证、目标机 nftables、面板 OAuth。

### 13.8 追加需求：模型端点对接标准 OpenAI / DeepSeek / MiMo 接口（PM 补记）

需求方明确「API 会对接标准 openai or DeepSeek mimo 接口」。按 §9 的变更控制（技术侧小改，不重开设计），本轮落到三处，均在既有边界内：

| 改动 | 落点 | 为什么这样切 |
|---|---|---|
| 配置层 | `apps/server/src/app/config.ts` 新增 `AppConfig.model`：`PI_BOT_MODEL_BASE_URL` / `PI_BOT_MODEL_NAME` / `PI_BOT_MODEL_API_KEY`，兼容别名 `OPENAI_*` / `DEEPSEEK_*`；base URL 规范化（去尾 `/`、拒 query/hash、只收 http(s)）；**配了 key 没配模型名即启动失败** | 换供应商只改环境变量；不实现 provider 客户端——pi-host 自己说 OpenAI 兼容协议 |
| 传递层 | `apps/server/src/app/model-env.ts`：白名单方式把三个值以「我们自己的名字 + `OPENAI_*` 标准名」交给 pi-host（`HostSupervisor.extraEnv`） | 只给需要的变量，不灌整个 `process.env`；key 停在可信侧（bot + pi-host），不进容器 |
| 预检层 | `doctor` 新增第 13 项 `model-endpoint`：`GET <base>/models`（8s 超时，不烧 token）；未配 → `warn`，2xx → `ok`，模型名不在列表 → `warn`，401/403/404/网络错误 → `fail` | 同时验「端点可达 + 凭证被接受」；`/models` 是各家兼容端点都实现的最小只读面 |

**自验**：`apps/server/test/app-model-endpoint.test.ts`（9 例，含别名优先级 / 归一化 / 启动失败 / 脱敏摘要 / `hostModelEnv` 映射）与 `test/doctor-model-endpoint.test.ts`（8 例，200/缺模型名/401/404/网络错误/未配置），`doctor-report.test.ts` 的检查清单同步为 13 项。三条门禁仍全绿（server 734 通过 / 2 跳过）。

**没做的**：不内置任何厂商默认值（不猜端点）、不做多模型路由与 fallback、不在面板上暴露模型配置（面板只读，改配置走 `EnvironmentFile`）。

### 13.9 真实凭证接入（浏览器操作，2026-11-10）

需求方给了模型的接入信息，并要求在浏览器里创建 GitHub App 与测试仓库。记录实际操作与结论（密钥一律不入库）：

| 项 | 结果 |
|---|---|
| 模型端点 | `https://platform.aimom.net/v1` + `deepseek-v4.1-flash`；`GET /v1/models` 实测返回 `deepseek-v4.1-flash`、`glm-5.3-flash`，正是 `doctor` 第 13 项 `model-endpoint` 的探测方式 |
| GitHub App | 名称 **pi-issue-bot-tioit**，App ID **5690173**，拥有者 `Tioit-Wang`，仅安装到本账号 |
| App 权限 | Repository：`contents=write`、`issues=write`、`pull_requests=write`、`checks=read`、`metadata=read`（强制）；Organization：`members=read`。**未申请** `administration`、`workflows`（tech-plan §5.2：能改 CI 等于能绕过必需检查） |
| App 事件 | `issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`push`、`check_run` |
| App webhook | **未启用**（还没有公网入口，开着只会让 GitHub 记投递失败）；创建时填的 `https://example.com/…` 只是通过表单校验的占位，装好 Caddy 后改成真实 `/webhook` 并设 secret |
| 私钥 | 已通过浏览器生成并下载，移到 `~/.pi-desktop/scratch/<session>/secrets/`（**仓库之外**）；`deploy/env.example` 只留路径占位 |
| 测试仓库 | **Tioit-Wang/pi-issue-bot-test**（private，带 README）→ https://github.com/Tioit-Wang/pi-issue-bot-test |

**代码侧同步（本轮新增）**：`AppConfig.github` 增加 `appId` / `privateKeyPath` / `installationId`；新增 `app/github-auth.ts::resolveGithubAuth`——三件齐全走 App 认证（`createInstallationTokenProvider`），只配一半记 `degraded` 并点明缺哪项，否则退回 `PI_BOT_GITHUB_TOKEN`，都没有则 `none`。私钥只在启动时读一次，读不到/不是 PEM 直接 `ConfigError`；`describeAppConfig` 不输出私钥路径。

**踩坑记录**：① Edge 142 默认禁止对默认配置开远程调试（Chromium 136+ 的安全限制），且 App-Bound Encryption 让 cookie 无法拷到别的配置目录——最后按需求改用 Chrome（用户手动登录）。② `@octokit/auth-app` 的 strategy 必须显式 `type:'installation'`，否则每个请求都会 `Invalid auth type: undefined`；③ 单测里用假 PEM 会让 auth-app 抛 `ERR_OSSL_UNSUPPORTED` 变成 unhandled rejection——改用 `generateKeyPairSync` 生成的真 RSA 私钥。

### 13.10 实跑结论（本机，2026-11-10）

不是「看代码猜」，是把服务真拉起来打的：

| 验证 | 结果 |
|---|---|
| 三条门禁 | `typecheck` 0 / `lint` 0 error / `test` 全绿（server 69 文件 743 通过 2 跳过、panel 66、shared 30、contract 37、envelope 27、racp-client 86） |
| `pi-bot migrate` | 对 `pi_issue_bot` 应用 `0000_init` **成功**；重跑 `applied:[] skipped:[0000_init]`（幂等） |
| `pi-bot serve` | 真启动：pg-boss 建 6 队列 + 5 条 cron，`run-task` worker 注册，HTTP 3000 / metrics 9464 |
| `/healthz` | 200：`db ok（select 1）`、`queue.runTask ok`、`doctor skip（未接）` |
| `/metrics`（9464） | 200，prom-client 指标可抓 |
| `/api/overview` 未登录 | 401（面板会话缺失，符合契约） |
| `POST /webhook` 无签名 | 401（验签生效） |
| `POST /webhook` 带 HMAC | 首次 200 `action=ignored`（仓库未同步配置）；重复投递 `duplicate=true`，`webhook_deliveries` 仍 1 行 |
| 播种 `repos` 后再投 | 200 `action=enqueued`、返回 `taskId`、`tasks` 1 行、pg-boss 出现 `run-task` job；`dry-run` 跳过 reaction（零 GitHub 写） |
| worker 执行 | `run-task` 失败于 `HOST_UNAVAILABLE`（未 vendored pi-host bundle）——**符合预期**，是唯一挡住「完整链路」的东西 |

**这一轮修掉的**：`migrate`/`replay` 只认 `PI_BOT_DATABASE_URL`，而 `serve` 优先 `PI_BOT_PG_DSN`；只设新名会出现「服务能起、迁移报缺变量」。已让 `readDatabaseUrl` 同时认两个名字（新名优先）并加回归测试。

**这一轮发现、尚未修的**（记在案，避免下次重踩）：
1. **失败不落 `runs` 行**：`HOST_UNAVAILABLE` 这类在 run 创建之前就失败的路径，只在 pg-boss job 的 `output` 与日志里，`runs`/`run_events` 是空的、`tasks.status` 停在 `queued`。这违反 plan §10「每个失败都有分类」——应在 orchestration 包装层 catch 后补一条 `runs`（outcome=failed + failure_class）并推进 task 状态。
2. **契约文档与迁移漂移**：`contract-db.md`（W1-A）给 `tasks` 补了 `outcome/failure_class/cost_usd/dry_run/started_at`，但 `0000_init.sql`（W1-B，并行产出）没有这些列。查询与面板都按迁移走所以测试全绿，但文档多承诺了 5 列；下一轮需要一次迁移（序号落在 0000–0099 段）把列补齐或把文档改回。

---

## 13.11 真实链路打通（2026-11-10，Windows 本机 + 真 pi-host v0.22.0）

§13.10 记的「唯一挡住完整链路的东西」已经不在了：**bundle 拿到了、握手通了、agent 真的跑了 turn、GitHub 写真的发生了**。这一节只记事实与它带来的改动。

### 13.11.1 bundle 从哪来（可复现）

| 产物 | 来源 | 校验 |
|---|---|---|
| `pi-host.js` / `agent-runtime/` / `install.sh` / `SHA256SUMS` | 上游发布物 `vastsa/PI-Desktop@v0.22.0` 的 `pi-host-0.22.0-linux-x64.tar.gz` | 与同目录 `.sha256` 一致（`bd841667…ab823`） |
| `bin/pi-desktop-host-core.exe` | 本机已安装的 PI-Desktop 0.22.0（`resources/bin`） | 版本与 bundle 同为 0.22.0；`PIN.json` 记它的哈希 |
| `PIN.json` | 本次手写：`hostVersion=0.22.0`、`wsPath=/v1/racp/ws`、`wsSubprotocol=pi-racp.v1.jsonrpc`、三份产物的 sha256 | `verifyPin` 通过（`bootstrap-host` 第 0 步） |

**上游只发 POSIX 目标**（`bundle.mjs` 的 `platform` 白名单就是 linux/darwin）。Windows 开发机因此用「Linux bundle 的 JS + 桌面安装里的 win32 host-core」，清单里每份产物各自钉哈希——不是「假装它是 Windows bundle」。

### 13.11.2 Windows 启动适配：`runner.json`（唯一的生产代码新增）

`bin/pi-host` 是 `#!/bin/sh` + `exec node pi-host.js`：Windows 不认 shebang，也不接受无扩展名的非 PE 文件，`spawn('…/bin/pi-host')` 直接 `ENOENT`。改法是把「怎么启动」做成 bundle 里的数据：

```
<bundleDir>/runner.json   { "command": "node.exe 绝对路径", "args": ["pi-host.js"] }
```

- `runtime/pin.ts::resolveBundleCommand()` 读它，相对路径按 bundleDir 解析，`-` 开头的参数原样保留；**没有 `runner.json` 时行为与 §2.2 完全一致**（`bin/pi-host`），Linux 生产一行都不改。
- `HostSupervisor` 新增 `prependArgs`（排在 `buildHostArgs` 之前），`compose` 与 `bootstrapHost` 都改用 `resolveBundleCommand`。
- `runner.json` 不放松任何安全约束：哈希校验仍在 `PIN.json`。

### 13.11.3 实测修掉的契约漂移（6 条：按文档字面量写的客户端撞上真 Host）

| # | 现象 | 真实契约（v0.22.0） | 改动 |
|---|---|---|---|
| 1 | `INVALID_ARGUMENT: invalid connection/initialize params` | 必须带 `{protocolVersion, client{name,version}, bindings:["RACP-WS"], capabilities}` | `client.ts` 补齐四件；新增 `RACP_CLIENT_NAME/VERSION` |
| 2 | `project/register 未返回 projectId` | 返回 `{ project: { id, … } }` | `ops.ts::projectRegister` 两种形状都接受 |
| 3 | `invalid params: must be object` | `events/subscribe` 的 `scope` 必填；`after` 只收 `{epoch,sequence}`（传 `0` 非法） | 恒发 `scope:'session'`；数字 `after` → 不发 |
| 4 | 同上（换到 turn/start） | `turn/start` 必须带 `context.requestId` | `ops.ts::turnStart` 补 `context` |
| 5 | **静默无事件**（turn 一直等到 20min 超时） | 事件推送方法是 `session/event`，不是 `events/event` | `EVENT_NOTIFICATION_METHOD` 改默认值；e2e 夹具同步 |
| 6 | `workspace/diff 未返回 diff 字符串` | `workspace.diff()` 原样返回，没有 `diff` 字段 | 取 `diff/patch/unified/text`，`files` 拼接；`{files:[]}` → 空 diff |

两条是**能力缺失**而不是形状不符：

- `session/archive` 被注册成 `unavailable("session archival")` → 归档失败不再算任务失败（只记 warn）。
- `provider-import`（给 host-core 装模型端点）走 **POSIX-only admin socket**：`prepareAdminDirectory()` 在 win32 直接 `ADMIN_UNAVAILABLE`。本机做法是把桌面上已配好的 provider 行与 `.machine-key`/`*.bin` 放进 host 的 data dir；Linux 生产用 `pi-host provider-import --data-dir …`（payload 已按上游 `provider-sync.ts` 的严格校验构造通过）。

### 13.11.4 `serve` 装配缺口（之前从没真跑过，所以没暴露）

1. **设备令牌没接进 RACP 端口**：`createSupervisorHostPort()` 只取 READY 行的 `pairing.token`，常驻 Host 没有 `--pair` 行 → `RACP_TOKEN_MISSING`。已加 `options.token`，`compose` 传 `PI_BOT_HOST_TOKEN`。
2. **真实检出没装配**：`createWorkerPorts()` 默认注入「明确失败」的 `WORKTREE_UNAVAILABLE`，`git/` 的 `createRepoWorktreePort` 一直没人接。已在 `compose` 装配（`RepoCache` + `git worktree add --detach`）；私有仓库认证走 remote URL 的 `x-access-token`，token 只在该闭包里。
3. **`@` 句柄写死**：`COMMAND_MENTION_PATTERN` 硬编码 `@pi-bot`，而 slug 由 App 名字决定（本次 `pi-issue-bot-tioit`）。文档 §6.4 只规定「`@机器人 /命令`」，所以句柄必须是配置：新增 `PI_BOT_MENTION`（默认 `pi-bot`），`webhook.ts` 用 `commandMentionPattern(handle)`，`WebhookDeps.mention` 由装配层传。

### 13.11.5 实跑结论（可复现）

| 场景 | 结果 |
|---|---|
| `bootstrap-host`（PIN → spawn → READY/PAIRING → WS → `connection/pair` → 令牌入库） | 六步全通，`hostVersion=0.22.0` |
| `serve` 启动 | `/healthz` 200、`/metrics` 200、6 队列 + 5 cron、`githubAuthMode=app`（installation 180374996） |
| `gh webhook forward` → `/webhook` | 真事件直达本地：`issues.opened` → `auto:triage` 入队 + eyes reaction；`issue_comment` 带 `@pi-issue-bot-tioit /issue-triage` → 命令任务入队 |
| `auto:triage`（issue #8） | **agent 在容器内真跑了工具、产出合法信封**：issue 被打上 `bug`+`needs-info` 并收到中文分析评论 |
| `auto:triage`（issue #10） | turn `completed` 但没有可校验信封 → `run.outcome=failed`、`failure_class=parse`。**不是链路问题，是 skill/prompt 对「必须输出 JSON 信封」的约束还不够硬** |

### 13.11.6 仍然没做（与 §13.5 同一口径）

- **worker 的 GitHub 写面仍走 `PI_BOT_GITHUB_TOKEN`**：`worker-deps.ts` 只看 `config.github.token`；App 认证已接在 webhook ack 与 `compose` 的客户端上，worker 侧还没切到 installation token。
- skill/prompt 需要对「信封必须输出」做一轮收口（issue #10 即证据）。
- 面板 OAuth 未接（`/api/*` 恒 401）；生产 webhook 需要公网入口（本机是 `gh webhook forward`）。
- 本机磁盘水位 93% > 85%：`lifecycle-cleanup` 会按水位销毁容器，长任务与它抢容器是常态。
