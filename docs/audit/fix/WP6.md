# WP6 · 记录完整性（FR-6.1 / FR-6.2 / FR-6.3 / NFR-6）

- 需求：`docs/requirements.html` §5.6 记录与查询（`:1189-1221`）、§8 数据需求（`:1804-1821`）、§9 非功能需求（`:1823-1841`）。
- 结论一句话：三件事里 **「能否拼出完整链路」从「不能」变成「能」**（新增 `GET /api/issues/{owner}/{name}/{kind}/{number}/trace`，一次给全 投递 → 判定 → 执行 → 写回 + 工具明细 + 按轮次用量）；**顺带修掉一个让 FR-6 在真实库上静默失效的映射缺陷**（`runs.outcome`）。FR-6.2 的 `argv` / 退出码、FR-6.1 的「逐 token 流式正文」受**上游事件形状**限制，只做到「Host 报了就记，没报就是 `null`」，见 §4。
- 未改需求文档、未 `git add` / `git commit`、未碰 `compact/` `runtime/` `agent/` `app/` `writeback/` `workflows/` `db/schema.ts` `migrations/`。

## 一、需求原文逐条摘录（不许转述）

> `docs/requirements.html:1191-1195`
>
> **FR-6.1 完整对话记录**（P0）：会话内每一轮的用户输入、助手输出、工具调用与结果，全部按顺序落库。
> **来源要求：**必须由执行侧生成，不能依赖 agent 在回答里自述——自述只是声称，不是证据。

> `docs/requirements.html:1197-1200`
>
> **FR-6.2 工具调用记录**（P0）：每次工具调用记录：工具名、入参、返回摘要、耗时、成功与否。命令类还要记录 argv、退出码。

> `docs/requirements.html:1202-1205`
>
> **FR-6.3 token 与成本**（P0）：按轮次记录 prompt token 与 completion token，并折算成本。可汇总到 issue、仓库、时间维度。

> `docs/requirements.html:1216`（FR-6.4③ 事件时间线）
>
> | 事件时间线 | 投递 → 判定 → 执行 → 写回；被忽略的事件也能看到原因 |

> `docs/requirements.html:1837`（§9 非功能需求「可追溯」）
>
> | 可追溯 | 任一 issue 的处理过程可回放 | 对话 + 工具 + 用量三线齐全 |

NFR-6 这个编号在 `docs/requirements.html` 正文里不存在（正文只有维度名「可追溯」）；编号版原文出自 `docs/audit/verification-plan-v2.md:463`：
> `- NFR-6 可追溯（任一 issue 处理过程可回放，对话+工具+用量三线齐全）`

## 二、逐条对照表（需求原文 | 改前 | 改后 | 证据）

