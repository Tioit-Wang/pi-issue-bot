# 技术方案 · v1.1

> 状态：技术方案 **v1.1**（可开工）。v1.0 定稿后经一次对抗性评审，5 处 Blocker + 4 处 Major + 1 组 Minor 已落文，见下方「修订记录」。
> 设计事实源是 [`docs/plan.md`](plan.md) v0.4，本文只回答「怎么实现」，不重开设计问题。
> 文中所有版本号取自 2026-05 实际 registry / Go proxy 查询结果；标注「已验证」的 SDK 行为来自本机 PI SDK 源码与规范原文。

---

## 修订记录（v1.0 → v1.1）

v1.0 是「可讨论」的版本：结构完整，但一次对抗性评审挑出 5 处 Blocker（F1–F5）、4 处 Major（F6–F9）与 1 组 Minor（F10）。v1.1 把它们逐条落进正文；每行都附一句「怎么确认」，PM 验收时按那一列 grep 即可，不必读全文。

| 编号 | 原问题（一句话） | 改成了什么 | 影响节号 | 怎么确认这条改了 |
|---|---|---|---|---|
| **F1** | shim 被写成转发 `docker exec`，但它属于 pi-host 进程树，于是 docker socket 既「只在 bot」又在 pi-host 下，plan §8.4 红线 1 名存实亡 | shim 不再碰 docker：改为连 bot 持有的 unix socket exec 代理（`<job_dir>/.pi-bot/exec.sock`，`0600`，从 `$PWD` 上溯最多 4 层，找不到即 `NO_EXEC_ENDPOINT` 退出非零）；容器名改由代理查 bot 内存里的「job → 容器名」映射，不再由 `pwd -P` 的 sha1 推导 | §0 §2.2 §3.1 §3.2 §3.3 §4.5 §6.1 §8.2 §12 | 搜 `/var/run/docker.sock`：只落在「bot 持有」或「明确说它不在 pi-host」的句子里；搜 `sha1sum`：只剩本表这一处；§4.5 的 shim 代码里没有任何 `docker` 命令调用（只有一句注释声明它不接触 docker） |
| **F2** | 身份挂载让容器内写入直接落到 worktree（`postinstall` 可改任意文件含 `.git` 指针），而写回只校验 `actions` 声明、不校验字节 | 新增 §5.6「写回闸门」：推送集 = `envelopes.actions` 声明路径 ∩ agent 实际编辑路径；`.git/`、`.github/workflows/**`、`.gitmodules`、hooks 目录一律拒绝；git 一律 `-c core.hooksPath=/dev/null --no-verify`、禁 submodule 递归；比对结果入审计，越界即 `writeback_rejected` 并丢弃 | §2.3 §4.5 §5.4 §5.5 **§5.6（新）** §7.2 §12 | §5.6 存在；§12 的 M4 行明写「写回闸门未通过 = 阻断项」 |
| **F3** | 单命令超时 `timeout -s KILL 310` 在宿主侧，容器内进程继续跑：agent 超时后发下一条命令，两条命令同写一个 worktree，容器继续吃 2 CPU / 2 GB 到任务级超时 | 超时下沉进容器：代理执行 `docker exec -i -w <dir> <c> timeout -s KILL <n> bash -lc "<cmd>"`；宿主侧再加一道 `docker exec <c> pkill -KILL -f "PI_CMD_ID=<uuid>"` 兜底；任务取消/超时直接销毁容器（容器死 = 进程树死） | §4.5 §4.7 §6.3 | §4.7 的「实现」列不含宿主侧 `timeout`（只有容器内 `timeout` + `pkill` 兜底）；字面量 `timeout -s KILL 310` 只剩 §4.7 问题陈述里的那一处引用 |
| **F4** | 数据模型缺 `issue_states`：既存不了「缺失项集合」也存不了「最近一次人工回复」，plan §6.2 的「只在缺失项集合变化时再回复」与 §7 的「48h 未变 + 无人回复」都不可判定 | §7.2 新增 `issue_states(repo, issue_number, missing_set_hash, first_seen_at, last_human_reply_at, last_nudge_at, closed_at)`，写明 UPSERT 时机；关闭判定**只读这张表** | §5.4 §7.2 | §7.2 有 `issue_states` 行 + 一段 UPSERT / close 判定说明；§5.4 的 `close_issue` 行只引用它 |
| **F5** | `pg-boss expireIn` 是 job 存活/active 时长语义，不是「排队等了多久」；且 plan §6.4 要求 10 秒内回应，而排队中的 worker 根本没执行，回不出来 | 10 秒应答移到 **webhook handler 内**（入队成功即打 eyes reaction / 一行确认，不依赖 worker）；排队闸门改成**定时任务**扫 `tasks.status='queued' and now()-queued_at > 10min` → 发「排队过长」评论 + `boss.cancel()`；`expireIn` 只做执行期硬上限 | §3.4 §4.7 §5.3 §7.2 §12 | §5.3 的第 8 步是「handler 内打 reaction」；§4.7 第三行写的是定时任务扫描，不是 `expireIn` |
| **F6** | 任务级超时会 kill 容器，与「容器崩溃」不可区分，于是超时任务被自动重试，违反 plan §9.1 | §7.3 增加 `failure_class` 优先级表（`timeout`/`interrupt`/`degenerate` > `sandbox-oom` > `sandbox-crash` > 其它），重试决策只读最高优先级类；OOM 由容器 `State.OOMKilled` 显式判定，且在销毁前采集 | §3.6 §7.3 | §7.3 有序号化优先级表；OOM 判定写着「销毁前 `inspect`」 |
| **F7** | 评论隐藏标记含 task id，事件重算 / `/retry` / 超时重跑都会生成新 taskId，搜不到旧标记就重复评论 | 标记改为 `<!-- pi-bot:<repo>#<target>:<intent>:<body-hash> -->`（不含 task id），去重只比对 target + intent + body-hash | §5.4 | §5.4 的 `comment` 行标记里没有 `task` 字样 |
| **F8** | `racp.schema.json` 与 pi-host bundle 是跨仓库输入，本仓库只有 `docs/`，而 M0 第一行代码就要读它，却没有来源与钉扎规则 | fixture 与 bundle 一起 **vendored 进仓库**：`vendor/pi-host/<version>/`，同级 `PIN.json` 记 `SHA256 + hostVersion`；`doctor` 与启动自检校验；升级走显式 PR | §2.2 §4.1 §4.2 §6.4 §11（R10） | §2.2 与 §4.1 都出现「契约与 bundle 钉扎」；§6.4 有 vendor 版本一致性检查项 |
| **F9** | `tasks` 缺 `command` 与 `actor_login`，`/api/costs` 的按命令拆分、`/api/quality/reverts` 的按命令分组、`/api/audit` 的「谁触发」只能解 jsonb | §7.2 补 `command`、`actor_login`、`queued_at` 三列，入队时从 payload 抽出写死；并写明 `idempotency_key` 的生成规则 | §5.3 §7.2 §8.3 | §7.2 的 `tasks` 行同时含这三列，且下一段给出 `idempotency_key` 的组成公式 |
| **F10** | 十处小账：`/metrics` 与 `/api` 同实例暴露公网、值级脱敏前缀不全、面板会话有两处说法、`metrics_daily` 无法幂等重算、`idempotency_key` 无生成规则、四个 RACP operation 白维护 | 逐项见 §2.1 / §4.4 / §7.2 / §7.6 / §10.1 / §10.2 / §11 R3 | 同左 | §10.1 有 `127.0.0.1:9464`；§10.2 前缀含 `github_pat_`/`gho_`/`ghr_`/`eyJ`/`-----BEGIN`；§7.6 有 `UNIQUE(day,repo,outcome)` + UPSERT |
| **E1** | plan §8.1 的 `-v …/work:/work` 与 §4.5 的身份挂载冲突：一处说容器内是 `/work`，另一处说容器内路径 = 宿主路径 | PM 裁定**身份挂载优先，`/work` 作废**：容器内路径 = 宿主路径，`Binds = [<job>:<job>:rw]`、`WorkingDir = <job>`；Dockerfile / 脚本 / 文档一律不得再引用 `/work` | §4.5（E1 勘误块）§6.1 | 搜 `/work`：只剩 5 处，全在「说明它作废」的句子里（本表 E1 行、表下勘误段、§4.5 勘误块、§6.1 注解），没有任何一处把它当挂载点 |

两处评审未点名、但原文自相矛盾的交叉引用也一并修正（不修会让上面的修订互相打架）：§3.6 把 OOM 分类从 `sandbox` 细化为 `sandbox-oom`（与 F6 对齐）；§3.4 的崩溃恢复不再把 `expireIn` 当「队列重投」用（与 F5 对齐）。

PM 验收后又落了三处勘误，其中只有一处涉及方案取舍、需要进表（**E1**，plan §8.1 的 `/work` 与身份挂载冲突）；另外两处是补事实与补边界，直接写进正文而不占表行：**E2** 把 §4.2 的 `Sec-WebSocket-Protocol: <见 §14a>` 换成字面量路径 `/v1/racp/ws` 与子协议 `pi-racp.v1.jsonrpc`，并让这两个常量随 `PIN.json` 校验；**E3** 把 exec 代理的「最小实现」写成 §4.5 第 5 条验收项（那条信任边界本身不消除，只是写清并被验收覆盖）。

## 0. 结论摘要

| 问题（plan §13 点名要答的） | 结论 |
|---|---|
| 后端语言 | **Node 24 + TypeScript**（否决 Go，理由见 §1） |
| Web 框架 | Fastify 5 + zod 4，zod-first 生成 OpenAPI 3.1 |
| 队列与持久化 | **单个 PostgreSQL 16+**；队列用 pg-boss 12（不引入 Redis） |
| agent 调用方式 | **RACP-WS**（JSON-RPC over loopback WebSocket），pi-host bundle 作子进程 |
| 命令进容器 | `PI_DESKTOP_BASH` 覆盖 + POSIX shim → **bot 持有的 unix socket exec 代理** → `docker exec`（§4.5）。shim 与 pi-host 都不接触 docker socket |
| GitHub App 集成 | Octokit 5 + `@octokit/auth-app` + `@octokit/webhooks`（不用 Probot） |
| 容器编排 | Docker Engine API（dockerode 5）；生命周期策略自研 |
| 面板 | React 19 + Vite 8 + Tailwind 4 + shadcn/ui + Recharts + TanStack Query |
| 部署形态 | 单机：systemd 跑 bot 二进制，docker compose 跑 Postgres，Caddy 做 TLS 反代 |

自研总量约 **1450–1850 行**（RACP 客户端 ≈400、熔断与重试映射 ≈200、容器策略 ≈300、重复输出检测 ≈200、exec 代理与客户端 ≈150、写回闸门 ≈100、shim ≈25、doctor ≈170），其余全部用成熟库。比 v1.0 多出的 ≈250 行来自 F1 的 exec 代理与 F2 的写回闸门——这两处是「已有库的语义对不上」，不是「想自研」。

---

## 1. 语言选型：Node 24 / TypeScript（否决 Go）

### 1.1 决定性理由

1. **Node 本来就在目标机上，Go 省不掉运行时。**
   pi-host 的发行物自身就是 Node 程序：bundle 内含 Node ≥22 运行时、`sidecar.js`、Rust `host-core` 二进制（`apps/pi-host/scripts/bundle.mjs`，已验证）。选 Go 不是「少一个运行时」，而是「多一个运行时」。

2. **RACP 的权威契约是 TypeBox schema，用 Go 等于手工重抄一遍。**
   规范 §14.5 原文：typebox schema 是契约的单一来源，JSON Schema fixture、文档表格都由它生成，「手工维护的第二份契约是缺陷」。现成的产物是 `packages/shared/fixtures/racp.schema.json`（53 KB，23 个资源 schema，已验证）。用 Go 写客户端意味着把 30 个 operation 的请求/响应信封、事件信封、审批结构用 Go struct 再抄一次；而 Host 侧有 `HOST_VERSION_MISMATCH` 的严格版本对齐（ADR 0327），抄错字段只会在生产里变成运行时错误。

3. **握手与连接生命周期已有实现，且跑过 conformance。**
   设备令牌（`pdt1.` / `ppt1.` 前缀）、`Authorization: Bearer`、子协议校验、binary frame 拒绝、非 loopback 拒绝、`after` 游标重放、断线时 in-flight 调用以 `HOST_DISCONNECTED` 拒绝且不重发、`connection/pair` 单次消费——这套逻辑在 `packages/racp` 有测试覆盖（ADR 0285）。自己重写这部分是纯风险、零收益。

4. **GitHub App 的参考实现在 TS。**
   Octokit 是 GitHub 官方客户端。Go 的 go-github + ghinstallation 质量也够，但安装令牌缓存、webhook 验签、GraphQL 分页、限流头解析这些语义仍要重学一遍。

5. **面板与后端共享同一份契约。**
   zod 定义一份 → 后端校验 + OpenAPI 生成 + 面板 TS 类型 + 前端表单校验，零手工同步。

### 1.2 与 Go 方案的代价对照（诚实记账）

