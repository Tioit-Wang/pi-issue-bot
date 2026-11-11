# Issue Agent 实施记录 · S1（agent 运行时）

> 片：`docs/dev-plan-issue-agent.md` 的 **S1 消息模型**（含 §2.3 事件、§2.7 硬规则 1–3、§2.1 串行）。
> 前置：S0（流水线退役 + `agent_sessions`/`agent_messages`/`agent_denials` + `migrations/0006_agent.sql`）。
> 本篇只记「实际怎么落的 + 与计划的偏离 + 没做完的」，需求/测试编号沿用 `docs/req-issue-agent.md` 与
> `docs/test-plan-issue-agent.md`。

## 1. 新增文件

| 文件 | 关键导出 |
|---|---|
| `packages/contract/src/skill-mentions.ts` | `findSkillMentions(text, ids) → {skillIds, text, hits}`（正则 `/(^|\s)\/([^\s]+)/g`，先过 `maskCodeRegions`；命中删 token，未命中逐字返回） |
| `apps/server/src/agent/constants.ts` | `AGENT_DISPATCH_INTERVAL_MS=10_000`、`AGENT_DISPATCH_MAX_ISSUES`、`AGENT_MAX_BODY_CHARS=4_000`、`AGENT_FINGERPRINT_LENGTH=16`、`AGENT_MESSAGE_KINDS/STATUSES`、`AGENT_TEMPLATE_IDS`、`AGENT_DENIAL_REPLY`、`AGENT_TASK_ACTOR` |
| `agent/canonical-text.ts` | `normalizeForIdempotency(text)`、`stripAliases(text, aliases)` |
| `agent/fingerprint.ts` | `mentionFingerprint({repo, issueNumber, text})`、`eventFingerprint({repo, issueNumber, templateId, issueUpdatedAt})`（`sha256(...)` 前 16 位） |
| `agent/permission.ts` | `isManager(settings, login)`、`recordDenial(db, key, actor) → {alreadyReplied}`、`AGENT_DENIAL_SQL` |
| `agent/message.ts` | `composeAgentMessage({kind, templateId?, rawText, aliases, catalog, issue, settings}) → {kind, templateId, text, skillIds, fingerprint}`、`AGENT_MESSAGE_TEMPLATES`（opened/edited/mention）、`eventTemplateSkillOf`、`renderCatalog` |
| `agent/ack.ts` | `ackReceived(deps, target)` / `ackDone(deps, target)`（走 `feedback/` 的 `GithubReactionApi` + `removeOwnReaction`；无写面时 `{applied:false}` 静默） |
| `agent/store.ts` | `insertMessage`、`readMessage`、`listQueuedIssueKeys`、`claimNextForIssue`、`markMessage`、`countPending`、`insertAgentTask`、`findTaskIdByKey`、`loadSession`/`saveSession`、`agentTaskIdempotencyKey`/`parseAgentTaskIdempotencyKey` |
| `agent/dispatcher.ts` | `dispatchNextForIssue`、`dispatchAgentMessages`、`finishMessageAndContinue` |
| `agent/index.ts` | barrel |
| `apps/server/src/jobs/agent-dispatch.ts` | `agentDispatchJob`（定时作业外壳，`(deps, options?) => JobResult`） |

## 2. 改造

| 文件 | 改动 |
|---|---|
| `http/webhook.ts` | `issues.opened/edited`（仅 title/body 变更）→ `event` 消息；`issue_comment.created` @ 别名 → 权限 → `mention` 消息；`/review-pr` 仍走命令通道；`labeled/assigned/closed/reopened/bot/renovate/dependabot` 一律忽略；新增 `WebhookDeps.replyDenied / dispatchAgent / reactions / appSlug`；`submitAgentMessage()` 是 agent 消息唯一入口 |
| `queue/definitions.ts` | `QUEUE.agentDispatch='agent-dispatch'`（concurrency 1、expire 120s、retry 1）+ `SCHEDULES` 每分钟兜底 |
| `jobs/index.ts` / `jobs/types.ts` | `JobName='agent-dispatch'`、`JobDeps.agentEnqueue/agentMaxIssues`、`JOB_SCHEDULES` 追加、`pickAgentDispatchDeps` |
| `app/compose.ts` | `agentDispatch` 依赖（`singletonKey = agent:<repo>#<n>:<fingerprint>`）；webhook 侧接 `reactions/replyDenied/dispatchAgent`；agent 任务用 `agent_sessions`（persistent）+ `buildTaskPrompt` 系统段 + `## 这一条消息`；任务结束写 `agent_messages` 终态并**立刻**取下一条；`REQUIRED_TABLES` 加三张 agent 表；会话读写改走 `agent/store` |
| `worker/run-task.ts` | **修既有 bug**：`recordingOps` 把 `sessionAttach` 摘成裸函数调用，`this` 丢失 → `session/attach` 永远失败、会话复用静默退化成每轮新建（详见 §5） |