| # | 需求原文要点 | 改前 | 改后 | 证据（文件:行号） |
|---|---|---|---|---|
| FR-6.1-a | 「每一轮的…工具调用与结果…落库」 | **已满足**（`run_events` 逐条落库，`cursor` 单调；`item.delta` 有意不落，见 §4） | 不改码 | `apps/server/src/worker/run-task.ts:607-616`（`appendEvent` 串行写，失败只 warn）、`apps/server/src/db/schema.ts:296-313` |
| FR-6.1-b | 「助手输出…**必须由执行侧生成，不能依赖 agent 自述**」 | **部分满足**：会话视图的机器人正文取自 `envelopes.actions[comment].body`，那正是 agent 自述 | **补上读出口**：trace 的 `runs[].assistantText` 取 `run_events` 里 `item.completed.payload.event.message.content`（执行侧事件流） | 写入：`apps/server/src/worker/run-task.ts:990-992`（除 `item.delta` 全落库）；读取：`apps/server/src/queries/trace.ts:383-400`（`ASSISTANT_SQL`）；用例：`apps/server/test/queries-trace.test.ts:304-316`（含「信封写了别的正文也以事件流为准」的对照） |
| FR-6.1-c | 「用户输入…落库」 | 已满足（首轮 `tasks.prompt_text` / `agent_messages.comment_body`；工具循环第 2..N 轮的 `turnPrompt` 不落库） | 不改码（属 `worker/`，不在本包可写面） | `apps/server/src/agent/store.ts:147-149`；缺口见 §4-3 |
| FR-6.2-a | 「工具**名**」 | 已满足（会话视图 `toolCalls[].name`） | 不改码 | `apps/server/src/queries/issues.ts:941`（`payload.event.toolName`，真库唯一有名字的地方） |
| FR-6.2-b | 「**入参**」 | **部分满足**：只有 160 字单行摘要，多行 `Bash` 只留第一行 | **补齐**：trace 的 `toolCalls[].args` 是 `payload.event.args` **原样 jsonb** | 改前 `apps/server/src/queries/issues.ts:997`（`firstLine(args_raw, 160)`）；改后 `apps/server/src/queries/trace.ts:254`（`e.payload -> 'event' -> 'args'`）+ `:341-345`（`argsOf`）；用例 `apps/server/test/queries-trace.test.ts:246` 断言 `args` 含 `argv` 数组 |
| FR-6.2-c | 「返回**摘要**」 | **部分满足**：`summary` 是「有 args 就用 args，否则才退回输出首行」 | **补齐**：trace 的 `toolCalls[].outputSummary` 专取输出（最后一条 `tool.progress` 的 `partialResult.content[0].text` / `details.output`，上限 2000） | 改后 `apps/server/src/queries/trace.ts:255-259`；用例 `queries-trace.test.ts:257`（`'Tests: 12 passed'`） |
| FR-6.2-d | 「**耗时**」 | **未实现**（只有 `at` = 最早一条事件时刻） | **实现**：同一 `toolCallId` 的 `max(created_at) - min(created_at)` → `durationMs`；另给 `endedAt` | `apps/server/src/queries/trace.ts:295-298`（`min`/`max`）、`:361`（`msBetween`）；用例 `queries-trace.test.ts:261`（60_000ms）与 `:272`（20_000ms） |
| FR-6.2-e | 「**成功与否**」 | 已满足（启发式：`item.completed` 带 `error`/`isError`） | 不改映射，但在 trace 里同样钉住 | `apps/server/src/queries/trace.ts:279-287`；用例 `queries-trace.test.ts:281-284`（带 `error` → `ok:false`） |
| FR-6.2-f | 「命令类还要记录 **argv**」 | **未实现**（全仓工具链路零命中） | **实现（有条件）**：Host 把参数报成数组时取 `event.args.argv` / `event.argv` / `event.partialResult.argv`；`Bash` 报的是命令行字符串则落在 `args.command`，**不做字符串切分** | `apps/server/src/queries/trace.ts:277-281`（三个候选位置）、`:347-350`（`argvOf`，非数组 → `null`）；用例 `queries-trace.test.ts:264` 与 `:275`（没报 → `null`） |
| FR-6.2-g | 「命令类还要记录**退出码**」 | **未实现** | **实现（有条件）**：`event.exitCode` / `event.partialResult.exitCode`，只接受整数，没报就是 `null`（不拿 0 冒充） | `apps/server/src/queries/trace.ts:272-276`、`:331-339`（`exitCodeOf`）；用例 `queries-trace.test.ts:263`（`0`）与 `:274`（`null`） |
| FR-6.3-a | 「**按轮次**记录 prompt token 与 completion token」 | **部分满足**：`usage_costs` 粒度是 run（= 一次 turn），但**读侧没有按轮出口**（`/api/tasks/:id` 只有 `envelopes.usage`，实测恒 0） | **实现**：trace 的 `runs[].usage` 按 `run_id` 聚合 `usage_costs`（`inputTokens` / `outputTokens` / `costUsd` / `model`） | 写入 `apps/server/src/worker/run-store.ts:89-95`；读取 `apps/server/src/queries/trace.ts:194-206`（`USAGE_SQL`）；用例 `queries-trace.test.ts:279-302`（超时那轮也有用量） |
| FR-6.3-b | 「**折算成本**」 | 已满足（`cost/pricing.ts` 折算后落 `cost_usd`） | 不改码 | `apps/server/src/worker/run-task.ts:1614-1621` |
| FR-6.3-c | 「可汇总到 **issue**…维度」 | **未实现**（`/api/costs` 只有 repo / command / model + task 级 topN） | **实现**：`totals`（该 issue 的 runs / prompt / completion / 成本合计） | `apps/server/src/queries/trace.ts:534-545`；用例 `queries-trace.test.ts:301`（`4000/1000/0.04`） |
| FR-6.3-d | 「可汇总到**仓库、时间**维度」 | **已满足**（`/api/costs` 的 `byRepo` / `series` 按 UTC 日） | 不改码 | `apps/server/src/queries/costs.ts:132-233` |
| FR-6.4③ / NFR-6 | 「投递 → 判定 → 执行 → 写回…一次可回放」 | **拼不出**：WP1 只有「按仓库」的投递列表；执行在 `runs`/`tasks`、写回在 `actions`，入口分别是 taskId 与 issue，得跨三个接口对 id | **实现**：`GET /api/issues/{owner}/{name}/{kind}/{number}/trace` 一次给全四段 | `apps/server/src/queries/trace.ts:473-570`（入口，5 条 SQL）；路由 `apps/server/src/http/api/index.ts:303-319`；契约 `packages/contract/src/api.ts:1604-1630`；用例 `apps/server/test/queries-trace.test.ts:171-211` |
| NFR-6-①「对话」 | 三线之一 | 已满足（会话视图） | 不改码，trace 里给 `assistantText` 作补充 | `apps/server/src/queries/issues.ts:755-1041` |
| NFR-6-②「工具」 | 三线之一 | **部分满足**（无耗时 / argv / 退出码） | 见 FR-6.2 各行 | 同上 |
| NFR-6-③「用量」 | 三线之一 | **部分满足**（无 issue 维度、无按轮出口） | 见 FR-6.3 各行 | 同上 |
| **额外（本包发现）** | FR-6「失败与超时都有可查记录」 | **缺陷**：`runs.outcome` 写入侧写 `succeeded` / `cancelled`，读侧 `sqlOutcome()` 只认契约的 `success` / `interrupted` → **真实 run 的 outcome 全变 `null`**；`/api/overview` 的结果分布静默少掉成功与取消两档，任务列表 `outcome` 恒空 | **修**：两个拼写都认（`succeeded`→`success`、`cancelled`→`interrupted`），映射仍只有一处 | `apps/server/src/queries/sql.ts:277-301`；写入侧 `apps/server/src/worker/types.ts:215`；契约 `packages/contract/src/enums.ts:58-65`；用例 `apps/server/test/queries-trace.test.ts:383-403`（同时钉住 `/api/overview` 的分布与 `/api/tasks` 的 `outcome`） |