| 维度 | Go | Node/TS | 判断 |
|---|---|---|---|
| 部署体积 | 单二进制 ~20 MB | Node 24 + node_modules ~120 MB | Go 优；但 pi-host 已需 Node，**抵消** |
| 常驻内存 | ~30 MB | ~150 MB | 单机 2–4 并发下不构成压力 |
| 队列成熟度 | River（PG 原生，事务入队） | pg-boss 12（PG 原生，重试/延迟/dead-letter） | 平手 |
| RACP 客户端 | 从零实现 + 手工跟随 schema | 复用 fixture + 少量封装 | **Node 胜** |
| 结构化校验 | validator tag，表达力一般 | zod + JSON Schema，可复用 SDK 产物 | **Node 胜** |
| 与 SDK 版本耦合 | 跨栈，靠人盯 | 同生态，同语言 | **Node 胜** |
| 三层时间闸 | `context` 原生优雅 | `AbortSignal` + 显式 race | Go 小胜 |
| 进程崩溃半径 | 单线程 goroutine 隔离好 | 单线程，需拆进程兜住 | Go 小胜 |

结论：Go 只赢在两个小分（取消语义、单进程并发），却在「RACP 客户端」这一条上吃了大亏。**选 TypeScript。**

代价要写清楚，后文对应处理：

- TS 没有 `context` 的层级传播 → 用 `AbortSignal` + 一层 `runWithDeadline()` 包装器（§4.7）。
- 单线程下 CPU 密集操作会卡住全部请求 → 重复输出检测限制在窗口级流式扫描（≤200 字符环），且不阻塞事件循环超过 5 ms。
- 单进程崩溃半径 → agent 在 pi-host 子进程，任务是持久化的，bot 崩溃由 systemd 重启 + 队列恢复兜住（§3.4）。
---

## 2. 技术选型总表

标注 `库` = 直接用成熟开源库（不自研）；`自研` = 无合适库或库的语义不匹配；`胶水` = 库之上很薄的适配代码（≤100 行）。

### 2.1 控制面

| 组件 | 选型 | 版本 | 归属 | 说明 |
|---|---|---|---|---|
| HTTP 服务 | Fastify | 5.12 | 库 | 单进程、schema 校验、插件生态完整 |
| 请求/响应契约 | zod + fastify-type-provider-zod | 4.6 / 7.0 | 库 | zod 一份定义 → 校验 + OpenAPI |
| OpenAPI 生成 | @fastify/swagger | 9.9 | 库 | 面板客户端由它生成，不手写类型 |
| 队列 | pg-boss | 12.38 | 库 | Postgres 原生：重试/退避/延迟/singleton/dead-letter/cron/归档 |
| 数据库 | PostgreSQL | 16+ | 库 | 单实例，只监听 127.0.0.1 |
| SQL 访问与迁移 | Drizzle ORM + drizzle-kit | 0.45 / 0.31 | 库 | 类型安全 schema，聚合查询用 `sql` 模板 |
| Webhook 验签 | @octokit/webhooks | 14.2 | 库 | `verify()` 校验 HMAC，自己解析 body 不重复实现 |
| GitHub 认证 | @octokit/auth-app | 8.3 | 库 | App JWT → installation token（1h）自动换发与缓存 |
| GitHub API | Octokit | 5.0 | 库 | REST + GraphQL + 限流头解析 |
| 结构化输出校验 | Ajv + ajv-formats | 8.20 / 3.0 | 库 | 任务信封（plan §5）按 JSON Schema 校验 |
| RACP schema 校验 | 同一份 Ajv 实例 | — | 库 | 加载 **vendored** 的 `vendor/pi-host/<version>/racp.schema.json`，不读任何系统路径 |
| 容器生命周期 | dockerode | 5.0 | 库 | run/inspect/remove/stats，替代裸 docker CLI |
| 日志 | pino | 10.4 | 库 | JSON 行、`redact` 脱敏、request-id 贯穿 |
| 指标 | prom-client | 15.1 | 库 | `/metrics` 给 Prometheus；业务指标走面板（§10） |
| 面板鉴权 | @fastify/oauth2 + @fastify/cookie | 8.3 / 11.1 | 库 | GitHub OAuth App 换 login；会话**只**存服务端 `panel_sessions` 表，cookie 只带 `sid`（HttpOnly / Secure / SameSite=Lax），不把身份塞进 cookie |
| 静态资源 | @fastify/static | 10.1 | 库 | 面板构建产物由后端托管，单端口部署 |
| WebSocket 客户端 | ws | 8.22 | 库 | RACP-WS 传输层（与服务端同款库） |
| 集成测试 | Vitest + testcontainers | 5.1 / 12.2 | 库 | 真实 PG + 真实容器跑队列与执行器 |
| 本地 webhook 转发 | smee-client / `gh webhook forward` | 5.0 | 库 | 开发期把真实投递打到本机 |

### 2.2 agent 侧

| 组件 | 选型 | 归属 | 说明 |
|---|---|---|---|
| Agent 运行时 | pi-host bundle（发布物，Node ≥22 + sidecar + `host-core`） | 库（复用） | 不重写运行时（plan §4.4） |
| RACP-WS 客户端 | `ws` + 手写 JSON-RPC 2.0 帧层（≈400 行） | **自研** | 不存在第三方客户端；`@pi-desktop/racp` 是 `private: true`，未发 npm |
| RACP 类型 | `vendor/pi-host/<version>/racp.schema.json` → `json-schema-to-typescript` | 库 + 胶水 | 契约由 SDK 生成，我们只搬运与校验；schema 随 bundle 一起 vendored 并校验 SHA256（§2.2 末尾） |
| 命令进容器的 shim | ≈25 行 POSIX sh（从 `$PWD` 上溯 ≤4 层找 `.pi-bot/exec.sock`，找到即 `exec` 客户端；找不到报 `NO_EXEC_ENDPOINT` 退 2） | **自研（胶水）** | **不接 docker socket**；`PI_DESKTOP_BASH` 是受支持的覆盖点（§4.5） |
| exec 代理 + 客户端 | 自研（≈150 行：bot 侧 unix socket 服务 + 帧客户端） | **自研** | 唯一持有 `/var/run/docker.sock` 的地方。`socat` 一类只能转发字节、拿不到「job → 容器」映射，还得往镜像里装工具，多一个面（§4.5） |
| 自动审批策略 | 自研（≈80 行） | **自研** | 通过 `approval/respond` 应答，判定点即审计点 |
| 重复输出熔断 | 自研（≈200 行：200 字符窗口哈希环 + n-gram 增量 + 工具调用签名） | **自研** | plan §9.3 的三个条件没有任何库能直接表达 |
| 三层时间闸 | `AbortSignal` + `runWithDeadline()` 包装器 | 自研（胶水） | 语义是「层级取消」，用 `p-timeout` 会丢父子关系 |
| Token/成本归集 | 自研（价格表 YAML + 累加） | 自研 | 数据来自 turn 结果里的 usage，无库可代劳 |

**契约与 bundle 钉扎（跨仓库输入的唯一来源）**

`racp.schema.json`、pi-host bundle（`sidecar.js` + Rust `host-core` + 内置 Node）都来自另一个仓库，而本仓库从 `docs/` 起步、M0 第一行代码就要读它们。v1.0 没写来源，等于把「今天 checkout 到的上游」当成隐式依赖。规则：

```
vendor/pi-host/<version>/
├─ PIN.json          # { hostVersion, wsPath: "/v1/racp/ws", wsSubprotocol: "pi-racp.v1.jsonrpc", sha256: { "racp.schema.json": …, "pi-host": …, "host-core": …, "sidecar.js": … }, fetchedAt, upstreamRef }
├─ racp.schema.json  # 契约 fixture：Ajv 校验与 TS 类型生成的唯一来源
└─ bin/              # bundle 解包物：pi-host / host-core / sidecar.js
```

1. **一起 vendored、一起钉扎。** fixture 与 bundle 必须同版本入库，`PIN.json` 记每份产物的 `SHA256` 与 `hostVersion`。任一文件哈希不符即视为被替换。
2. **两处强制校验。** `pi-bot doctor` 启动前校验一次；`bootstrap-host` / `serve` 每次拉起 pi-host 前校验一次——`connection/initialize` 协商出的 `hostVersion` 必须等于 `PIN.json` 里的值，否则拒绝启动并抛出本地前置错误（不用等到运行期撞 `HOST_VERSION_MISMATCH`）。只在启动期比对，不每任务校验，避免 I/O 抖动。
3. **升级 = 一次显式 PR。** `scripts/vendor-pi-host.mjs --version <v>` 下载、校验、重算 `PIN.json`；PR 必须附 `racp.schema.json` 的 diff（契约变化要看得到）。禁止「运行时按 `latest` 去上游拉」——那等于把契约的单一来源交给网络。
4. **哈希不放松。** `doctor --allow-host-version-mismatch` 只放宽「协商版本不符」，永不放开哈希校验；哈希不符一律 `fail`。
5. **握手常量也算契约。** `PIN.json` 额外记两个字面量：`wsPath`（当前 `/v1/racp/ws`）与 `wsSubprotocol`（当前 `pi-racp.v1.jsonrpc`），来源 `packages/shared/src/racp.ts`。`doctor` 与启动自检校验它们与 vendored 版本一致——Host 升级若改了绑定（路径或子协议），必须在启动期就报出来，而不是等到第一次握手被拒才发现（§4.2）。

理由一句话：契约是跨仓库输入，钉扎把它变成「本仓库的一份文件」，而不是「今天恰好 checkout 到的上游」。
### 2.3 执行面（容器与 Git）

| 组件 | 选型 | 归属 | 说明 |
|---|---|---|---|
| 容器规格与限制 | dockerode 传 `HostConfig`（read-only、cap-drop、pids、memory、cpus、user） | 库 | plan §8.1 的参数逐条映射 |
| 保留期与磁盘水位 | 自研策略（≈300 行） | **自研** | 业务规则（plan §8.3），无库 |
| 网络隔离 | Docker bridge + nftables DROP 私网段 | 配置 | 用系统工具，不写代码；`doctor` 用金丝雀容器验证 |
| Git 检出与 worktree | `git` CLI（成熟，worktree 支持完整） | 库 | 不用 isomorphic-git：worktree 支持弱 |
| 依赖缓存 | Docker 命名卷 `pi-dep-cache:/cache:ro` | 配置 | plan §8.1 |
| 推分支/开 PR | `git push`（临时 index 组 commit）+ Octokit | 库 | 令牌走 `GIT_ASKPASS`，永不进容器；**推送内容先过写回闸门（§5.6）** |
| 写回闸门 | 自研（≈100 行：路径集合求交 + 拒收清单 + 临时 index 组 commit） | **自研** | 库只管「怎么推」，不管「准许推什么」；规则来自 plan §3 与 §5，无库可代（§5.6） |
| 预检 `doctor` | 自研（≈150 行，组合 dockerode + statfs + 探测容器） | **自研（集成）** | plan §8.5 的检查项是产品需求 |

### 2.4 面板

| 组件 | 选型 | 版本 | 归属 | 说明 |
|---|---|---|---|---|
| 框架 | React + React DOM | 19.3 | 库 | — |
| 构建 | Vite + @vitejs/plugin-react | 8.3 | 库 | 开发期 proxy 直连 3000 端口后端 |
| 样式 | Tailwind CSS + @tailwindcss/vite | 4.3 | 库 | 零 config 文件，CSS-first |
| 组件库 | shadcn/ui（Radix primitives + cva + clsx + tailwind-merge） | CLI 4.23 | 库 | 复制进仓库，不引黑盒依赖 |
| 图标 | lucide-react | 1.70 | 库 | — |
| 数据请求 | TanStack Query | 5.107 | 库 | 轮询刷新、缓存、错误重试 |
| 表格 | TanStack Table | 9.3 | 库 | 排序/筛选/分页/列可见性 |
| 图表 | Recharts | 3.10 | 库 | 折线/柱/堆叠，配 shadcn chart 包装 |
| 路由 | react-router | 8.5 | 库 | library 模式，不做 SSR |
| API 客户端 | openapi-typescript + openapi-fetch | 7.13 / 0.17 | 库 | 从后端 OpenAPI 生成类型，不手写 DTO |
| 日期/数字 | date-fns + `Intl.NumberFormat` | 4.4 | 库 | — |

### 2.5 自研清单（为什么值得自研）

只有 5 处，全部有明确理由：

| # | 自研项 | 为什么没有可用库 |
|---|---|---|
| S1 | RACP-WS 客户端 | 协议是我们自己的（JSON-RPC 2.0 + Bearer 设备令牌 + 子协议 + 文本帧 + 游标重放）；官方实现是私有包。手写部分只是帧层，契约与校验仍由 SDK 生成的 JSON Schema 兜住 |
| S2 | 重复输出熔断 | plan §9.3 的三个条件是产品化启发式（窗口重复、n-gram 增量、工具调用环），没有库表达这三个判据的组合 |
| S3 | 容器保留期/磁盘水位策略 | plan §8.3 的业务矩阵；dockerode 只提供原语 |
| S4 | 自动审批策略 | 决策内容是本项目的安全策略，不是通用能力 |
| S5 | 「被人改回」判定 | 需要把我们的写操作与后续 webhook 关联，属于业务语义（§7.5） |

反过来，以下都**明确不自研**：webhook 验签、GitHub 认证与限流、队列与重试原语、数据库迁移、HTTP 校验、图表、表格、UI 组件、OAuth 流程、TLS、日志脱敏、Docker API 客户端、依赖缓存清理。
---

## 3. 进程与部署形态

### 3.1 拓扑

单台 Linux 主机，一个 GitHub Org。