## 3. 三条链路怎么落地

### 3.1 幂等

- 人消息（`kind='mention'`）：`fingerprint = sha256(repo, issue, normalizeForIdempotency(摘别名后的原话))` 前 16 位。
  归一化 = 去 `@handle` + 压空白 + 去标点/符号，**不转小写**；代码区先蒙版（不参与归一化）。
- 事件消息（`kind='event'`）：`fingerprint = sha256(repo, issue, templateId, issue.updated_at)`。
  同一 `updated_at` 的重复投递仍命中同一行（幂等单位 = 一次内容变更），但**两次编辑一定是两条消息**（L-07）。
- 落库：`INSERT ... ON CONFLICT DO NOTHING RETURNING` → 0 行即 `duplicate`：不建任务、不调模型、不重复打 reaction。
- 拒绝**不**写 `agent_messages`：只写 `agent_denials`，所以同一个人升成管理员后同一句话能执行（L-08）。

### 3.2 权限

- 名单只有 `settings.agent.managers`（大小写不敏感，OQ-9）。
- 命中非管理员 → `recordDenial`（PK `repo+issue+actor`）：第一次插入成功才回一句「无权限」，之后静默；
  「只回一次」按 **issue** 维度（X-09）。回话走 `WebhookDeps.replyDenied`（装配层接 `ports.github.createIssueComment`），
  dry-run 时不调用。

### 3.3 串行

- `agent_messages` 就是队列（`queued|running|done|failed`），**不用** pg-boss `singletonKey` 排队
  （同 key 已在队列会被丢弃 → 第二条消息会消失，X-14）。
- 取件：`UPDATE ... WHERE (repo,issue,fingerprint) IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) AND NOT EXISTS(running)`
  ——「选中 + 置 running」在**一条语句**里；同一 issue 已有 `running` 时直接不领。
- 投递：`tasks`（`source='agent'`、`command=agent:event|agent:mention`、`idempotency_key=agent:message:<repo>#<n>:<fp>`、
  `prompt_text`=组装后的消息）+ `queue.send(run-task, {singletonKey: agent:<repo>#<n>:<fp>})`。
- 三个触发点：webhook 落库后**立刻**领一条（`deps.dispatchAgent`）、任务结束**立刻**取下一条
  （`finishMessageAndContinue`）、`agent-dispatch` cron 每分钟兜底。
- 任务与消息的连接键是 `tasks.idempotency_key`（`tasks` 没有指向 `agent_messages` 的外键，0000 表结构已冻结）。

### 3.4 会话

- 一个 issue 一行 `agent_sessions`；`planAgentSession`（S0 落地）决定 attach / 新建 / 轮换（30 轮 / 7 天）。
- agent 任务的提示词 = `buildTaskPrompt`（系统段不变，需求 §1.5）+ `## 这一条消息` + 消息正文。

## 4. 测试

新增（server）：`agent-message.test.ts`(23)、`agent-events.test.ts`(16)、`agent-permission.test.ts`(7)、
`agent-serial-queue.test.ts`(7)；夹具 `test/helpers/agent-harness.ts`。新增（contract）：`skill-mentions.test.ts`(13)。

覆盖：L-01 / L-02 / L-04（组装侧）/ L-07 / L-08 / R-01..R-03 / E-01..E-04 / E-08 / E-09 / E-10 / X-03 / X-09 / X-10 / X-11 / X-14
+ 会话复用（两次 @ 同一个 `session_id`、`turns` 递增、`session/attach` 被调用）。

改动既有测试（都因语义变化，非为变绿而改断言）：
`http-webhook.test.ts`（夹具注入真 dispatcher；`resetTables` 加三张 agent 表；「issue 被编辑」改为「产生第二条消息 + 串行排队」）、
`http-webhook-free-mention.test.ts`（`@answer` 决策块 → agent mention 计划）、
`queue-definitions.test.ts`（6→7 队列、5→6 定时）、`jobs-index.test.ts`（6→7 作业）、
`app-lifecycle.test.ts`（假池补三张表）、`e2e-dry-run.test.ts`（`agent:event` / `actor_login=agent`）、
`helpers/e2e-harness.ts`（补 `session/attach` 快照，否则会话复用测不出来）。

验收输出（本片跑过）：