### 关于「失败与超时都有可查记录」的取值域核查（任务书第 4 条）

`runs.outcome` 的写入侧取值域（`apps/server/src/worker/types.ts:215` 的 `RUN_OUTCOMES`）：

```
['succeeded', 'failed', 'timed-out', 'cancelled', 'degenerate-output']
```

`decideOutcome()`（`apps/server/src/worker/run-task.ts:510-532`）只能产出上面 5 个值：超时 → `timed-out`、取消（`turn/interrupt`）→ `cancelled`、熔断 → `degenerate-output`、其余非成功 → `failed`。**四种终态全部覆盖，没有第 6 种**。`db/schema.ts:278` 的列注释列了 `parse-failed` / `interrupted`，但 worker 从不写它们——那是 v1 流水线时代的拼写，读侧保留兼容映射（`sql.ts:284-286`）不影响写入。

**未收尾的 run**（进程被杀、`finishedRun` 没跑）：行在 `beginRun()` 时就插入了，`outcome` / `ended_at` 为 `null`。这是「可查但结论为未知」，**不是缺失记录**——用例 `queries-trace.test.ts:200-209` 显式断言这一形态（`outcome: null` 且 `endedAt: null`），避免以后被误判成 bug。

### 关于「长期保留」的核查（任务书第 5 条）