```
                         ┌──────────── Caddy（80/443，自动 TLS） ────────────┐
                         │  /webhook  /api/*  /  →  127.0.0.1:3000           │
                         │  /metrics 不在这里（见 §10.1：127.0.0.1:9464）     │
                         └───────────────────────┬──────────────────────────┘
                                                 │
   systemd: pi-issue-bot.service（Node 24，单进程，User=pi）
     ├── Fastify（webhook 接收 + 面板 API + 静态资源）
     ├── pg-boss worker（并发 2–4）
     ├── 写执行器 + 写回闸门（§5.4 / §5.6）
     ├── exec 代理（unix socket `<job>/.pi-bot/exec.sock`）← 全机唯一持有 /var/run/docker.sock
     ├── pi-host 子进程（1 个，长驻）
     │     ├── RACP-WS 服务（127.0.0.1:<随机端口>，Bearer 设备令牌）
     │     ├── agent sidecar（Node）
     │     ├── host-core（Rust 二进制，独占 SQLite transcript）
     │     └── Bash 工具 → sandbox-bash shim → exec.sock（自身无 docker 访问权）
     └── 任务容器 pi-job-<id>（每任务一个，无凭证、无 socket）

   docker compose: postgres:16（只发布 127.0.0.1:5432）
```

拓扑里有且只有一条链能到 docker：**socket → bot（exec 代理）→ exec.sock → shim**。shim 是 pi-host 的子进程，它只有 unix socket 客户端的本事，没有 docker API 的本事；「命令进容器」这条数据通道因此只穿过 bot 一次，与 plan §4.2「唯一数据通道」的措辞对齐。

### 3.2 进程清单

| 进程 | 谁拉起 | 重启策略 | 持有凭证 | 网络暴露 |
|---|---|---|---|---|
| Caddy | systemd | always | ACME 账号 | 公网 80/443 |
| pi-issue-bot | systemd | always（`RestartSec=2`） | App 私钥、installation token、设备令牌、PG 口令、OAuth secret | 仅 loopback 3000 |
| pi-host | pi-issue-bot（spawn） | 崩溃后 bot 按 0.5s→1s→2s 退避重启，2 分钟内最多 3 次 | 模型 API key（通过环境变量继承）；**无 docker socket** | 仅 loopback，随机端口 |
| exec 代理（bot 进程内） | pi-issue-bot 同进程监听 | 随 bot（`RestartSec=2`） | **`/var/run/docker.sock`（全机唯一持有者）** | unix socket `<job_dir>/.pi-bot/exec.sock`（`0600`，属主 `pi`，每 job 一个） |
| host-core | pi-host（spawn） | 由 pi-host 监督 | 无 | 无（stdio） |
| sidecar | pi-host（spawn） | 由 pi-host 监督 | 无（模型请求经宿主侧转发） | 无（stdio） |
| Postgres | dockerd | compose `restart: unless-stopped` | 无（口令来自 env） | 仅 127.0.0.1 |
| 任务容器 | pi-issue-bot（dockerode） | **不重启**，失败按 plan §8.3 保留 | **无任何凭证** | 出网受限（§6） |

### 3.3 为什么 bot 用 systemd 而不是塞进 compose

1. **它必须持有 docker socket。** socket 等价于宿主机 root（plan §8.4 红线 1），只应出现在可信侧的**一个**进程里——就是 bot：容器生命周期由它管，agent 侧的命令也由它的 exec 代理转进来（§4.5）。shim 与 pi-host 进程树都不碰 socket；容器内挂 socket 等于把这条边界交给一个可被镜像替换的运行时。
2. **`pi-bot doctor` 要在宿主上跑。** 磁盘水位、worker 镜像存在性、金丝雀容器访问 `169.254.169.254` 是否真的失败——这些预检的对象就是宿主，二进制放在宿主最直白。
3. **密钥注入更简单。** systemd `EnvironmentFile=/etc/pi-bot/env`（`0600 root:pi`），不需要给容器再加一层 secret 传递。
4. **升级是一次原子替换。** 新二进制 + `systemctl restart`，无镜像构建等待；回滚就是换回旧文件。

代价（明确接受）：bot 与 pi-host 共用宿主用户 `pi`，二者之间只有进程边界、没有 namespace 边界。这条边界的安全性依赖「agent 不执行任何代码、只发命令给容器」——见 §4.5 的说明与 §11 的风险项。v1.1 补充：pi-host 进程树（含 shim 与 Bash 工具）都**不持有 docker socket**，命令经 bot 的 exec 代理转发（§4.5），因此「socket 只在 bot」现在可验证而非靠约定——`doctor` 扫 `/proc/<pid>/fd` 断言 pi-host 及其子进程没有打开 `docker.sock`（§6.4）。

### 3.4 崩溃半径与恢复

| 崩溃点 | 影响 | 恢复 |
|---|---|---|
| 任务容器退出 | 该任务失败 | 任务状态落库，容器按保留期处理；不自动重试超时 |
| host-core 崩溃 | pi-host 无法继续，正在跑的 turn 失败 | pi-host 监督者重启 host-core；durable turn queue 恢复排队项（SDK 内建） |
| pi-host 崩溃 | 所有在跑的 turn 失败 | bot 重启 pi-host（退避），失败任务回队一次；设备令牌仍在，无需重新配对 |
| bot 崩溃 | webhook 期间不可用 | systemd 重启；已完成投递在 `webhook_deliveries` 去重，未完成的任务等 pg-boss 的 active 超时（`expireIn`，执行期硬上限）后重新可见；**排队过久的任务由 §4.7 的定时任务取消，不让 `expireIn` 兼职排队** |
| Postgres 崩溃 | 一切停摆 | compose 重启；队列与任务状态都在库里，无需补偿 |
| 磁盘满 | 容器无法写 | `doctor` 与运行期水位检查（`>85%`）先清最旧的失败容器与 worktree |

**优雅停机**（plan §10）：`SIGTERM` → 停止接收新 webhook（返回 503 让 GitHub 重投）→ 等 worker 完成当前任务或 `turn/interrupt` → 释放容器 → 关闭 pi-host → 退出。`TimeoutStopSec=90`。

### 3.5 硬件规格建议

**结论：16 GB RAM / 4 vCPU / 80 GB SSD（2–4 并发，仓库体量参考 PI-Desktop 自身）。**

实测数据（PI SDK 0.21.0，Windows 宿主，`pi-host` 无头启动后空载采样）：

| 进程 | 工作集 | 私有 |
|---|---|---|
| `pi-host` 主进程（Node） | 79 MB | 54 MB |
| agent sidecar（Node） | 86 MB | 95 MB |
| `host-core`（Rust，空载） | 37 MB | 25 MB |
| **无头栈空载合计** | **≈202 MB** | — |
| `host-core`（桌面活跃会话实例，对照） | 194 MB | 148 MB |
| 对照：桌面版整机（23 个 Electron/Node/Rust 进程） | ≈4.5 GB | — |

要点：**桌面很重，无头很轻**（21 倍差），不要拿桌面版的数字推算服务器。空载 202 MB，跑真实会话时 host-core 会到 ~200 MB、sidecar 处理模型流与工具结果会到 300–500 MB，整个 pi-host 栈按 **0.5–1.0 GB** 预算。

16 GB 的分配：

| 项 | 常驻 | 峰值 |
|---|---|---|
| OS + dockerd + Caddy + journald | 0.9 GB | 1.2 GB |
| PostgreSQL 16（`shared_buffers` 512 MB 起） | 0.5 GB | 0.9 GB |
| `pi-issue-bot`（Fastify + 2–4 worker + pg-boss） | 0.3 GB | 0.45 GB |
| pi-host 栈（node + sidecar + host-core） | 0.2 GB | 1.0 GB |
| 任务容器 ×2–4 | — | 每容器 1.0–1.5 GB |
| 页缓存（git / node_modules / target） | 2–4 GB，内核按需回收 | — |
| 安全余量 | ≥2 GB | |

4 并发峰值约 **11–13 GB**，16 GB 有余量；2 并发约 7 GB。因为 plan §8.1 要求 `--memory-swap` 与 `--memory` 相同（禁 swap），超限就是直接 OOM kill，所以**不要按「刚好够」设上限**。

档位建议：

| 内存 | 可行性 |
|---|---|
| 8 GB | 只够 2 并发 + 容器 2 GB 上限，页缓存吃紧，构建类任务明显变慢。不推荐 |
| **16 GB** | **推荐值**：4 并发 + 面板 + 余量 |
| 32 GB | 与桌面版/CI 同机，或 4 并发要跑全量构建与测试时选它 |

### 3.6 对 plan §8.1 的一处修正：容器内存上限分档

plan §8.1 给的是统一 `--memory 2g`。对 PI-Desktop 这种体量（`node_modules` 825 MB、Rust `target/` 2.5 GB、Electron + pnpm workspace + Cargo 三合一），`pnpm build` / `cargo build` / 全量 vitest 在 2 GB 下会被 OOM kill，而表现是「容器无声消失 + 任务失败」，很难查。

建议按任务类型分档：

| 任务类型 | `--memory` | 说明 |
|---|---|---|
| 判定类（`/issue-triage`、`/issue-repro`） | 2 GB | 只读 + 少量命令，够用 |
| `/review-pr`（真实检出 + 装依赖 + 跑测试） | **4 GB** | 峰值常落在 2.5–3.5 GB |

同时做两件配套的事：容器内对 Node 加 `NODE_OPTIONS=--max-old-space-size=<上限×0.6>`；把 OOM 与超时区分开——容器 `State.OOMKilled = true` 时归为 **`sandbox-oom`**（`failure_class` 的 sandbox 子类，见 §7.3 的优先级表）而不是 `timeout`，否则会误触「超时不自动重试」的策略。OOM 标记只在容器对象还在时读得到，所以**销毁前必须先 `inspect` 采一次 `State.OOMKilled` 与 `State.ExitCode`** 落库（§7.3）。

磁盘（相邻但同样重要）：单个 PI-Desktop worktree = `node_modules` 825 MB + `target/` 2.5 GB。4 个并发同时检出构建就要 20 GB 以上，加上依赖缓存卷与 24h 保留期，**建议 80 GB SSD 起**（plan §8.5 的「≥20 GB」是硬下限，不是舒适值），并且必须 SSD——这个负载是 IOPS 敏感而非带宽敏感。
---

## 4. agent 调用方式：RACP-WS

### 4.1 选择 out-of-process RACP，而不是 in-process 引用

plan §4.4 允许「将来若单进程更划算可整体换成 in-process」。**MVP 选 out-of-process**，理由按权重：

1. **SDK 包不可从外部消费。** `@pi-desktop/racp`、`@pi-desktop/agent-host`、`@pi-desktop/host-runtime` 全部 `"private": true`（已验证），且依赖 `workspace:*`。in-process 意味着把整个 SDK monorepo 当作我们仓库的构建依赖（submodule + pnpm 工作区链接 + 构建 3 个 TS 包），发布物与我们的发版节奏绑死。
2. **契约是冻结的、可校验的。** RACP 是「规范 + 生成的 JSON Schema fixture」，出问题能对着 §7 的表格逐字段核；in-process 是引用别人的内部模块，内部签名随时可变。
3. **崩溃隔离。** agent 侧跑飞会打死 pi-host 进程，但打不死 webhook 接收与面板 API；in-process 则一起死。
4. **Host 自带版本对齐机制。** `connection/initialize` 会协商版本与能力，不匹配直接 `HOST_VERSION_MISMATCH`，比运行时 undefined 报错好查得多。
5. **`workspace/toolExecute` 的语义方向相反。** 6.2.1 那组操作是「桌面本地 agent + 远端工具」，我们要的是反方向（远端 agent + 宿主容器），用不上，也因此不必进 in-process。

**契约与 bundle 钉扎**：本方案对 `racp.schema.json` 与 pi-host bundle 的引用，全部指向仓库内 `vendor/pi-host/<version>/`（`PIN.json` 记 `SHA256` + `hostVersion`，`doctor` 与启动自检校验，升级走显式 PR）。理由与规则见 §2.2 末尾——不在这里复述，只强调一处后果：`racp-client` 的类型生成与 Ajv 校验都读同一份 vendored fixture，因此「本机能跑」与「服务器能跑」不依赖各自 checkout 的上游版本。

代价：多一次 WS 握手、多 400 行客户端、多一个进程要监督。前两项已计入自研预算，第三项由 §3.4 的监督逻辑兜。

### 4.2 引导（首次安装跑一次）

已验证的 CLI 事实（`apps/pi-host/src/cli.ts` / `config.ts`）：

- 启动参数：`--data-dir` / `--port`（默认 0 = 随机）/ `--host-core` / `--sidecar` / `--pair` / `--pairing-lifetime-ms` / `--log-level`
- 端口与地址也吃环境变量：`PI_HOST_PORT`、`PI_HOST_BIND`（默认 `127.0.0.1`，非 loopback 直接拒绝）
- stdout 首行 `PI_HOST_READY {"hostId","host","port","version"}`
- `--pair` 时第二行 `PI_HOST_PAIRING_TOKEN {"token","expiresAt"}`（默认 10 分钟寿命）
- **`--pair` 不会在配对后退出**：进程继续服务，配对令牌是单次消费的

引导流程（`pi-bot bootstrap-host`，只需一次）：