```
pnpm -r typecheck            → 全部 Done
pnpm lint                    → 0 errors / 6 warnings（scripts/spike 既有）
pnpm --filter @pi-issue-bot/server test → 88 files / 1025 passed / 2 skipped
pnpm --filter @pi-issue-bot/panel test  → 18 files / 168 passed
packages: contract 96 / envelope 33 / shared 30 / racp-client 87
```

## 5. 顺手修掉的既有 bug（重要）

`worker/run-task.ts::recordingOps` 里把 `ops.sessionAttach` **摘下来存成局部变量再调用**：

```ts
const attach = ops.sessionAttach;
... { sessionAttach: (params, options) => attach(params, options) }
```

`RacpOps` 的方法在原型上，摘下来调用时 `this` 是 `undefined`，于是 `session/attach` 每次都抛
`Cannot read properties of undefined (reading 'RacpOps')` → `turn-driver` 按「attach 失败」处理 →
**每轮都新建会话**。v0.3 之前没有用例真正走到 attach（阶段 2 也是新建），所以一直没暴露。
本片改成 `ops.sessionAttach !== undefined` 判存在、调用时从 `ops` 上取。

## 6. 与计划的偏离（已接受）

1. **`tasks.command` 区分不到模板**：`agent_messages` 没有 `templateId` 列（0006 已冻结），dispatcher 只能写
   `agent:event` / `agent:mention`。是 opened 还是 edited 看 `agent_messages.comment_body`（模板首句不同）。
   要恢复 `agent:opened` 需要给 `agent_messages` 加列（0007）。
2. **`tasks.actor_login` 恒为 `agent`**：同样因为没有 actor 列；面板要显示「谁 @ 的」只能回查
   `agent_messages.comment_id` → GitHub 评论。
3. **`agent-dispatch` 的 cron 是每分钟**（pg-boss cron 最小 1 分钟），不是 10 秒。
   「10 秒」由「webhook 落库后立刻投递」+「任务结束立刻取下一条」兑现，cron 只是兜底；
   `AGENT_DISPATCH_INTERVAL_MS` 保留为口径常量。
4. **`duplicate` 响应体带不回上次的 `comment_id`**：`webhookAcceptedResponseSchema` 是 `.strict()` 且没有该字段
   （契约变更 + openapi 重生成不在本片）。命中时返回 `duplicate:true` + 已有 `taskId`（若有）。
5. **`@answer` 自由问答通道被 agent mention 取代**（`extractFreeQuestion` / `decodeFreeQuestion` 仍导出，
   只为兼容历史任务行与既有单测）。
6. **`/review-pr` 仍走命令通道**（PR 审查不在 v0.3 的 agent 范围，OQ-3 未定）。
7. **`rawText` 里没有 @ 别名的评论直接忽略**：v0.3 没有「补充评论」隐式通道，这是有意的行为变化。

## 7. 没做完 / 留给后续片

1. **`agent_sessions` 的 actor / template 元数据**：见 §6 第 1–2 条，需要 0007 加列才能让面板/审计看到
   「哪条任务处理的是 opened 还是 edited、谁 @ 的」。
2. **`claimOldest` 的并发窗口**：两个 dispatcher 真同时进这条语句时，`NOT EXISTS (running)` 是快照判定，
   仍可能各领到同一 issue 的不同消息（各跑一条）。cron `concurrency=1` 把它压到一次语句的时间；
   彻底消灭需要一条部分唯一索引 `(repo, issue_number) WHERE status='running'`（未加，属 schema 变更）。
3. **`running` 行的超时回收**：任务进程被杀（SIGKILL）时消息会停在 `running`，该 issue 永久卡住。
   `queue-gate` 的语义（排队超时取消）现在只覆盖 `tasks`，没覆盖 `agent_messages`；需要一轮
   「`running` 超过 N 分钟的置 `failed`」的清扫（本片未做）。
4. **技能目录只到 id**：`listSkills` 只给名字，`renderCatalog` 的 name/description 目前恒空（S2 的
   `skills/catalog.ts` 接上后才有）。
5. **`auto_label_after_format_pass`（A-08 / CF-04）未接线**：属于 S4。
6. **`agent/ack.ts` 的 `ackDone` 还没人在任务结束调用**：终态 `-eyes` 现在由 `feedback/` 的
   `applyFeedback` 做（同一写面），`ackDone` 只有单测/将来复用；若 S4 要「处理完移除 reaction」的独立
   语义，需要在 `compose.executeTask` 的 finally 里补一次调用。
7. **面板**：`agent_messages` / `agent_sessions` 的可视化按计划属 S5，本片没有动 `apps/panel/**`。
8. **openapi 未重生成**（`findSkillMentions` 是纯函数，不进 schema，但 `CONTRACT_VERSION` 未升）。