需求侧（`docs/requirements.html:1812-1817`）：事件投递 90 天；轮次 / 用量 长期；`docs/tech-plan` §7.6 另规定 `actions` 与 `metrics_daily` **永久**保留。

- `apps/server/src/jobs/retention-cleanup.ts` 只删两张表：`run_events`（`:54-64`）与 `webhook_deliveries`（`:73-82`）。`actions` / `metrics_daily` **一行都没动**，反而有一步「永久表自证清白」（`:232-235` 读行数、`:246` 写 `skippedTables: ['metrics_daily', 'actions']`、`:250` 日志文案）。
- 另一个 `delete from` 在 `apps/server/src/jobs/metrics-rollup.ts:155-163`（`ROLLUP_PRUNE_SQL`）：它只删**本次重算的那几天里、重算后已不存在的分组**（`day = any($1)` 且 `not exists kept(...)`），是让 `metrics_daily` 与 `runs` 保持一致的 UPSERT 配套，**不是保留期清理**；`:277-279` 还显式保证「本次一个 key 都没算出来就不删」。不属于「会不会删掉永久数据」的风险。
- 结论：**已满足**，不改码。

## 三、新增 / 改动文件与理由

| 文件 | 位置 | 内容与理由 |
|---|---|---|
| `apps/server/src/queries/trace.ts`（新，520 行） | `:103` `DELIVERIES_SQL`、`:169` `RUNS_SQL`、`:194` `USAGE_SQL`、`:241` `TOOL_CALLS_SQL`、`:352` `toToolCall`、`:383` `ASSISTANT_SQL`、`:420` `ACTIONS_SQL`、`:473` `queryIssueTrace` | 只读查询（只有 `select`，`queries/` 硬约束）。5 条 SQL 分开发：基数完全不同（N / N / N / M×100 / 1），拼成一条会退化成行数相乘（同 `queries/issues.ts:752` 的取舍）。**没有 run 时不再发那 4 条空查询** |
| `apps/server/src/queries/sql.ts` | `:277-301` `sqlOutcome` | **缺陷修复**：写入侧与契约两个拼写都认。映射仍只有这一处，别的文件不许各写一份 |
| `apps/server/src/queries/types.ts` | `:20`、`:76-79` | 只追加：`IssueTraceResponse` 等 4 个类型**全部 `z.infer` 自契约**（AGENTS §8.4，不手抄 DTO） |
| `apps/server/src/queries/index.ts` | `:24-25`、`:39-42`、`:101`、`:130`、`:168-172` | 只追加：`Queries.issueTrace`（接口 + 实现 + 类型再导出）。既有成员一行未改 |
| `packages/contract/src/api.ts` | `:1472` `issueTraceToolCallSchema`、`:1508` `issueTraceActionSchema`、`:1533` `issueTraceUsageSchema`、`:1551` `issueTraceRunSchema`、`:1586` `issueTraceTotalsSchema`、`:1604` `issueTraceResponseSchema` | **只在文件末尾追加**（第 13 节）。`issueToolCallSchema`（`:908-919`）一行未动：那是会话视图的一行折叠摘要，字段意义不同，硬塞进去会让会话视图被迫返回它渲染不了的字段 |
| `packages/contract/src/schemas.ts` | `:21-26`（import）、`:85-95`（注册） | 只加不改名（AGENTS §8.1）。`IssueTraceResponse` / `IssueTraceRun` / `IssueTraceToolCall` / `IssueTraceAction` / `IssueTraceUsage` / `IssueTraceTotals` 六个组件 |
| `apps/server/src/http/api/index.ts` | `:25`（import）、`:303-319`（路由） | 只加只读端点；`preHandler: guard`（鉴权 + `no-store`）；**不依赖 `deps.repos`** |
| `apps/server/test/queries-trace.test.ts`（新，12 用例） | 全文 | 真库（`openTestDb` + advisory lock）；种子在本文件内自建（不动共享 `seedStandard`，否则影响另外 4 个文件的断言） |
| `openapi/pi-bot.openapi.json` | — | `pnpm gen:openapi` 产物：**9 paths / 76 schemas**（改前 51）。注：同一时刻别的 session 也在加组件，76 里含他们的（如 `SaveRepoModelRoleRequest`） |