```
0. 校验 /usr/local/lib/pi-bot/pi-host/<version>/PIN.json 的 SHA256 与 hostVersion（§2.2 钉扎）
1. spawn: /usr/local/lib/pi-bot/pi-host/<version>/bin/pi-host --data-dir /var/lib/pi-bot/host --port 0 --pair
   env: PI_DESKTOP_BASH=/usr/local/lib/pi-bot/sandbox-bash
2. 读 stdout 前两行 → port + pairing token
3. ws://127.0.0.1:<port>/v1/racp/ws
   Authorization: Bearer ppt1.…
   Sec-WebSocket-Protocol: pi-racp.v1.jsonrpc
4. connection/pair → 得到 pdt1.… 设备令牌（owner 角色）
5. 令牌用 AES-256-GCM 加密写入 DB（host_credentials），并记录 hostId / version / expiresAt
6. 正常启动时不再传 --pair，直接用设备令牌连接
```

三个握手常量必须是**字面量**，不能是「见规范 §x」的占位：v1.0 在这里写的是「`Sec-WebSocket-Protocol: <RACP 子协议，见 §14a>`」，而本文并没有 §14a —— B5 照此写客户端会卡在这里，而 Host 侧 `handleProtocols` 只接受那一个子协议值，写错一律握手被拒。取值来自 `packages/shared/src/racp.ts`（`RACP_WS_SUBPROTOCOL` / `RACP_WS_PATH`）：

| 项 | 值 | 说明 |
|---|---|---|
| 路径 | `/v1/racp/ws` | 完整 URL `ws://127.0.0.1:<port>/v1/racp/ws`；`<port>` 取 `PI_HOST_READY` 首行（`--port 0` 时是随机端口） |
| 子协议 | `pi-racp.v1.jsonrpc` | `Sec-WebSocket-Protocol` 请求头的值；缺失或不匹配即被拒 |
| 认证 | `Authorization: Bearer <ppt1.… 或 pdt1.…>` | 引导期用配对令牌 `ppt1.`，之后用设备令牌 `pdt1.` |

缺子协议、错路径、非 loopback 绑定、binary frame 这四种一律被拒（ADR 0285 §3）——它们是 Host 的前置拒绝，不是我们的策略选择，客户端没有「重试成功」的余地，只能第一次就把三个常量写对。这三个常量随 `PIN.json` 一起钉扎（§2.2 第 5 条），Host 升级若改了绑定要在 `doctor` 里报出来。

设备令牌是长期凭证，pi-host 侧存的是 SHA-256 哈希（ADR 0285 §3），所以我们丢了就只能重新 `--pair`。因此第 5 步是硬要求，不能只放内存。

### 4.3 每任务时序

一个 pi-host 长驻，一个任务 = 一个 session。这样模型连接与 sidecar 复用，任务间互不干扰。

| # | 调用 | 要点 |
|---|---|---|
| 1 | `project/register { path: <job worktree> }` | 由 Host 规范化并校验路径，返回 `projectId`；已注册直接复用 |
| 2 | `session/create { projectId, permissionMode: "ask", mode: "agent" }` | 拿到 `sessionId` |
| 3 | `events/subscribe { sessionId, after: 0 }` | 游标从 0 开始；本任务的事件流写进 `run_events` |
| 4 | `turn/start { sessionId, input: { messageId, text: <prompt> } }` | 返回 `turnId`；prompt 由技能模板 + 仓库配置 + 任务上下文拼成 |
| 5 | 事件循环 | `approval/request` → 自动审批策略（§4.6）；`input/request` → 按策略应答或直接拒；`turn/*` 终态 → 退出循环 |
| 6 | `workspace/diff` | 取工作树 diff，与信封一起入库供面板展示 |
| 7 | 结构化校验任务信封 | Ajv 校验 plan §5 的 JSON；不合规的动作丢弃并记 `parse` 失败 |
| 8 | 写执行器 | 逐个动作执行（§5.4）；涉及 `push_branch` 的先过写回闸门（§5.6），每步留审计 |
| 9 | `session/archive`；超过保留期后 `session/delete` | 归档在任务结束时立即做，删除交给每日清理 |

超时/熔断时的退出路径：`turn/interrupt`（幂等）→ 等 `turn/*` 终态 → kill 容器 → 归档 session → 任务标 `timed-out` / `degenerate-output`。
### 4.4 用到的 operation（其余明确不用）

| 用 | 用途 |
|---|---|
| `connection/initialize` `connection/ping` | 版本/能力协商、健康检查 |
| `connection/pair` | 仅引导时 |
| `project/register` | 把任务 worktree 注册成 project |
| `session/create` `session/attach` `session/archive` `session/delete` | 任务生命周期（详情页读我们自己的 `run_events`，不读 transcript） |
| `events/subscribe` `events/unsubscribe` `events/ack` | 事件流与断线重放 |
| `turn/start` `turn/get` `turn/interrupt` `turn/stop` | 轮次控制（`turn/interrupt` 是三层时间闸的落地手段） |
| `approval/respond` `input/respond` | 自动审批策略（§4.6） |
| `workspace/diff` | 面板展示改动；只读单点，不用 `list`/`read` |

| 明确不用 | 原因 |
|---|---|
| `terminal/*` | 面板不提供交互式终端（会绕过容器边界，直接在宿主跑） |
| `attachment/*` | MVP 不做附件输入 |
| `tools/advertise` + §9.4 relay | Host 侧 `toolRelay: false`，ADR 0285 明示未实现 |
| `workspace/toolExecute` `workspace/toolShell` `workspace/files` `workspace/pluginFiles` | 方向相反（桌面本地 agent + 远端工具），我们是远端 agent |
| `host/list` | 仅 Gateway 部署使用 |
| `session/fork` `session/rename` `session/configure` | MVP 不需要在任务中途改模型/模式 |
| `session/compact` `session/history` | 会话是每任务一次性的，不需要压缩、也不需要回读历史；详情页走我们自己的 `run_events`（R6），这两个 operation 只增加维护面 |
| `workspace/list` `workspace/read` | diff 已由 `workspace/diff` 提供；面板不直接读工作树文件，避免把不可信内容灌进面板 |

### 4.5 命令怎么进容器（本项目最关键的工程细节）

**问题**：RACP 只有 `approval/respond` 与事件流，没有「把 Bash 工具执行代理到别处」的开关。pi-host 的 agent 在宿主进程里直接 spawn `bash -lc <cmd>`（`crates/host-core/src/tools/shell.rs`）。plan D5 要求命令必须在容器里跑。

**先排掉 v1.0 的自相矛盾（F1）**：v1.0 让 shim 直接 `docker exec`，可 shim 是 pi-host 的子进程、属于 pi-host 进程树。要继续 `docker exec`，pi-host 就必须能访问 `/var/run/docker.sock`——那样 §3.3 与「socket 只在 bot」当场破产，plan §8.4 红线 1 变成一句口号。修这一条的同时顺手解决了另一件事：v1.0 的容器名由 `pwd -P` 的 sha1 推导，agent 一旦 `cd` 到子目录就会指向错误的容器、或者根本找不到容器。

**正解（三层，各管一件事）**：

1. host-core 解析 bash 的第一步就是读环境变量 `PI_DESKTOP_BASH`（`shell.rs::find_bash()`，规范 `03-tools-and-permissions.md:681` 把它列为第一优先级：「`PI_DESKTOP_BASH` env override（path to a bash executable）」）。这是受支持的执行体覆盖点，不是 hack。
2. 那个「bash executable」是我们的 shim：它**不碰 docker**，只在 `$PWD` 逐级上溯找本任务的 exec 端点。
3. 端点背后是 **bot 进程里的 exec 代理**——全机唯一持有 `/var/run/docker.sock` 的代码。代理按 socket 路径查「job → 容器名」映射，然后执行 `docker exec`，把 stdout / stderr / exit code 原样回传。

shim（`/usr/local/lib/pi-bot/sandbox-bash`，≈25 行 POSIX sh）：

```sh
#!/bin/sh
# 把 host-core 的 `bash -lc <cmd>` 转给本任务的 exec 端点。本脚本不接触 docker。
set -eu
d=$(pwd -P)
i=0
while [ "$i" -le 4 ]; do
  if [ -S "$d/.pi-bot/exec.sock" ]; then
    exec /usr/local/lib/pi-bot/exec-client "$d/.pi-bot/exec.sock" "$(pwd -P)" "$@"
  fi
  [ "$d" = "/" ] && break
  d=$(dirname "$d"); i=$((i + 1))
done
printf 'pi-bot: NO_EXEC_ENDPOINT: 向上 4 层内找不到 .pi-bot/exec.sock（cwd=%s）\n' "$PWD" >&2
exit 2
```

端点与协议的五条规定：

- **位置**：bot 为每个 job 在 `<job_dir>/.pi-bot/exec.sock` 监听，`0600`、属主 `pi`，父目录 `0700`；容器销毁时端点一起 `unlink`。
- **定位**：shim 从 `$PWD` 逐级向上最多 4 层，取**最近**的 `.pi-bot/exec.sock`；找不到即 `NO_EXEC_ENDPOINT` 退出非零（不是静默回落到宿主执行——那会让 D5 悄悄失效）。这样 agent 在 worktree 任意子目录里执行命令都命中同一个端点，不需要 env 传递，也不需要与 pi-host 约定任何变量。
- **为什么容器名不能再由路径推导**：`pwd -P` 在 agent `cd` 之后会变，容器名跟着错；而「哪个容器」本来只有 bot 知道（是它 `docker run` 的）。所以映射放在 bot 内存里：`Map<socketPath, { jobId, containerId }>`，容器创建时写入、销毁时删除。shim 只负责说「我在哪」，代理负责说「你该进哪个容器」。
- **协议（极简，单向流）**：客户端发一帧 `{"argv":["bash","-lc","<cmd>"],"cwd":"<abs>","clientPid":<pid>}`；代理回一串 `{"stream":"stdout","data":"<base64>"}` / `{"stream":"stderr",…}`，末帧 `{"exitCode":N}` 或 `{"error":{"code":"…"}}`。不做 PTY、不做交互 stdin（host-core 的 Bash 工具本来也不给交互 stdin）。客户端是 `exec-client`（Node 写的 ~80 行，宿主已有 Node 24，不往镜像里装工具）。
- **代理侧实际执行**：`docker exec -i -w <cwd|job_dir> <container> timeout -s KILL <n> bash -lc "<cmd>"`。`<n>` 取任务配置里的命令级上限（默认 120s，install/build 类 300s）；`cwd` 必须落在 `job_dir` 之内（身份挂载下宿主路径即容器路径），否则回退 `job_dir`。

配套五条决定：

1. **身份挂载（identity mount）**：容器启动时 `-v $JOB_DIR:$JOB_DIR -w $JOB_DIR`，宿主路径与容器路径完全相同。这样：
   - agent 的 `Read`/`Write`/`Edit`/`Glob`/`Grep` 走宿主路径（host-core 在宿主执行）；
   - agent 的 `Bash` 在容器内、但看到的是同一批文件的同一批路径；
   - `workspace/diff` 与 `git` 操作不需要任何路径翻译；
   - 代理里的 `-w <cwd>` 天然合法。
2. **socket 归属终于自洽**：`/var/run/docker.sock` 只存在于 bot 进程；pi-host / shim / agent 都没有 docker API 能力，它们能做的只有「在某个 job 的容器里跑一条命令」——这正是 plan §4.2 说的唯一数据通道。`doctor` 扫 `/proc/<pid>/fd` 断言 pi-host 进程树没打开 `docker.sock`（§6.4），这条红线从「约定」变成「检查」。
3. **超时下沉进容器（F3）**：命令级超时由容器内的 `timeout` 生效，不再靠宿主侧干等；宿主侧只留一道 `pkill -KILL -f` 兜底；任务取消/超时直接销毁容器。细节见 §4.7。
4. **写回闸门兜住字节（F2）**：身份挂载意味着容器里的写入直接落到 worktree，容器内的 `git` 也可能顺手改 `.git`。所以「只校验 `actions` 声明」不作数，写回必须有字节级闸门，见 §5.6。
5. **代理必须是最小实现（E3，边界写清而不消除）**：exec 代理是全机唯一能触达 docker 的组件，而它与 pi-host 同 uid——「谁能跑进 pi-host 进程树」这条前提它自己兜不住（§3.3 的代价段）。所以它的能力被卡到最小，并作为 M0 的验收项：只接受 `argv + cwd`（**不收 shell 字符串**，不解释任何元字符，`argv` 直接交给 `docker exec`，全程不做字符串拼接）；**拒绝 env 透传**（容器内环境只有镜像定义的那些）；按 socket 路径查表定位容器（**不接受容器名参数**）；单条命令超时 + 输出长度上限（stdout/stderr 合计默认 1 MB，超出截断并标 `truncated`）；`exec.sock` 在任务结束/容器销毁时立即 `unlink`（§6.3）。不引入新组件，只多五条验收。

**对 plan §8.1 的勘误（E1）：`/work` 作废。** plan §8.1 的挂载写作 `-v /srv/pi/jobs/<id>/work:/work`，那是 v0.4 在还没有身份挂载时给的写法；本方案采用身份挂载后**容器内路径 = 宿主路径**，`/work` 不再存在。PM 裁定身份挂载优先。因此：`Binds = [<job>:<job>:rw]`、`WorkingDir = <job>`（§6.1），任何 Dockerfile、脚本、镜像文档、排障手册都不得再引用 `/work`；容器内 `pwd` 出来的路径与宿主一致，这也是 §4.5 代理里 `-w <cwd>` 能直接成立的前提。