三处刻意的取舍（写在代码注释里）：

1. **助手正文取事件流而不是信封**。`queries/issues.ts` 的会话视图取 `envelopes.actions[].body`——那是模型自填字段，正是 FR-6.1 来源要求禁止的东西。trace 取 `run_events`，用例 `queries-trace.test.ts:311-322` 用「信封里写另一段正文」做对照，钉住「事件流优先」。
2. **`argv` / 退出码不猜**。`Bash` 报的是 shell 命令行字符串（`args.command`），切成 argv 就是编造记录；只有 Host 明确报成数组时才给 `argv`。同理退出码只认整数，`""` → `null` 而不是 0。
3. **`args` 是原样 jsonb，不做字段白名单**。不同工具参数形状不同（`Bash`=`{command}`、`Read`=`{path}`），白名单会把新工具的参数静默丢掉。

## 四、端点签名与响应示例

```
GET /api/issues/{owner}/{name}/{kind}/{number}/trace
```

- 路径四段而不是 `:repo`（`repo` 含 `/`，`:repo` 会吞掉后面的段，同第 10/13 条路由）。
- 无查询参数：入口就是 issue 本身。`{kind}` = `issue` | `pr`。
- **不存在时不 404**：投递可能存在（被闸门拦下、没入队），那正是要查的东西。空数组表达「查到但为空」——这与 `/api/issues/:...`（会话视图，404 = 没跑过）刻意的语义差别，写在 `trace.ts:462-468`。
- 错误：路径参数非法 → 400 `bad-request`（`issueSessionParamsSchema` 校验）。

请求：

```
GET /api/issues/acme/widgets/issue/42/trace
```

响应（200，`issueTraceResponseSchema.parse()` **通过**；实际跑出来的，不是手写）：

```json
{
  "generatedAt": "2026-06-01T12:00:00.000Z",
  "issue": { "repo": "acme/widgets", "kind": "issue", "number": 42 },
  "deliveries": [
    {
      "deliveryId": "w-2", "event": "issue_comment", "action": "created",
      "repo": "acme/widgets", "receivedAt": "2026-06-01T01:05:00.000Z",
      "decision": "ignored", "decisionReason": "not-mentioned", "signatureValid": true
    },
    {
      "deliveryId": "w-1", "event": "issues", "action": "opened",
      "repo": "acme/widgets", "receivedAt": "2026-06-01T01:00:00.000Z",
      "decision": "triggered", "decisionReason": "enabled", "signatureValid": true
    }
  ],
  "runs": [
    {
      "runId": "r-1", "taskId": "t-1", "attempt": 1, "command": "/review-pr",
      "sessionId": "s-1", "turnId": "u-1",
      "startedAt": "2026-06-01T01:00:10.000Z", "endedAt": "2026-06-01T01:09:00.000Z",
      "durationMs": 530000, "outcome": "success", "failureClass": null,
      "usage": { "model": "anthropic/claude-x", "inputTokens": 1000, "outputTokens": 500, "costUsd": 0.05 },
      "assistantText": "结论：容器只读挂载导致的。",
      "toolCalls": [
        {
          "toolCallId": "call_bash", "name": "Bash",
          "args": { "argv": ["npm", "test"], "command": "npm test" },
          "outputSummary": "Tests: 12 passed",
          "startedAt": "2026-06-01T01:01:00.000Z", "endedAt": "2026-06-01T01:02:00.000Z",
          "durationMs": 60000, "ok": true, "exitCode": 0, "argv": ["npm", "test"]
        }
      ],
      "toolCallsTruncated": false,
      "actions": [
        {
          "actionId": "1", "intent": "comment", "status": "applied",
          "target": { "kind": "comment", "number": 42, "ref": null,
                      "url": "https://github.com/acme/widgets/issues/42#issuecomment-9001" },
          "externalRef": "9001", "appliedAt": "2026-06-01T01:09:00.000Z",
          "revertedAt": null, "revertKind": null
        }
      ]
    }
  ],
  "totals": { "runs": 1, "inputTokens": 1000, "outputTokens": 500, "costUsd": 0.05 }
}
```