**边界要写清（这也是 plan §3 的诚实账）**：只有 `Bash` 进容器。`Read`/`Write`/`Edit` 在宿主进程里对同一份 bind mount 执行，没有 namespace 边界。补偿措施：

- pi-host 进程本身没有 docker socket、没有 GitHub 令牌（只有模型 key）；
- host-core 的路径约束把文件工具锁死在 session root 内（`PATH_OUTSIDE_WORKSPACE`）；
- 自动审批策略（§4.6）拒绝一切越界写入；
- 最坏损失是「改写自己这份 worktree」，而 worktree 是每任务一次性的；推回 GitHub 的内容还要过写回闸门（§5.6）与结构化校验。

若某版 Host 收紧了 `PI_DESKTOP_BASH`（D190 只明确拒绝「用路径当 shell 身份」，未拒绝此覆盖），备选方案是等 `tools/advertise` 的 relayed tool execution 落地（规范 §9.4 已定义、尚未实现），届时 Bash 由我们的代码执行，天然进容器。这条备选列入 §11 风险 R1。

### 4.6 自动审批策略（D8 的落地方式）

`permissionMode` 三档：`ask`（默认）、`accept-edits`、`auto`；Host 侧还有 `remoteMaxPermissionMode` 上限（默认 `ask`）。MVP 选 **`ask` + 自动应答**，不选 `auto`：

| 工具 | 决策 | 理由 |
|---|---|---|
| `Read` `Glob` `Grep` | allow | 只读，路径已由 host-core 限制在 session root |
| `Bash` | allow | 已进容器，容器无凭证、cap-drop、只读根 fs |
| `Write` `Edit` | allow（限 worktree 内） | 目标路径不在 worktree 内则 deny |
| 其他（网络抓取、任意 exec 桥、MCP 工具） | deny | MVP 不需要，拒绝即最小权限 |
| `input/request`（agent 反问） | 应答「无法提供，按现有信息继续」 | 无人可问，但要让 agent 拿到明确信号而不是挂起 |

选 `ask` 而不是 `auto` 的唯一原因：**每一次 deny/allow 都是审计条目**。`auto` 会把这些判定一起抹掉，而 plan §6.5 要审计的就是「它到底做了什么、依据是什么」。若压测发现应答往返拖慢任务，再把 `remoteMaxPermissionMode` 提到 `auto` 作为性能开关。

### 4.7 三层时间闸（plan §9.1）的实现映射

| 层级 | plan 默认 | 实现 | 超时处置 |
|---|---|---|---|
| 单条命令 | 120s（install/build 300s） | **容器内** `timeout -s KILL <n>`——由 exec 代理拼在 `docker exec` 的命令行上（§4.5）；宿主侧只留兜底 `docker exec <c> pkill -KILL -f "PI_CMD_ID=<uuid>"` | 容器内进程树被杀，agent 拿到超时结果自行换策略，任务继续 |
| 单任务 | 20min（`/review-pr` 30min） | `runWithDeadline()`：`AbortSignal.timeout()` 包住整个 run；触发时 `turn/interrupt` → `AbortController.abort()` 掉 WS 请求 → **销毁容器**（`kill` + `remove`） | 任务标 `timed-out`，不自动重试 |
| 队列等待 | 10min | **定时任务**（每分钟）扫 `tasks.status='queued' and now()-queued_at > 10min` → 发「排队过长，请稍后」评论 + `boss.cancel(jobId)` + `status='cancelled_queue'` | 不占并发，任务不进执行 |

为什么这样切（v1.0 在这里错了两处）：

1. **超时必须发生在容器里（F3）。** v1.0 的 `timeout -s KILL 310` 加在宿主侧的 `docker exec` 前面——`timeout` 杀的是本地的 `docker exec` 客户端，容器里的 `pnpm test` 继续跑。后果是：agent 以为命令超时了，发出下一条命令，两条命令同写一个 worktree；容器还继续吃 2 CPU / 2 GB 直到任务级超时。所以 `timeout` 必须作为 `docker exec` 的**参数**进容器，宿主侧那道 `pkill -KILL -f` 只是兜底（对付自己 `daemonize` 掉、逃出 `timeout` 进程组的进程），匹配用唯一标记 `PI_CMD_ID=<uuid>`，不用模糊的 `-f "pnpm"`。
2. **最后一道保险是销毁容器。** 任务取消/超时不再指望「容器里的进程自觉退出」：`docker kill` 之后容器内所有进程一起死，这是唯一确定的语义。因此「任务级超时」与「容器崩溃」在实现上必须是两个可区分的事件——见 §7.3 的 `failure_class` 优先级表。
3. **10 秒应答与排队闸门不是一回事（F5）。** `expireIn` 是 job 存活/active 时长的语义，不是「排队等了多久」；拿它当排队计时器，只会得到一个随 worker 启停漂移的近似值。更根本的是：排队中的任务根本没有 worker 在执行，想在 worker 里回「排队过长」在时序上就不可能。所以 **10 秒应答在 webhook handler 内完成**（入队成功后立刻打 eyes reaction，不依赖 worker，§5.3）；**排队超时由独立定时任务扫表判定**，不依赖任何 worker 存活；`expireIn` 只保留一个用途——执行期硬上限。

`runWithDeadline(parent, ms)` 是一个 40 行的包装器：合并父 `AbortSignal` 与子 deadline，抛出带 `cause` 的分类化错误。用它替代 Go 的 `context` 层级取消——这是选 TS 最实在的一处代价，写在明面上。

---

## 5. GitHub App 集成

### 5.1 为什么不直接用 Probot

Probot（14.3）把 webhook 接收、验签、Octokit 实例化和事件路由包在一起，但它假设「事件处理内联在 Express handler 里」。我们的要求是：**验签后 10 秒内返回 200，处理立刻入队**（plan §10 的 p95 指标、GitHub 的投递超时）。用 Probot 就得把它当成纯接收器，反过来又受它的生命周期约束。

结论：直接用 Probot 底层的三个官方库——`@octokit/webhooks`（验签）+ `@octokit/auth-app`（App JWT → installation token）+ Octokit（API）。少一层框架，语义完全可控。

### 5.2 权限范围（最小化）

| 权限 | 级别 | 用途 |
|---|---|---|
| Metadata | read | 必需 |
| Contents | write | 推 `bot/*` 分支、读仓库文件 |
| Issues | write | 打标、评论、建 issue、关闭 |
| Pull requests | write | 评论、开 PR、读 diff |
| Checks | read | `/review-pr` 读测试结果 |
| Members | read | 面板鉴权校验 org 成员身份 |

不申请 `Administration`、不申请 `Workflows`（能改 CI 就等于能绕过必需检查）。

installation token 1 小时过期，由 `@octokit/auth-app` 内部缓存与自动续期；进程内不持久化令牌，只在请求期持有。

### 5.3 webhook 接收管线

```
POST /webhook
 1. 原始 body（Fastify raw body parser，不能用 JSON parser，否则 HMAC 对不上）
 2. @octokit/webhooks verify() → 失败 401
 3. INSERT INTO webhook_deliveries (delivery_id, event, action, payload, ...)
    ON CONFLICT (delivery_id) DO NOTHING   ← 主幂等点
 4. 若 rowCount = 0 → 200（重复投递，直接丢）
 5. 判定是否需要处理（事件/action 白名单 + 仓库开关 + dry-run 标记）
 6. INSERT INTO tasks (..., command, actor_login, queued_at = now(), status = 'queued',
       idempotency_key) ON CONFLICT (idempotency_key) DO NOTHING   ← 任务级幂等
 7. boss.send('run-task', { taskId }, { singletonKey: taskId,
       expireIn: <执行期硬上限：20min；/review-pr 30min> })
 8. ★ 10 秒应答就在这一步给出：POST /repos/:o/:r/issues/:n/reactions { content: "eyes" }
      （评论场景的等价物是一行「已收到」；不 await 完整体，失败只记 warn）
 9. 200，全程 <2 秒
```

七个要点：

- **幂等落在数据库唯一索引上**，不靠内存去重；webhook 重投是常态而非异常。
- `singletonKey = taskId` 让 pg-boss 在任务已存在时不再入队，覆盖「第 3 步之后、第 6 步之前崩溃」的窗口。
- **10 秒应答在 handler 内完成（F5）**：plan §6.4 要求「10 秒内给出回应」，而 worker 可能还在队列里排着、根本没开始执行。所以应答必须在入队成功后由 handler 自己立刻打 eyes reaction，不经过队列；worker 拿到任务后再把这枚 reaction 收尾（换成 👍/👎 或撤掉）。reaction 打不上只记 warn，不影响 200——回应失败不该让 GitHub 重投一次。
- **排队闸门不交给 `expireIn`（F5）**：`expireIn` 的语义是 job 存活/active 时长，不是「排队等了多久」。排队 >10min 的判定由每分钟跑的定时任务直接扫 `tasks` 表（§4.7 第三行），与 worker 是否存活无关；超时即评论 + `boss.cancel(jobId)` + `status='cancelled_queue'`。
- **`command` / `actor_login` / `queued_at` 在第 6 步就写死（F9）**：三条都不许 worker 回填——排队闸门在 worker 之外就要读 `queued_at`；`/api/costs` 的按命令拆分、`/api/quality/reverts` 的按命令分组、`/api/audit` 的「谁触发」都直接读列，面板查询不该去解 `payload` jsonb。
- 第 3 步的原始 payload 保留 90 天，`pi-bot replay <delivery-id>` 就是拿它重放入队——plan §10「本地可复现」的实现方式，不需要专门造一套录制工具。
- 签名校验用 `secret`（每 App 一个），失败一律 401 且记审计，不做「宽容模式」。

### 5.4 写执行器与幂等

agent 只交出信封（plan §5），动作由控制面执行。每个动作的幂等策略不同：

| 动作 | 幂等键 / 兜底 | 重复投递时 |
|---|---|---|
| `comment` | 正文尾部隐藏标记 `<!-- pi-bot:<repo>#<target>:<intent>:<body-hash> -->`（`body-hash` = 正文归一化后 sha256 前 16 位；**不含 task id**） | 按标记搜索现有评论，命中则不重复发 |
| `label add/remove` | 我们自己的 `bot_labels` 表记录「我打过哪些」 | 只动自己打过的标签，人打过的不碰（plan §6.1） |
| `create_issue` | 去重键 `(repo, fingerprint)` + `issues` 表唯一索引 | 命中则追加一条评论，不新开（plan §6.3） |
| `push_branch` | 分支名 `bot/<task>-<slug>`，先查 `refs/heads/*` 是否存在；**推送内容先过写回闸门（§5.6）** | 存在则不覆盖，改为更新同名分支（永不 force push） |
| `open_pr` | `(repo, head, base)` 唯一 | 已存在则返回既有 PR 号 |
| `close_issue` | `issue_states` 上的确定性条件（plan §7：`needs-info` + 缺失项集合 48h 未变 + 无人工回复，见 §7.2） | 关闭前**只读 `issue_states`** 重算条件，不成立则跳过 |

**没有 merge 调用**，也没有对应的库函数——`Octokit` 里存在 `pulls.merge`，但我们不写、并在测试里加一条源码扫描断言（`grep -r "\.merge(" src/` 为空），把 plan §7.1 的「代码层不存在」变成可执行检查。

**标记里为什么不能有 task id（F7）**：事件重算、`/retry`、超时重跑都会生成新的 taskId；带 task id 的标记在新任务里搜不到旧评论，于是同一条意见被发第二遍。去重只该依赖「对谁说、说什么类型、说什么内容」这三件与任务实例无关的事。副作用是有意的：正文变了就是新评论（改稿不算重复），正文没变则永不重复。

### 5.5 分支与 worktree

- 检出：`git clone --filter=blob:none --no-checkout` 到缓存目录，任务用 `git worktree add` 得到独立工作树（plan D4）。
- 依赖：`pnpm install --offline` 优先命中 `pi-dep-cache` 卷，未命中再走公网（容器内）。
- 推送：**先过写回闸门（§5.6）**算出「准推的 commit」，再 `git push` 这个 commit；令牌走 `GIT_ASKPASS` 指向一个只回令牌的临时脚本，令牌不落盘、不进容器、不进命令历史，完成后立即删除。
- 清理：任务成功保留 24h，失败保留 1h，水位超 85% 无视保留期清最旧（plan §8.3）。

### 5.6 写回闸门（F2）

**问题**：身份挂载（§4.5）让容器内的写入直接落在 worktree 里——`postinstall` 里一行 `node evil.js` 就能改 README、改 `.git/config`、甚至往 `.git/hooks/*` 里放东西。v1.0 的写回只校验「`actions` 里声明了什么」，不校验「磁盘上到底变了什么」，于是 plan §3 的核心矛盾在最后一步被绕过去：agent 说「我改的是 `src/a.ts`」，推上去的却可以是任何字节。

**闸门规则（M4 阻断项，不通过就不开 auto push）**：

1. **推送集 = 两个集合的交。** `declared` = 信封动作里显式声明的路径集合；`actual` = `git status --porcelain -z --untracked-files=all --ignore-submodules=all` 列出的实际变更集合。只有 `declared ∩ actual` 会出现在推送里，其余变更**丢弃**并记 `writeback_rejected`（`actions` 一行 + `run_events` 一条，含路径与原因）。
2. **拒收清单（硬编码，不可配置放宽）。** `.git/` 下任何路径、`.github/workflows/**`、`.gitmodules`、`.git/hooks/**`、以及任何指向仓库外的 symlink 目标。命中即整次写回失败，不是「跳过那个文件」——命中意味着容器侧有人在推边界。
3. **git 一律不执行仓库里的钩子。** 所有写回相关命令带 `-c core.hooksPath=/dev/null --no-verify` 与 `-c submodule.recurse=false`；`status`/`diff` 带 `--ignore-submodules=all`，禁止 submodule 被顺手拉起来执行。
4. **比对结果入审计。** 推送前把 `declared` / `actual` / `intersect` / `dropped` 四个集合的摘要（排序后 sha256 + 路径列表，上限 200 条）写进 `actions.audit` 与 `run_events`，面板详情页可查。