四段与需求一一对应：`deliveries` = 投递 + 判定（含 `ignored` 的 `decisionReason`）→ `runs` = 执行（结局 / 耗时 / 三线）→ `runs[].toolCalls` = 工具 → `runs[].actions` = 写回；`totals` = issue 维度用量。

## 五、测试（断言的是具体值，不是「不抛异常」）

`apps/server/test/queries-trace.test.ts` —— 12 个用例，真 PostgreSQL（`openTestDb` + advisory lock），种子自建：

1. ★ 投递 → 判定 → 执行 → 写回一次拿全：`deliveries` 顺序 `['w-3','w-2','w-1']`、三条判定原因逐个断言、别的 issue / 别的仓库的投递**不串台**、`runs` 顺序与 `attempt` 为 `[1,2]`、写回挂在 `runs[1].actions`（契约外 `open_pr` 被挡住，否则整页 parse 失败）。
2. ★ 失败/超时/取消都可查：`timed-out` + `failureClass='timeout'` + `durationMs=300000`；库里写 `succeeded` → 返回 `success`；`cancelled` → `interrupted`；未收尾 run → `outcome/endedAt/durationMs` 全 `null`。
3. ★ FR-6.2 七项：`args` 原样、`outputSummary` 取输出、`durationMs` 60s/20s、`exitCode` 0 与 `null`、`argv` 数组与 `null`、带 `error` → `ok:false`。
4. ★ FR-6.3：两次 run 的用量逐个断言、`totals` 合计 `4000/1000/0.04`、删掉记账行后该轮 `usage` 是 `null`（≠ 0）。
5. ★ FR-6.1：`assistantText` 来自事件流；**信封写了别的正文也以事件流为准**。
6. 从没被处理过的 issue：空数组 + `totals` 全 0（不 `null`、不 404）。
7. 只有投递没入队：投递查得到、`runs` 为空。
8. 端点：200 + 契约 parse + `no-store` + 具体值。
9. 未知 issue：200 空链。
10. 路径参数非法（`kind=bogus`、`number=0`）→ 400 `bad-request`。
11. ★ `/api/overview`：库里 `succeeded` / `cancelled` 分别计入 `success` / `interrupted` 两档（钉住共享映射）。
12. ★ `/api/tasks` 与 `/api/tasks/:id`：`outcome` 映射到契约取值而不是 `null`。

实际执行（PowerShell，仓库根 / `apps/server`）：

```
cd packages\contract; npx tsc -p tsconfig.json --noEmit
  → EXIT=0

cd apps\server; npx tsc --noEmit
  → 只剩别人的报错（见 §6-1），我改动的文件 0 error

cd apps\server; npx vitest run test/queries-trace.test.ts
  → 1 passed (12 tests)  ✓ 12 passed

cd apps\server; npx vitest run test/queries-overview.test.ts test/queries-tasks.test.ts \
    test/queries-deliveries.test.ts test/queries-issues.test.ts \
    test/queries-costs-audit.test.ts test/queries-trace.test.ts
  → 6 files / 65 tests passed（回归：既有读接口未受 outcome 映射修复影响）

cd apps\server; npx vitest run test/http-server.test.ts
  → 24 passed

cd apps\server; npx vitest run test/e2e-dry-run.test.ts test/e2e-idempotent.test.ts
  → 3 files / 28 tests passed（含这批：http-server + 两个 e2e）

pnpm gen:openapi
  → openapi: 9 paths / 76 schemas -> openapi\pi-bot.openapi.json

npx eslint <本次改动的 7 个文件>
  → 0 problem（trace.ts 的重复 import 已修；http/api/index.ts 的重复 import 来自别人的
    createApiGuards 改动，见 §6-2，不在我可写面）
```

## 六、跳过项与残余风险（不谎报）