**实现：用临时 index，而不是 `git add -A`。** 在 worktree 里 `git add -A` 会把一切脏东西塞进索引，再想撤销就不可靠了。改用独立索引，worktree 自己的 `.git/index` 全程不动：

```sh
export GIT_INDEX_FILE=<job_dir>/.pi-bot/writeback.index
git -c core.hooksPath=/dev/null read-tree HEAD
git -c core.hooksPath=/dev/null add -A -- <intersect 路径…>    # 只有交集进索引
tree=$(git write-tree)
commit=$(git -c core.hooksPath=/dev/null -c submodule.recurse=false \
           commit-tree "$tree" -p HEAD -m "<bot: intent / task>")
git push origin "$commit:refs/heads/bot/<task>-<slug>"          # 永不强推
```

「推上去的字节」由索引决定，而索引只由交集路径填充；即使容器里有人改了别处，那些字节从来没有机会进入这个 commit。

**为什么不能只靠 `actions` 声明**：声明是模型写的文本，磁盘是内核写的状态，两者不是一个可信级别的东西。闸门的价值正是让前者无法代替后者。同理 `writeback_rejected` 不是错误日志而是信号——它一出现就说明「容器里的代码试图改它没被允许改的地方」，M4 之前应当有告警。

**对信封契约的一处补充**：`push_branch` 动作必须带 `paths: string[]`（相对仓库根的显式路径或 glob，服务端展开后固定），否则该动作判为不合规、直接丢弃。plan §5 的字段示例里没有这条，因为它属于「怎么实现」而非「要不要做」；但契约文档 `docs/spec/contract-envelope.md` 需要同步这一条（由那份文档的 owner 落地，本文不代改）。
---

## 6. 容器与网络

### 6.1 规格映射（plan §8.1 → dockerode HostConfig）

| plan 参数 | dockerode 字段 |
|---|---|
| `--read-only` | `HostConfig.ReadonlyRootfs = true` |
| `--tmpfs /tmp` | `HostConfig.Tmpfs = { "/tmp": "rw,size=512m,noexec,nosuid" }` |
| `--cap-drop ALL` | `HostConfig.CapDrop = ["ALL"]` |
| `--security-opt no-new-privileges` | `HostConfig.SecurityOpt = ["no-new-privileges"]` |
| `--pids-limit 512` | `HostConfig.PidsLimit = 512` |
| `--memory 2g --memory-swap 2g` | `HostConfig.Memory = 2<<30`, `MemorySwap` 同值（禁 swap）；**按 §3.6 分档：判定类 2 GB，`/review-pr` 4 GB** |
| `--cpus 2` | `HostConfig.NanoCpus = 2e9` |
| `--user 1001:1001` | `HostConfig.User = "1001:1001"` |
| `--ulimit nofile=4096` | `HostConfig.Ulimits` |
| `--init` | `HostConfig.Init = true` |
| `-v <job>:/work` | **改为身份挂载**：`Binds = ["<job>:<job>:rw"]`，`WorkingDir = <job>`（§4.5）。**plan §8.1 的 `/work` 作废**，见 §4.5 的 E1 |
| `-v pi-dep-cache:/cache:ro` | 命名卷只读挂载 |
| `sleep infinity` | `Cmd = ["sleep","infinity"]`，常驻后按需由 **exec 代理**发起 `docker exec`（命令行内置容器内 `timeout`，§4.5 / §4.7） |

镜像按工具链分：`pi-worker:node22`、`pi-worker:pnpm-node22`、`pi-worker:python312`。镜像不自带任何凭证，`/etc/pi-bot/worker-Dockerfile` 由仓库内 `images/` 管理。

**容器命名**：`pi-job-<jobId>`（`jobId` 是 bot 生成的短 id，落在 `tasks.id` 上），**不再由 worktree 路径的 sha1 推导**——路径在 agent `cd` 之后会变，而「这个 job 对应哪个容器」本来只有 bot 知道（F1，见 §4.5）。

### 6.2 网络（plan §8.2 / D7）

- 建一个专用 bridge 网络 `pi-jobs`（非 `internal`，所以能出公网）。
- 在该网桥上用 nftables 规则 DROP `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`，并覆盖 IPv6 的 `::1`、`fc00::/7`、`fe80::/10`。
- 高风险任务（会自动推分支的 `/review-pr` 修复路径）可选 `--network=none` 加固档。
- 规则以 nftables 配置文件形式随仓库发布，由 `doctor` 校验存在性，不用代码动态生成（少一处可变面）。

### 6.3 生命周期（plan §8.3）

| 结果 | 容器 | worktree |
|---|---|---|
| 成功 | 立即销毁 | 保留 24h |
| 失败（非超时） | 保留 1h 便于复现 | 保留 1h |
| 超时 / 熔断 / 取消 | **立即销毁**（`docker kill` + `remove`）——容器死则容器内所有进程一起死，这是唯一确定的终止语义（§4.7） | 立即回收 |
| 磁盘 > 85% | 清最旧的失败容器 | 清最旧的 worktree |

清理由一个 pg-boss 定时任务（每分钟）执行，规则集中在 `lifecycle.ts` 一处，便于把 plan §8.3 的表格逐行对上。两个必须写在销毁路径上的动作：**(a) 销毁前先 `inspect` 一次**，采 `State.OOMKilled` 与 `State.ExitCode` 落库——容器没了就读不到，§7.3 的 `sandbox-oom` 判定全靠这一次采集；**(b) 同时 `unlink` 该 job 的 `<job_dir>/.pi-bot/exec.sock`** 并从代理的映射表删条目，否则 agent 的下一条命令会打到一个已经不存在的容器上。

### 6.4 `pi-bot doctor`（plan §8.5，不通过拒绝启动）

检查项与实现：docker daemon 可达（dockerode `ping`）· 磁盘 ≥20 GB（`statfs`）· worker 镜像存在且工具链版本匹配（`docker run <img> node -v`）· 金丝雀容器访问 `169.254.169.254` **确实失败**· `--memory`/`--cpus` 真的生效（在容器内读 cgroup 值，而不是相信参数）· Postgres 可连且迁移已到最新 · pi-host 可用（`connection/ping`）· `PI_DESKTOP_BASH` 指向的文件可执行 · nftables 规则命中 · **`vendor/pi-host/<version>/PIN.json` 的每份 SHA256 与 `hostVersion` 全部匹配**（§2.2，不匹配即 `fail`，`--allow-host-version-mismatch` 只放宽协商版本）· **pi-host 进程树的 `/proc/<pid>/fd` 里没有 `docker.sock`**（把 §3.3「socket 只在 bot」变成检查而不是约定）· **能在一个临时 job 目录里创建 `0600` 的 `.pi-bot/exec.sock` 并跑通一次 exec 代理往返**（§4.5 的端到端自检）。

每一项输出 `ok/warn/fail` 三态；`fail` 任一则退出码非零，systemd 侧配 `ExecStartPre=-/usr/local/bin/pi-bot doctor`（加 `-` 让它失败时仍能启动以暴露错误，但 `/healthz` 返回 503 并在面板顶部横幅显示）。
---

## 7. 持久化与队列

### 7.1 为什么是「一个 Postgres」，不是 Redis + DB

- pg-boss 用 PG 的表实现队列：`SKIP LOCKED` 拉取、`retryLimit`/`retryDelay`/`retryBackoff` 重试、`startAfter` 延迟、`expireIn` 超时可见、`singletonKey` 去重、dead-letter 队列、定时任务、完成后归档。我们要的队列语义它都有了。
- 队列与业务数据同库 → **一个备份、一套迁移、一个连接池**，MVP 的自托管运维成本减半。
- 规模远未到需要 Redis 的程度：<100 事件/天、2–4 并发。Redis 只会多一个需要持久化保证的组件（队列丢了就是事件丢了）。

已知差异要接受：PG 队列的延迟精度在「秒」级（靠轮询），不是 Redis 的毫秒级；对本项目完全够。

### 7.2 数据模型

| 表 | 关键列 | 用途 |
|---|---|---|
| `webhook_deliveries` | `delivery_id` (PK), `event`, `action`, `payload` jsonb, `received_at` | 去重 + 90 天原文保留 + replay 数据源 |
| `repos` | `repo_full_name` (PK), `enabled`, `dry_run`, `config` jsonb, `config_valid` | 仓库开关与 `.github/pi-bot.yml` 快照 |
| `tasks` | `id`, `source`(webhook/command/cron), `repo`, `target_kind`, `target_number`, `head_sha`, **`command`**, **`actor_login`**, **`queued_at`**, `idempotency_key` (unique), `status`, `container_name` | 任务主体。`command`（`/review-pr` 等，判定类记 `auto:triage`）、`actor_login`、`queued_at` 三列在**入队时**从 payload 抽出写死（§5.3 第 6 步），不允许 worker 回填 |
| `runs` | `task_id`, `attempt`, `session_id`, `turn_id`, `started_at`, `ended_at`, `outcome`, `failure_class` | 一次执行；失败分类是 panel 的统计维度 |
| `run_events` | `run_id`, `cursor`, `kind`, `payload` jsonb | 事件流落库，供详情页时间线与断线重放 |
| `envelopes` | `run_id`, `verdict` jsonb, `actions` jsonb, `usage` jsonb, `valid` bool | 结构化产出（plan §5），校验失败的也留 |
| `actions` | `run_id`, `intent`, `target`, `external_ref`, `applied_at`, `reverted_at`, `revert_kind`, `audit` jsonb | 每次写操作的审计与「被改回」的关联点；`audit` 存写回闸门的 `declared`/`actual`/`intersect`/`dropped` 摘要与 `writeback_rejected` 原因（§5.6） |
| `bot_labels` | `repo`, `issue_number`, `label`, `applied_at`, `removed_at` | 我们打过哪些标签（plan §6.1 只动自己的） |
| `issue_fingerprints` | `repo`, `fingerprint`, unique | 主动建 issue 的去重键（plan §6.3） |
| `issue_states` | `repo`, `issue_number`（复合 PK）, `missing_set_hash`, `first_seen_at`, `last_human_reply_at`, `last_nudge_at`, `closed_at` | plan §6.2「只在缺失项集合变化时再回复」与 §7 关闭条件的**唯一判定源**（UPSERT 时机见下方说明） |
| `usage_costs` | `run_id`, `model`, `input_tokens`, `output_tokens`, `cost_usd` | 成本面板 |
| `degeneracy_hits` | `run_id`, `criterion`, `detail` jsonb | plan §9.3 的熔断留痕 |
| `metrics_daily` | `day`, `repo`, `outcome`, `count`, `p50_ms`, `p95_ms`, `cost_usd`, `revert_count`, `command_cost_usd` jsonb；**`UNIQUE (day, repo, outcome)`** | 每日预聚合，面板长期趋势用它（指标永久）；幂等 UPSERT 与「为什么保留」见 §7.6 |
| `host_credentials` | `host_id`, `token_enc`, `version`, `expires_at` | RACP 设备令牌（AES-256-GCM） |
| `runtime_flags` | `key`, `value`, `until` | 全局熔断、暂停开关 |
| `panel_sessions` | `sid`, `login`, `expires_at` | 面板会话（服务端存，便于吊销） |

迁移用 drizzle-kit 生成到 `migrations/`；pg-boss 自己的 `pgboss` schema 由库自行创建，两套互不干扰（`search_path` 显式声明）。

**`tasks.idempotency_key` 怎么生成（F9）**：`sha256([kind, repo, target, anchor, trigger_actor].join("\n"))` 取 hex 前 32 位。`anchor` 按 kind 二选一——PR / 命令类用 `head_sha`（同一提交重跑是空操作，plan §6.4）；issue 判定类用 `missing_set_hash`（没有提交可锚，而「同一批缺失项」正是重复回复的判据）。`trigger_actor` 进键是有意的：人工 `/retry` 与 webhook 重投必须能区分，否则「重跑」会被唯一键吃掉。`kind` 取 `triage` / `compliance` / `command:/review-pr` / `create_issue` 这类短串。

**`issue_states` 的 UPSERT 时机与关闭判定（F4）**：没有这张表，「只在缺失项集合变化时再回复」（plan §6.2）与「48h 未变 + 无人回复」（plan §7）都无法判定——前者要记住上次的集合，后者要记住「最近一次人工回复」。写入点只有两处：

1. **合规判定产出之后**（每次判定任务结束）：算 `missing_set_hash = sha256(sorted(未通过的规则 id))`，再
   `INSERT ... ON CONFLICT (repo, issue_number) DO UPDATE SET missing_set_hash = EXCLUDED.missing_set_hash, first_seen_at = CASE WHEN issue_states.missing_set_hash = EXCLUDED.missing_set_hash THEN issue_states.first_seen_at ELSE now() END`。
   - 回复条件：新 hash ≠ 旧 hash，或 `last_nudge_at IS NULL`。hash 没变且已经催过，**不再回复**（plan §6.2「同一句话不催第二次」），发完记 `last_nudge_at = now()`。
   - 集合从「有缺失」变成「无缺失」：`first_seen_at` 置 NULL，并按 plan §6.1 的「只动自己打过的」撤掉 `needs-info`。
2. **收到该 issue 的 `issue_comment.created`**（`author_association ∈ {MEMBER, OWNER, COLLABORATOR}` 且 author 不是机器人）：`UPDATE issue_states SET last_human_reply_at = now()`。这是唯一会推进该字段的事件——机器人自己的评论、编辑事件都不算。

**关闭判定只读这张表**，不发任何 GitHub 请求、不看 `actions` 历史：`needs-info` 在标签里 ∧ `missing_set_hash IS NOT NULL` ∧ `now() - first_seen_at >= interval '48 hours'` ∧ (`last_human_reply_at IS NULL OR last_human_reply_at <= first_seen_at`) ∧ `closed_at IS NULL`。满足则关 issue 并写 `closed_at`；任一不满足就什么都不做。把条件压到一张表上，是因为「关闭」是 plan 里唯一不可回收的自动动作——判定链越短越好核。

### 7.3 重试矩阵（plan §9.2 → pg-boss）

**先判优先级，再查矩阵（F6）**：一次 run 可能同时「像」崩溃又「像」超时——任务级超时的实现就是 kill 容器，从容器退出码看和崩溃没有区别。所以分类必须在**观测到的全部信号**上按固定优先级取一个，写进 `runs.failure_class`（其余信号落 `runs.failure_detail` jsonb 供审计），重试决策**只读最高优先级的那一个类**：

| 优先级 | `failure_class` | 判定依据 | 重试 |
|---|---|---|---|
| 1 | `timeout` | 任务级 deadline 触发（`runWithDeadline` 抛出，带 `cause`） | **否**（只接受人工 `/retry`） |
| 1 | `interrupt` | 取消信号导致的 `turn/interrupt` | **否** |
| 1 | `degenerate-output` | §7.4 的重复输出判据命中 | **否** |
| 2 | `sandbox-oom` | 容器 `State.OOMKilled === true`（销毁前 `inspect` 采集，§6.3） | **否**——OOM 是配置/体量问题，自动重试只会再 OOM 一次（解法是 §3.6 的分档） |
| 3 | `sandbox-crash` | 容器非零退出，且未被上面任何一条命中 | 最多 1 次，第二次转异常兜底 |
| 4 | `auth` / `rate_limit` / `model` / `parse` / `github_api` | 各自的确定性判据（HTTP 状态、Ajv 校验失败等） | 见下表 |

第 1 优先级里三类并列的理由：它们都表示「这轮不该继续，也不该自动重来」，具体落哪一个只影响面板文案，不影响决策。**没有这张表，F6 的问题就是真实的**：一个超时任务会因为 `sandbox-crash` 的 `retryLimit: 1` 被自动重跑一次，直接违反 plan §9.1。

| 错误类别 | pg-boss 配置 | 备注 |
|---|---|---|
| 429 限流 | 优先读 `retry-after` → `boss.send(..., { startAfter })` 重投；最多 4 次 | 不走 `retryLimit`，因为退避时长要按响应头决定 |
| 5xx / 网络抖动 | `retryLimit: 3`, `retryDelay: 30`, `retryBackoff: true` | 指数退避 + 抖动由 `retryBackoff` 给 |
| `sandbox-crash`（优先级 3） | `retryLimit: 1` | 第二次仍崩 → 判环境问题 → 转异常兜底；`sandbox-oom` 不走这条路 |
| 401/403/其他 4xx | 处理函数返回 `{ retry: false }` | 直接进异常兜底 |
| 结果解析失败 | `{ retry: false }` | 重试只会得到同样的坏输出 |
| 命令级超时 | `{ retry: false }` | 交给 agent 换策略 |
| 任务级超时 | `{ retry: false }` | plan 明确「超时不自动重试，只接受 /retry」。判定只读 `failure_class`，**不看容器退出码**（F6） |

非幂等写的兜底：重试前先查现状（`actions` 表 + 隐藏标记），不是靠「反正重试一次也没事」。

### 7.4 熔断

- **重复输出熔断**（plan §9.3）：在事件流上做流式检测（§2.5 S2），命中即 `turn/interrupt`，任务标 `degenerate-output`，不重试。
- **全局 429 熔断**：连续 5 次 429 → 写 `runtime_flags{key:'rate_limit_pause', until: now+15min}`；worker 在取任务前读该 flag，为真则直接延迟重投。这里**不自研通用熔断库**（`opossum` 的语义是「打开后快速失败」，我们要的是「暂停入队」，硬套只会扭曲语义），40 行计数器足够。

### 7.5 「自动执行后被人改回」怎么算（plan §6.5 的质量指标）

这是 plan 里唯一的质量信号，也取消阈值后唯一能验证「它是否可信」的东西。实现：

1. 每次写操作落 `actions` 行（谁、何时、写了什么、外部引用 id）。
2. 接收三类反向 webhook：`issues.unlabeled` / `issues.edited`（撤销标签）、`pull_request_review` 里 human 的 `request_changes`、`pull_request.closed` 且未合并。
3. 关联逻辑：在写操作后 7 天窗口内，同一 target 上出现上述事件 → `actions.reverted_at` 置位并记 `revert_kind`（`label-removed` / `changes-requested` / `pr-closed`）。
4. 兜底：每小时跑一次 reconcile 任务，用 Octokit 重查最近 7 天的 `actions` 对应现状，防止漏投递（webhook 会丢，这是常识）。

面板的「改回率」= 置位的 actions / 已应用的 actions，按命令类型与仓库分组。

### 7.6 保留期与聚合

| 数据 | 保留 | 机制 |
|---|---|---|
| webhook 原文 | 90 天 | 每日 pg-boss cron 清理 |
| `run_events` 明细 | 90 天 | 同上，先聚合进 `metrics_daily` |
| transcript（host-core SQLite） | 90 天 | 每日 `session/delete` |
| `metrics_daily` / `actions` / 审计 | **永久** | 不删（plan §12 待定的默认值）；`actions` 永久是「被改回」可追溯的前提 |
| worktree | 24h / 1h（失败） | §6.3 |

聚合任务每天 00:10 跑，写 `metrics_daily`；面板的长期图表只读这张表，明细查询走 `runs` + 时间范围索引，避免面板查询拖垮在线事务。

**为什么保留预聚合，而不是直查（F10，二选一里选了「留」）**：D9 的规模（<100 事件/天）下直查 `runs` 完全跑得动，「删表」本来可行；但 `runs` 与 `run_events` 明细只留 90 天，而 plan §12 的默认值是「指标永久」——删掉预聚合就等于 90 天前的趋势不可再算且不可回填。两条路里只有「留」满足永久性，所以留。代价是必须补上 v1.0 缺的两个东西：

- **必须幂等**：`UNIQUE (day, repo, outcome)` + `INSERT ... ON CONFLICT (day, repo, outcome) DO UPDATE`，`count` / `p50_ms` / `p95_ms` / `cost_usd` **全量覆盖而不是累加**。这样重跑某一天、或补跑漏掉的日期，结果都一样；否则「重跑一次聚合」会把数字翻倍，而面板的数字是唯一质量信号，翻倍等于失真。
- **必须带质量维度**：加 `revert_count`（当天置位的 `actions.reverted_at` 计数）与 `command_cost_usd` jsonb（按 `command` 拆的成本）。`revert_count` 单独成列而不是往 `outcome` 里加值，是因为「被改回」是写操作维度的信号、不是 run 结果维度；按命令拆分塞不进 `(day, repo, outcome)` 这个键，用一列 jsonb 承载是刻意取舍——键保持三列（才能 UPSERT），命令维度以近似值呈现，精确拆分仍走 `usage_costs` + `actions` 的短窗口直查。
---

## 8. 后端基本结构

### 8.1 仓库布局（pnpm workspace）

```
pi-issue-bot/
├─ apps/
│  ├─ server/                 # 控制面：Fastify + worker，单进程可执行
│  └─ panel/                  # React SPA，构建产物由 server 托管
├─ packages/
│  ├─ contract/               # zod 定义 + 由 OpenAPI 生成的 panel 客户端类型
│  ├─ racp-client/            # RACP-WS 客户端（自研，S1）
│  ├─ envelope/               # 任务信封 JSON Schema + Ajv 校验器
│  └─ shared/                 # logger、redaction、Result 类型、runWithDeadline
├─ images/                    # pi-worker:node22 等 Dockerfile
├─ deploy/                    # systemd unit、compose.yaml、Caddyfile、nftables.conf
├─ migrations/                # drizzle-kit 产物
├─ scripts/                   # doctor / replay / bootstrap-host 入口
└─ docs/
```

### 8.2 server 内部模块

| 模块 | 职责 | 依赖 |
|---|---|---|
| `http/` | Fastify 主实例（绑 3000，只被 Caddy 反代）、插件注册、错误映射、`/healthz` | contract |
| `http/metrics.ts` | **独立**的 prom-client 服务，绑 `127.0.0.1:9464`，不挂任何 `/api` 路由（§10.1） | prom-client |
| `http/webhook.ts` | 原始 body → 验签 → 去重 → 入队 | github/, queue/ |
| `http/api/` | 面板只读 API（§8.3） | queries/ |
| `queue/` | pg-boss 封装：队列定义、并发、重试策略、定时任务 | config, db |
| `worker/` | 任务编排：检出 → 容器 → run → 校验 → 写回 | 下面全部 |
| `runtime/` | pi-host 子进程监督 + RACP 客户端装配 + 审批策略 | racp-client |
| `sandbox/` | 容器生命周期、**exec 代理（unix socket 服务）与 exec 客户端**、水位清理、shim 安装 | dockerode, shared |
| `skills/` | 命令即技能：frontmatter 解析、仓库级覆盖、参数渲染与校验（契约见 `docs/spec/contract-skill.md`） | contract |
| `git/` | clone / worktree / diff / **写回闸门（§5.6）** / push | 系统 git |
| `github/` | App 认证、Octokit 工厂、写执行器 | octokit |
| `envelope/` | 信封校验 + 动作过滤器（不合规动作丢弃） | envelope 包 |
| `degeneracy/` | 重复输出检测（S2） | shared |
| `queries/` | 面板查询（纯 SQL，只读） | db |
| `config/` | `.github/pi-bot.yml` 加载 + schema 校验 + 仓库开关 | contract |

**依赖方向硬约束**（用 `dependency-cruiser` 或 ESLint `import/no-restricted-paths` 卡住）：

```
http/api → queries → db
http/webhook → github, queue
worker → runtime, sandbox, git, envelope, github, degeneracy
runtime → racp-client
任何模块 → shared / contract（叶子，不反向依赖）
```

`queries/` 不得 import `worker/` 任何东西——面板只读，不允许顺手调用业务函数。

### 8.3 面板 API（只读 + 一个导出）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/overview` | 吞吐、结果分布、p50/p95、队列深度、熔断状态、doctor 摘要 |
| GET | `/api/tasks` | 列表：仓库/状态/失败分类/时间范围/命令类型，游标分页 |
| GET | `/api/tasks/:id` | 详情：runs、事件时间线、信封、动作、diff |
| GET | `/api/costs` | 按仓库/命令/模型拆分；最贵十个任务 |
| GET | `/api/quality/reverts` | 改回次数与比例，按命令与仓库 |
| GET | `/api/audit` | 审计查询（谁触发、跑哪个 sha、写了什么、审批判定） |
| GET | `/api/audit/export.csv` | 流式导出（CSV，`text/csv`） |
| GET | `/api/system` | host 版本/能力、pi-host 状态、队列配置、保留期 |
| POST | `/webhook` | GitHub 投递（唯一写入口，但只入队） |

全部 GET 只读、无副作用；面板不做任何写操作（MVP 无「重跑」按钮，`/retry` 走 GitHub 评论指令，权限与审计都更自然）。OpenAPI 由 `@fastify/swagger` 从 zod 生成，面板用 `openapi-typescript` 生成类型，杜绝手写 DTO。

**这些查询不许解 jsonb（F9）**：`/api/costs` 的「按命令拆分」读 `tasks.command`，`/api/quality/reverts` 的「按命令分组」读 `tasks.command` + `actions.revert_kind`，`/api/audit` 的「谁触发」读 `tasks.actor_login`（§7.2 的三列）。入队时写死意味着面板查询是纯列扫描，不夹带 jsonb 解析、也不需要在查询期回填——这也是那三列不能留给 worker 补的原因。

### 8.4 可执行文件与子命令

单一入口 `pi-bot`：

```
pi-bot serve            # 默认：HTTP + worker 同进程
pi-bot doctor           # 预检（§6.4）
pi-bot bootstrap-host   # 首次配对（§4.2）
pi-bot replay <id>      # 用 webhook_deliveries 的原文重放一个投递（强制 dry-run）
pi-bot migrate          # 跑 drizzle 迁移
```

`serve` 与 worker 同进程是刻意的：规模小（2–4 并发），拆两个进程只会多一套部署与信号处理。真要扩时把 `--worker-only` 打开即可，因为队列在 Postgres 里，天然可分进程。

---

## 9. 面板基本结构

### 9.1 技术形态