1. **`apps/server` 全量 `tsc --noEmit` 不是 0 error**，报错全部落在**别人正在写、尚未进 git 的新文件**上：
   - `src/app/config.ts(463)`、`src/config/model-settings.ts`、`src/app/model-role-resolver.ts`（`??` 未跟踪，WP9）；
   - `packages/envelope/src/v21.ts` 的 `Duplicate identifier 'OutputActionType'`（同一时刻别的 session 在改）。
   `apps/server/src/queries/**`、`src/http/api/index.ts`、`packages/contract/src/api.ts`、`schemas.ts` 与我的新测试文件**在这个报错列表里一个都没有**。我动手期间实测过对方文件处于「写到一半」状态（`../../../packages/contract/...` 路径写错、`vitest` 整份解析失败，几分钟后他们自己修好），见 §一 的并发说明。**合并前必须由编排侧以「无他人未完成改动」的工作区重跑一次。**

2. **`apps/server/src/http/api/index.ts` 的 lint 有 2 个 error，不是我引入的**：`skills.ts` 被 import 两次（`:54`、`:55`），来自别的 session 新加的 `import { createApiGuards } from './skills.ts'` 与既有的 `import type { SkillWriteMode } from './skills.ts'`。我只在该文件末尾加了第 14 条路由。**没有替他们改**（不属于本包，且同一文件正在被并发编辑）。

3. **FR-6.1 的两个子项受上游事件形状限制，没有强行补**：
   - **逐 token 的流式正文不落库**：`worker/run-task.ts:987-992` 有意过滤 `item.delta`（一次 turn 上百条，会把详情页 500 条上限挤爆）。所以「完整对话记录」的粒度是 `item.completed` 的整段终态文本，**不是逐字回放**。改这一点属 `worker/`，不在本包可写面。
   - **工具循环第 2..N 轮重新拼的 `turn/start` 文本不落任何表**（`run-task.ts:1091`）。同一原因。
   两条都不影响「三线齐全」，但会让人误以为能「逐字」回放——已在 `trace.ts:1-30` 的文件头写明。

4. **`argv` / 退出码的覆盖率取决于 Host 是否上报**。`Bash` 在真 pi-host 上报的是 `args.command`（shell 命令行字符串），所以 `argv` 大概率恒为 `null`，实际可回放的完整命令落在 `args.command` 里。我没有做字符串切分：切出来的 argv 是猜的，而 FR-6.2 要的是「记录」。**这是有意的降级，不是遗漏**——`docs/audit/v2/U06/A.md:68` 与 `U06/B.md:73` 都把这个缺口记在案。

5. **`runs.outcome` 的映射修复会改变既有接口的**输出**（不是错误）**：真实库里的 `succeeded` / `cancelled` 以前被读成 `null`，现在读成 `success` / `interrupted`。`/api/overview` 的 `outcomeDistribution` 会**多出** `success` 与 `interrupted` 两档计数，`/api/tasks` 的 `outcome` 从空变成有值。面板若曾针对「永远为空」写过兜底文案，行为会变（更好的方向）。既有测试断言的是种子数据（库里写 `success`），所以全绿；新增的第 11/12 个用例把**写入侧拼写**也钉住了，防止回归。

6. **`deliveries` 的双路取数有上限 200 且不分页**：按 `tasks.delivery_id` 锚定 ∪ payload 指向该 issue。单个 issue 的投递量远小于 200；但这意味着**这是一个「一次查全」的接口，不是列表接口**，将来投递量异常增长需要加分页（已在 `trace.ts:70-76` 注明）。

7. **`metrics_daily` 的 `ROLLUP_PRUNE_SQL` 会删行**，但它不是保留期清理（见 §二末）。若将来有人把它当清理作业改造，必须重新过一遍「`actions` / `metrics_daily` 永久保留」这条不变式。

8. **OpenAPI 仍没有 `/api/issues/{owner}/{name}/{kind}/{number}/trace` 这条 path**：`gen-openapi.ts:34` 的 `Endpoint.pathParam` 只支持**单个**路径参数（WP1 报告已记为基础设施缺口）。本次只产出契约组件（`IssueTraceResponse` 等 6 个），不越界改生成器。