Vite 8 + React 19 SPA，Tailwind 4（`@tailwindcss/vite`，无 config 文件），shadcn/ui 组件按需 `pnpm dlx shadcn@latest add` 复制进仓库，Recharts 画图，TanStack Query 取数，TanStack Table 管表格。**不做 SSR**：面板是内网只读工具，没有 SEO 与首屏诉求，SPA 是最短路径。

### 9.2 目录与路由

```
apps/panel/src/
├─ routes/
│  ├─ overview.tsx        /
│  ├─ tasks.tsx           /tasks
│  ├─ task-detail.tsx     /tasks/:id
│  ├─ costs.tsx           /costs
│  ├─ quality.tsx         /quality
│  ├─ audit.tsx           /audit
│  └─ system.tsx          /system
├─ components/
│  ├─ ui/                 # shadcn 生成物（table, badge, tabs, select, dialog, toast...）
│  ├─ charts/             # StatCard / TrendChart / DistributionBar / CostBreakdown
│  ├─ charts/chart.tsx    # shadcn 的 chart 包装（Recharts + CSS 变量主题）
│  └─ tables/DataTable.tsx# TanStack Table + 列定义驱动的通用表格
├─ lib/api.ts             # openapi-fetch 客户端（类型来自 contract）
├─ lib/queries.ts         # useQuery / useInfiniteQuery 封装，集中管 refetchInterval
└─ lib/format.ts          # 时长、金额、token、相对时间
```

### 9.3 每页的数据来源与呈现

| 页面 | 数据源 | 主要呈现 |
|---|---|---|
| 总览 | `/api/overview` | 4 个 StatCard（今日事件/成功率/p95/队列深度）+ 24h 趋势折线 + 结果分布堆叠柱 + 失败分类 Top5 条形 |
| 任务列表 | `/api/tasks` | DataTable：时间、仓库、类型、状态徽章、耗时、成本、失败分类；筛选栏用 shadcn Select + 日期范围 |
| 任务详情 | `/api/tasks/:id` | 三段式：事件时间线（含每次审批判定）· 信封 JSON（verdict/evidence/actions 分栏）· diff（`workspace/diff` 原文，等宽字体） |
| 成本 | `/api/costs` | 按仓库/模型的堆叠柱 + 最贵十个任务的表 |
| 质量 | `/api/quality/reverts` | 改回率大数字 + 按命令类型的分组条形 + 逐条改回记录（点进去到任务详情） |
| 审计 | `/api/audit` | DataTable + 筛选 + 「导出 CSV」按钮（`openapi-fetch` 拿 blob） |
| 系统 | `/api/system` | pi-host 版本与能力、doctor 各项 ok/warn/fail、保留期配置、nftables 状态 |

### 9.4 实时性与交互约定

- **轮询而不是 SSE**：`refetchInterval` 总览 10s、列表 15s、详情 5s（详情页可能正在跑）。规模小，SSE 的复杂度不值当；接口层预留 `/api/stream` 的位置注释，将来要推再换。
- 所有数字统一走 `lib/format.ts`：时长 `1m 20s`、金额 `$0.0412`、token `12.4k`、时间相对量 + title 显示绝对时间。
- 空态、加载骨架、错误提示由 shadcn 的 Skeleton / Alert 统一，不手写。
- 主题只用 shadcn 的 CSS 变量（`--chart-1..5`），暗色跟随系统，图表配色不硬编码。
---

## 10. 可观测性与密钥管理

### 10.1 两类指标，职责分开

| 目的 | 载体 | 内容 |
|---|---|---|
| 运维看「机器还行不行」 | Prometheus（`prom-client`，`/metrics`，独立实例绑 `127.0.0.1:9464`） | 进程 CPU/内存、队列深度、HTTP 延迟直方图、429 计数、容器数量、磁盘水位 |
| 人看「它干得好不好」 | 面板（读 Postgres） | 吞吐、结果分布、p50–p95、失败分类、成本、改回率、审计 |

同一件事两边都有（队列深度），这是有意的：Prometheus 用来配告警，面板用来给人看。**不为了「单一事实源」把面板塞进 Grafana** —— 面板是产品的一部分（plan §6.5），Grafana 只作为可选的运维补充，不进 MVP 必装清单。

**`/metrics` 单独绑 `127.0.0.1:9464`（F10）**：用独立的 Fastify（或不带路由的 `http.createServer`）实例提供，只监听 loopback，**不与 `/api` 共用 3000 实例**；`deploy/Caddyfile` 里没有 `/metrics` 这一条，所以公网抓不到。理由两条：`/metrics` 会暴露容器数量、队列深度、失败率，属于内网信息；而它又必须无条件可抓（Prometheus 抓不到就是告警失灵），不能挂在需要面板鉴权的实例后面。若确实要跨机抓取，在 Caddy 上加 `@prom remote_ip <Prometheus 地址>` 白名单再反代 9464——白名单写在部署配置里，不写进代码。

### 10.2 日志

- pino 10，JSON 行，`redact` 覆盖 `authorization`、`token`、`secret`、`key`、`password` 等字段路径。
- 贯穿 id：`delivery_id`（GitHub 投递）→ `task_id` → `run_id` → `turn_id`，四级都在日志里，任一个都能串出全链路。
- 敏感前缀额外加一道「值级」脱敏：`pdt1.` / `ppt1.` / `ghs_` / `ghu_` / `ghp_` / `github_pat_` / `gho_` / `ghr_` 出现在任何字符串里都替换为 `<redacted>`。这是 plan §10「日志不得出现密钥」的机械保证，不靠人自觉。
- 再加两条形状匹配，覆盖 v1.0 漏掉的凭证类型：**App JWT**（`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.` 三段式——不能裸匹配 `eyJ`，它是绝大多数 JWT 的 base64 头，裸匹配会把正常数据一起吞掉）；**PEM 私钥块**（`-----BEGIN` 起、吞到 `-----END` 收，避免只脱敏第一行而把密钥体留在日志里）。
- 输出走 journald（`StandardOutput=journal`），不自己写文件轮转。

### 10.3 链路追踪

MVP **不接 OpenTelemetry**。理由：单机、链路最多 4 跳、p95 目标 90s 量级，`run_events` 的时间线已经能回答「慢在哪一步」。等出现跨机（多 Host）时才值得接，`run_id` 已经埋好，接的时候只是加 span。

### 10.4 密钥清单与存放

| 密钥 | 存放 | 谁能读 |
|---|---|---|
| GitHub App 私钥（`*.pem`） | `/etc/pi-bot/app.pem`，`0600 root:pi` | bot 进程 |
| webhook secret | systemd `EnvironmentFile`，`0600` | bot 进程 |
| 模型 API key | 同上，由 bot 继承给 pi-host 子进程 | bot + pi-host（可信侧） |
| RACP 设备令牌 | PG `host_credentials.token_enc`，AES-256-GCM，key 来自 `EnvironmentFile` | bot 进程 |
| PG 口令 | `EnvironmentFile` | bot 进程 |
| OAuth App secret | `EnvironmentFile` | bot 进程 |
| GitHub 令牌（运行时） | **只在内存**，1h 过期由 `@octokit/auth-app` 管 | bot 进程 |

红线复述（plan §8.4）：以上**任何一项都不进容器**。容器里唯一的环境变量是 PATH、HOME、语言工具链变量。

轮换路径：App 私钥与 webhook secret 换完重启；设备令牌失效就 `pi-bot bootstrap-host --repair` 重新配对并 `session/revoke` 旧的（RACP 提供了吊销操作，不用删库）。

---

## 11. 风险与开放项

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | `PI_DESKTOP_BASH` 覆盖在某版 Host 被收紧，或后台任务/命令树终止路径不经过它 | 命令跑在宿主而不是容器，D5 失效 | M0 用真实 bundle 验证三条路径（前台命令、后台任务、超时 kill）；失败则改走 `tools/advertise` relay（规范 §9.4 已定义待实现），或退化为「每任务一个 pi-host + 容器内 agent」并接受 plan §4.3 列出的代价 |
| R2 | 单 pi-host 多 session 并发是否互相排队（Host 有全局 turn 队列，D386） | 并发上不去，p95 超标 | M0 压 4 并发观察 `turn/start` 的 queued 状态；不满足就每 2 个并发槽一个 pi-host 进程（各自 data-dir），代价是内存 |
| R3 | 面板鉴权（plan §12 待定 3） | 阻塞 M3 | 定为 **GitHub OAuth App + org 成员校验**，不做组织 SSO。会话**只**存服务端 `panel_sessions` 表（`sid` / `login` / `expires_at`），cookie 只带 `sid`（HttpOnly / Secure / SameSite=Lax），7 天过期、可单条吊销；cookie 里不放任何身份信息或签名载荷，避免「cookie 说是谁就是谁」 |
| R4 | 标签体系来源（plan §12 待定 1） | 阻塞 M1 | 定为**沿用仓库现有标签 + `.github/pi-bot.yml` 映射**，不强制默认集；映射缺失的判定降级为「只评论不打标」并记 warn |
| R5 | 主动建 issue 的场景范围（plan §12 待定 2） | 阻塞 M3 | 定为**只做「PR review 顺带发现的独立缺陷」**；「同类 issue 汇总」关闭 |
| R6 | 面板不读 transcript 原文（它在我们读不到的 SQLite 里） | 详情页信息量受限 | 有意为之：详情页展示我们自己的事件时间线 + 信封 + diff；不把不可信内容灌进面板。要读原文就 SSH 到宿主用既有工具看 |
| R7 | pg-boss 12 需显式 `createQueue`，升级大版本会变 API | 升级踩坑 | 队列定义集中在一个文件，加一条启动时自检（队列不存在则建） |
| R8 | 重复输出检测误杀（正常任务被判定退化） | 好任务被打断 | 三个判据都要求强证据（200 字符窗口 ×3 / 增量 <5% / 同工具同参数 ×3 且无状态变化）；误杀时任务标 `degenerate-output` 但不重试，靠审计可见并调阈值，不做自动学习 |
| R9 | `git worktree` 与容器内 `git` 版本差异导致 diff 格式不同 | 详情页 diff 展示异常 | diff 统一由 `workspace/diff`（host-core 产出）提供，不用容器内 git |
| R10 | 契约与 bundle 钉扎之后，上游修 bug / 打安全补丁都需要人工开升级 PR | 紧急的 host-core 缺陷会滞后一个升级周期 | 每两周巡检一次上游 release；安全类通告走 24h 内的 hotfix PR；`doctor` 拒绝「哈希匹配但与协商版本不一致」的半升级状态；`PIN.json` 的 `upstreamRef` 保证每次升级都能溯源到上游提交 |

---

## 12. 落地顺序（技术侧任务，对应 plan §11 的 M0–M4）

| 里程碑 | 技术交付 | 验收 |
|---|---|---|
| **M0** | pnpm 工作区骨架；`vendor/pi-host/<version>/` 落地 + `PIN.json` 校验（§2.2）；`racp-client` 能连上真实 pi-host 并跑通 initialize/pair/subscribe；`sandbox-bash` shim + **exec 代理（unix socket，含容器内 `timeout`）** + 身份挂载；`pi-bot doctor` 的 docker 与网络项 + `docker.sock` 归属检查；`webhook_deliveries` 去重；`pi-bot replay` | 一条真实事件端到端跑到「信封产出」，GitHub 零副作用；R1/R2 两个风险有实测结论；`NO_EXEC_ENDPOINT` 与「容器内进程真的被杀」各有一个人造用例 |
| **M1** | 信封校验与动作过滤；comment/label 执行器（含隐藏标记、标签归属）；`.github/pi-bot.yml` 加载与 schema 校验；首周 dry-run 开关；overview/tasks 两个页面骨架 | 20 条历史 issue 回放，面板能看结果分布与耗时 |
| **M2** | 命令注册表与 `author_association` 鉴权 + 技能 frontmatter 加载与校验（`docs/spec/contract-skill.md`）；10 秒应答（handler 内 reaction）；排队闸门定时任务；`/review-pr` 真实检出与测试；三层时间闸；`failure_class` 优先级 + 重试矩阵；重复输出熔断；`degeneracy_hits` | 3 个真实 PR 结论可复现；人造 429、死循环、队列积压、容器 OOM 四种情形都被正确分类，且都不被自动重试 |
| **M3** | 成本与质量查询、改回检测（含 hourly reconcile）、审计与 CSV 导出、system 页；主动建 issue 的去重与配额 | 面板数字与 SQL 直查一致；改回率能人工核对 |
| **M4** | **写回闸门（§5.6）为阻断项**——闸门未通过就不得开启默认 auto 的 `push_branch`；`push_branch` + 开 PR（默认 auto）；`close_issue` 确定性条件（只读 `issue_states`）；分支回收 | 关闭路径不误触发；分支可整批回收；`writeback_rejected` 的人造用例（容器内改 `.git/config`、改未声明文件、放 hook）全部被拦下并留审计 |

每个里程碑都以「仓库开关 + dry-run」交付，dry-run 永久保留（plan §11）。

---

## 13. 本文对 plan §13 的逐项回答索引

| plan §13 要求 | 本文位置 |
|---|---|
| 进程与部署形态 | §3 |
| 队列与持久化选型 | §7.1 / §7.2 |
| agent 调用方式（RACP vs in-process） | §4.1 |
| GitHub App 集成方式 | §5 |
| 容器编排 | §6 |
| 面板数据来源 | §9.3 / §8.3 |
| 可观测性与密钥管理 | §10 |
| 后端语言结论与理由 | §1 |
| 成熟库 vs 自研的逐项说明 | §2 |
