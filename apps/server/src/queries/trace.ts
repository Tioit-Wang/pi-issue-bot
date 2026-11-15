/**
 * `GET /api/issues/{owner}/{name}/{kind}/{number}/trace` —— 一个 issue 的**完整链路**。
 *
 * 需求原文：
 *  - `docs/requirements.html:1216` FR-6.4③ 事件时间线「投递 → 判定 → 执行 → 写回」
 *  - `:1193` FR-6.1「会话内每一轮的用户输入、助手输出、工具调用与结果，全部按顺序落库」
 *    + 「必须由执行侧生成，不能依赖 agent 在回答里自述」
 *  - `:1199` FR-6.2「工具名、入参、返回摘要、耗时、成功与否；命令类还要记录 argv、退出码」
 *  - `:1204` FR-6.3「按轮次记录 prompt token 与 completion token，并折算成本。可汇总到
 *    issue、仓库、时间维度」
 *  - `:1837` NFR-6「任一 issue 的处理过程可回放；对话 + 工具 + 用量三线齐全」
 *
 * 为什么要一个**新端点**而不是复用现成的四个：
 *  现成的 `/api/repos/:owner/:name/deliveries`（投递+判定，WP1）、`/api/tasks/:id`
 *  （执行+写回，但按 taskId）、`/api/issues/:...`（会话，但工具调用只有一行摘要）
 *  三者都只覆盖链的一段，而且入口参数不同（仓库 / taskId / issue）。要回放一个 issue，
 *  运维得先查列表拿 taskId 再挨个查详情，链路一长就断。这里按 issue 一次给全：
 *  `deliveries`（投递+判定）→ `runs`（执行）→ `runs[].actions`（写回），
 *  并在 `runs[]` 上挂 FR-6.2 的工具明细与 FR-6.3 的按轮次用量。
 *
 * 四条实现口径：
 *  1. **只读**：本文件只有 `select`（`queries/` 的硬约束）。
 *  2. **助手正文取自事件流**（`run_events` 的 `item.completed.payload.event.message.content`），
 *     不取 `envelopes.actions[].body`：后者是模型自述，FR-6.1 的来源要求明文禁止
 *     「依赖 agent 在回答里自述」。两条都查得到时以事件流为准。
 *  3. **工具调用的耗时靠同一 `toolCallId` 的 `min/max(created_at)` 配对**，
 *     `argv` / `exitCode` 只认 Host 真的报上来的字段（没报就是 `null`，不猜）。
 *  4. **`runs.outcome` 用 `sqlOutcome()` 映射**（唯一一处映射，同时认写入侧
 *     `succeeded`/`cancelled` 与契约 `success`/`interrupted`）；映射不到为 `null`。
 */
import {
  ACTION_INTENTS_SQL,
  arrayOf,
  intOf,
  isoOf,
  isoOrNull,
  msBetween,
  recordOf,
  sqlActionStatus,
  sqlFailureClass,
  sqlOutcome,
  sqlRevertKind,
  stringOrNull,
  type SqlRunner,
} from './sql.ts';
import { targetOfAction } from './tasks.ts';
import type {
  DeliveryRow,
  IssueTraceAction,
  IssueTraceResponse,
  IssueTraceRun,
  IssueTraceToolCall,
} from './types.ts';

/** 路径参数（与 `issueSessionParamsSchema` 同形，路由侧已校验）。 */
export type IssueTraceParams = {
  readonly owner: string;
  readonly name: string;
  readonly kind: string;
  readonly number: number;
};

/* ── 契约上限（超出截断而不是让整页失败，见各 `*Row` 的注释） ───────────────── */

/** 投递最多回 200 条（契约 `issueTraceResponseSchema.deliveries`）。 */
const MAX_DELIVERIES = 200;
/** 执行最多回 200 次（契约 `runs`）。一次 issue 的 retry 次数远小于它。 */
const MAX_RUNS = 200;
/** 单次 run 的工具调用上限（契约 `toolCalls`）。超出置 `toolCallsTruncated`。 */
const MAX_TOOL_CALLS = 100;
/** 单次 run 的写回上限（契约 `actions`）。 */
const MAX_ACTIONS = 100;
/** 助手正文上限（契约 `assistantText.max(40_000)`）。 */
const MAX_ASSISTANT_CHARS = 40_000;
/** 工具返回摘要上限（契约 `outputSummary.max(2_000)`）。 */
const MAX_OUTPUT_CHARS = 2_000;
/** `payload` 里目标对象的键：PR 是 `pull_request`，其余是 `issue`。 */
function payloadKeyOf(kind: string): string {
  return kind === 'pr' ? 'pull_request' : 'issue';
}

/* ── 1. 投递（含判定） ─────────────────────────────────────────────────────── */

type DeliveryRaw = {
  delivery_id: string;
  event: string;
  action: string | null;
  repo: string | null;
  received_at: Date;
  decision: 'triggered' | 'ignored' | null;
  decision_reason: string | null;
  signature_valid: boolean | null;
};

/**
 * 该 issue 的投递：`delivery_id` 由 `tasks.delivery_id` 锚定（**已经处理过的那批**），
 * 再加上 payload 里就指这条 issue 的投递（**还没被判定成任务的那批**，例如被闸门拦下的）。
 *
 * 为什么要两路：只按 `tasks.delivery_id` 会漏掉「投递进来了但没入队」的事件——而那正是
 * FR-6.4③「被忽略的事件也能看到原因」要展示的东西；只按 payload 又会把同一 issue 上
 * 其它事件类型的投递混进来却看不到它与哪次执行相关。
 */
const DELIVERIES_SQL = `
select
  w.delivery_id,
  w.event,
  w.action,
  w.repo,
  w.received_at,
  case when w.decision in ('triggered', 'ignored') then w.decision end as decision,
  w.decision_reason,
  w.signature_valid
from webhook_deliveries w
where w.delivery_id in (
        select t.delivery_id from tasks t
         where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
           and t.delivery_id is not null
      )
   or (
        w.payload -> 'repository' ->> 'full_name' = $1
        and w.payload -> $4 ->> 'number' = $5
      )
order by w.received_at desc, w.delivery_id desc
limit ${MAX_DELIVERIES}
`;

function toDeliveryRow(raw: DeliveryRaw): DeliveryRow {
  return {
    deliveryId: raw.delivery_id.slice(0, 128),
    event: raw.event.slice(0, 64),
    action: stringOrNull(raw.action, 64),
    repo: stringOrNull(raw.repo, 200),
    receivedAt: isoOf(raw.received_at, new Date(0).toISOString()),
    decision: raw.decision,
    decisionReason: stringOrNull(raw.decision_reason, 64),
    signatureValid: raw.signature_valid ?? true,
  };
}

/* ── 2. 执行（runs）+ 用量（usage_costs） ──────────────────────────────────── */

type RunRaw = {
  run_id: string;
  task_id: string;
  attempt: number;
  command: string;
  session_id: string | null;
  turn_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  outcome: string | null;
  failure_class: string | null;
};

type UsageRaw = {
  run_id: string;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cost_usd: string | number | null;
};

/**
 * 该 issue 的全部 run（按 `(task, attempt)` 升序 = 时间正序）。
 *
 * 骨架是 `runs` 而不是 `actions`：dry-run 仓库不写 `actions`，但 run 一定有；
 * 反过来只看 `actions` 会把「跑了但什么都没写回」的那几轮整段丢掉。
 */
const RUNS_SQL = `
select
  r.id as run_id,
  r.task_id,
  r.attempt,
  t.command,
  r.session_id,
  r.turn_id,
  r.started_at,
  r.ended_at,
  ${sqlOutcome('r.outcome')} as outcome,
  ${sqlFailureClass('r.failure_class')} as failure_class
from runs r
join tasks t on t.id = r.task_id
where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
order by r.started_at asc nulls last, r.task_id, r.attempt, r.id
limit ${MAX_RUNS}
`;

/**
 * 用量：一次 run 一行（`usage_costs` 的主键语义是「跑完写一次」）。
 *
 * FR-6.3 要「按轮次」：一个 run 就是一次 turn，所以这里按 `run_id` 聚合即可；
 * 同一 run 将来若写入多行（多模型拆分），`sum` 仍然给出该轮的真实合计。
 */
const USAGE_SQL = `
select
  uc.run_id,
  min(uc.model) as model,
  coalesce(sum(uc.input_tokens), 0) as input_tokens,
  coalesce(sum(uc.output_tokens), 0) as output_tokens,
  coalesce(sum(uc.cost_usd), 0) as cost_usd
from usage_costs uc
where uc.run_id = any($1::text[])
group by uc.run_id
`;

/* ── 3. 工具调用（FR-6.2） ────────────────────────────────────────────────── */

type ToolCallRaw = {
  run_id: string;
  call_id: string;
  started_at: Date;
  ended_at: Date | null;
  name: string | null;
  args: unknown;
  output_raw: string | null;
  failed: boolean | null;
  exit_code: number | string | null;
  argv: string[] | null;
  total: number | string;
};

/** 工具名取不到时的占位（契约 `name` 非空，面板不用判空）。 */
const UNKNOWN_TOOL = 'unknown';

/**
 * 按 `toolCallId` 把 `item.started` / `tool.progress` / `item.completed` 合并成一次调用。
 *
 * 四个字段的来源逐条对齐 FR-6.2：
 *  - **工具名**：`item.started` 的 `payload.event.toolName`（真库里只有这一处有名字，
 *    `tool.progress` 只有输出——见 `docs/audit/v2/U06/A.md` 的实测记录）；
 *  - **入参**：`item.started` 的 `payload.event.args`（整块 jsonb 原样返回）；
 *  - **返回摘要**：`tool.progress` 的 `partialResult.content[0].text` 或 `details.output`；
 *  - **耗时**：同一 `call_id` 的 `min(created_at)` / `max(created_at)` 之差；
 *  - **成功与否**：`item.completed` 带 `error` / `isError`；
 *  - **argv / 退出码**（命令类）：只认 Host 报上来的
 *    （`event.args.argv` / `event.argv`、`event.exitCode` / `partialResult.exitCode`）。
 *
 * 只认 `itemType='tool'`：`item.started` 同时用于消息条目（`itemType='message'`，
 * `itemId` 是消息 uuid，没有 `toolCallId`），不筛会把每条消息都算成一次工具调用。
 */
const TOOL_CALLS_SQL = `
with raw as (
  select
    e.run_id,
    coalesce(
      nullif(e.payload #>> '{event,toolCallId}', ''),
      nullif(e.payload ->> 'itemId', '')
    ) as call_id,
    e.created_at,
    case
      when e.kind = 'item.started' then nullif(e.payload #>> '{event,toolName}', '')
    end as tool_name,
    case when e.kind = 'item.started' then e.payload -> 'event' -> 'args' end as tool_args,
    case
      when e.kind = 'tool.progress' then coalesce(
        nullif(e.payload #>> '{event,partialResult,content,0,text}', ''),
        nullif(e.payload #>> '{event,partialResult,details,output}', '')
      )
      when e.kind = 'item.completed' then coalesce(
        nullif(e.payload #>> '{event,partialResult,content,0,text}', ''),
        nullif(e.payload #>> '{event,partialResult,details,output}', '')
      )
    end as output_raw,
    (
      e.kind = 'item.completed'
      and (
        jsonb_exists(e.payload -> 'event', 'error')
        or jsonb_exists(e.payload, 'error')
        or e.payload #>> '{event,isError}' = 'true'
      )
    ) as failed,
    -- 退出码 / argv 只从事件里取；两个嵌套位置都试一遍（Host 版本不同）
    coalesce(
      nullif(e.payload #>> '{event,exitCode}', ''),
      nullif(e.payload #>> '{event,partialResult,exitCode}', '')
    ) as exit_code_raw,
    coalesce(
      e.payload #> '{event,args,argv}',
      e.payload #> '{event,argv}',
      e.payload #> '{event,partialResult,argv}'
    ) as argv_raw
  from run_events e
  where e.run_id = any($1::text[])
    and e.kind in ('item.started', 'tool.progress', 'item.completed')
    and e.payload ->> 'itemType' = 'tool'
),
merged as (
  select
    run_id,
    call_id,
    min(created_at) as started_at,
    max(created_at) as ended_at,
    (array_agg(tool_name order by created_at) filter (where tool_name is not null))[1] as name,
    (array_agg(tool_args order by created_at) filter (where tool_args is not null))[1] as args,
    -- 返回摘要取**最后**一条有输出的进度：那是最接近终态的文本
    (array_agg(output_raw order by created_at desc) filter (where output_raw is not null))[1] as output_raw,
    coalesce(bool_or(failed), false) as failed,
    (array_agg(exit_code_raw order by created_at desc) filter (where exit_code_raw is not null))[1] as exit_code_raw,
    (array_agg(argv_raw order by created_at) filter (where argv_raw is not null))[1] as argv_raw
  from raw
  where call_id is not null
  group by run_id, call_id
),
ranked as (
  select
    merged.*,
    count(*) over (partition by run_id) as total,
    row_number() over (partition by run_id order by started_at, call_id) as rn
  from merged
)
select
  run_id,
  call_id,
  started_at,
  ended_at,
  name,
  args,
  output_raw,
  failed,
  exit_code_raw as exit_code,
  total,
  case
    when jsonb_typeof(argv_raw) = 'array' then array(select jsonb_array_elements_text(argv_raw))
  end as argv
from ranked
where rn <= ${MAX_TOOL_CALLS}
order by run_id, started_at, call_id
`;

/** 退出码：只接受整数（`""` / 非数字一律 `null`，不拿 0 冒充）。 */
function exitCodeOf(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

/** 入参：jsonb 原样返回，非对象（数组 / 标量 / NULL）一律 `null`。 */
function argsOf(raw: unknown): Record<string, unknown> | null {
  const record = recordOf(raw);
  return Object.keys(record).length === 0 ? null : record;
}

/** argv：只接受字符串数组；`[]` 当「没报」处理（空 argv 不是可回放的命令）。 */
function argvOf(raw: unknown): string[] | null {
  const list = arrayOf(raw).filter((item): item is string => typeof item === 'string' && item !== '');
  return list.length === 0 ? null : list.slice(0, 64).map((item) => item.slice(0, 500));
}

function toToolCall(row: ToolCallRaw): IssueTraceToolCall {
  const startedAt = isoOf(row.started_at, new Date(0).toISOString());
  const endedAt = isoOrNull(row.ended_at);
  return {
    toolCallId: row.call_id.slice(0, 128),
    name: stringOrNull(row.name, 200) ?? UNKNOWN_TOOL,
    args: argsOf(row.args),
    outputSummary: stringOrNull(row.output_raw, MAX_OUTPUT_CHARS),
    startedAt,
    endedAt,
    durationMs: msBetween(row.started_at, row.ended_at),
    ok: row.failed !== true,
    exitCode: exitCodeOf(row.exit_code),
    argv: argvOf(row.argv),
  };
}

/* ── 4. 助手正文（FR-6.1 的来源要求） ─────────────────────────────────────── */

type AssistantRaw = { run_id: string; text: string };

/**
 * 助手这轮的输出原文，**取自执行侧事件流**。
 *
 * 载体与 `worker/envelope.ts:36-47` 同源（对着真 pi-host v0.22.0 的 `run_events` 核过）：
 * `item.completed` 的 `payload.event.message.content`。另两条是简化形状（假 host / 单测）。
 *
 * 为什么同一条 run 可能有多行：一轮对话可能有多条 `item.completed`（每条工具结果也可能带）。
 * 取 `created_at` **最大**的那条 message 条目作为这轮的最终输出；`item.completed` 的
 * `itemType` 必须不是 `tool`（那是工具结果，不是助手话）。
 */
const ASSISTANT_SQL = `
select run_id, text
from (
  select
    e.run_id,
    nullif(e.payload #>> '{event,message,content}', '') as text,
    e.created_at,
    row_number() over (partition by e.run_id order by e.created_at desc, e.id desc) as rn
  from run_events e
  where e.run_id = any($1::text[])
    and e.kind in ('item.completed', 'turn.completed', 'turn.failed')
    and coalesce(e.payload ->> 'itemType', '') <> 'tool'
    and nullif(e.payload #>> '{event,message,content}', '') is not null
) t
where rn = 1
`;

/* ── 5. 写回（actions） ──────────────────────────────────────────────────── */

type ActionRaw = {
  run_id: string;
  action_id: number | string;
  intent: string;
  target: string;
  external_ref: string | null;
  applied_at: Date | null;
  reverted_at: Date | null;
  revert_kind: string | null;
  status: string;
  target_kind: string;
};

/**
 * 该 issue 的写回行。`intent in ACTION_INTENTS_SQL` 把契约外的 intent
 * （历史行里的 `open_pr` / `fallback`）挡在外面——它们会让 `recordedActionIntentSchema`
 * 整页失败；兜底回复另有 `queries/issues.ts` 的会话视图负责。
 */
const ACTIONS_SQL = `
select
  a.run_id,
  a.id as action_id,
  a.intent,
  a.target,
  a.external_ref,
  a.applied_at,
  a.reverted_at,
  ${sqlRevertKind('a.revert_kind')} as revert_kind,
  ${sqlActionStatus('a')} as status,
  t.target_kind
from actions a
join runs r on r.id = a.run_id
join tasks t on t.id = r.task_id
where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
  and a.intent in ${ACTION_INTENTS_SQL}
order by a.id asc
limit ${MAX_ACTIONS}
`;

function toAction(raw: ActionRaw): IssueTraceAction {
  const appliedAt = isoOrNull(raw.applied_at);
  return {
    actionId: String(raw.action_id),
    intent: raw.intent as IssueTraceAction['intent'],
    status: raw.status as IssueTraceAction['status'],
    target: targetOfAction(
      raw.target,
      raw.intent,
      // `targetOfAction` 只用来拼 url / 解析编号，仓库名取自 target 本身（`owner/name#n`）
      String(raw.target).includes('#') ? String(raw.target).split('#')[0] ?? '' : '',
      raw.target_kind,
      stringOrNull(raw.external_ref, 200),
      appliedAt,
    ),
    externalRef: stringOrNull(raw.external_ref, 200),
    appliedAt,
    revertedAt: isoOrNull(raw.reverted_at),
    revertKind: (raw.revert_kind ?? null) as IssueTraceAction['revertKind'],
  };
}

/* ── 入口 ─────────────────────────────────────────────────────────────────── */

/**
 * 一个 issue 的完整链路。
 *
 * 「这个 issue 从没被处理过」**不返回 `null`**：投递可能存在（被闸门拦下、还没入队），
 * 那正是要查的东西。只有 payload 也没有投递时才是空数组（查不到 ≠ 查不了）。
 * 路由层据此不需要 404 分支——这与 `/api/issues/:...` 的会话视图语义不同（那里 404
 * 表示「没跑过」，因为需求要的是会话）。
 */
export async function queryIssueTrace(
  runner: SqlRunner,
  now: Date,
  params: IssueTraceParams,
): Promise<IssueTraceResponse> {
  const repo = `${params.owner}/${params.name}`;
  const key = payloadKeyOf(params.kind);

  const deliveries = (
    await runner.query(DELIVERIES_SQL, [repo, params.kind, params.number, key, String(params.number)])
  ).rows as DeliveryRaw[];

  const runRows = (await runner.query(RUNS_SQL, [repo, params.kind, params.number])).rows as RunRaw[];
  const runIds = runRows.map((row) => row.run_id);

  // 没有 run 就不必再发三条空查询（工具 / 用量 / 正文都以 run 为键）
  const usageByRun = new Map<string, UsageRaw>();
  const toolCallsByRun = new Map<string, IssueTraceToolCall[]>();
  const truncatedRuns = new Set<string>();
  const assistantByRun = new Map<string, string>();
  const actionsByRun = new Map<string, IssueTraceAction[]>();

  if (runIds.length > 0) {
    const usageRows = (await runner.query(USAGE_SQL, [runIds])).rows as UsageRaw[];
    for (const row of usageRows) usageByRun.set(row.run_id, row);

    const toolRows = (await runner.query(TOOL_CALLS_SQL, [runIds])).rows as ToolCallRaw[];
    for (const row of toolRows) {
      const list = toolCallsByRun.get(row.run_id) ?? [];
      list.push(toToolCall(row));
      toolCallsByRun.set(row.run_id, list);
      if (intOf(row.total) > MAX_TOOL_CALLS) truncatedRuns.add(row.run_id);
    }

    const assistantRows = (await runner.query(ASSISTANT_SQL, [runIds])).rows as AssistantRaw[];
    for (const row of assistantRows) {
      assistantByRun.set(row.run_id, row.text.slice(0, MAX_ASSISTANT_CHARS));
    }

    const actionRows = (
      await runner.query(ACTIONS_SQL, [repo, params.kind, params.number])
    ).rows as ActionRaw[];
    for (const row of actionRows) {
      const list = actionsByRun.get(row.run_id) ?? [];
      list.push(toAction(row));
      actionsByRun.set(row.run_id, list);
    }
  }

  const runs: IssueTraceRun[] = runRows.map((row) => {
    const usage = usageByRun.get(row.run_id);
    return {
      runId: row.run_id,
      taskId: row.task_id,
      attempt: intOf(row.attempt),
      command: row.command,
      sessionId: stringOrNull(row.session_id, 128),
      turnId: stringOrNull(row.turn_id, 128),
      startedAt: isoOrNull(row.started_at),
      endedAt: isoOrNull(row.ended_at),
      durationMs: msBetween(row.started_at, row.ended_at),
      outcome: (row.outcome ?? null) as IssueTraceRun['outcome'],
      failureClass: (row.failure_class ?? null) as IssueTraceRun['failureClass'],
      usage:
        usage === undefined
          ? null
          : {
              model: stringOrNull(usage.model, 200),
              inputTokens: intOf(usage.input_tokens),
              outputTokens: intOf(usage.output_tokens),
              // 金额走 `Number` 后按契约「4 位小数」收敛（`numeric` 在 pg 里是字符串）
              costUsd: Math.round(Math.max(0, Number(usage.cost_usd ?? 0) || 0) * 10_000) / 10_000,
            },
      assistantText: assistantByRun.get(row.run_id) ?? null,
      toolCalls: toolCallsByRun.get(row.run_id) ?? [],
      toolCallsTruncated: truncatedRuns.has(row.run_id),
      actions: actionsByRun.get(row.run_id) ?? [],
    };
  });

  const totals = runs.reduce(
    (acc, run) => ({
      runs: acc.runs + 1,
      inputTokens: acc.inputTokens + (run.usage?.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (run.usage?.outputTokens ?? 0),
      costUsd: Math.round((acc.costUsd + (run.usage?.costUsd ?? 0)) * 10_000) / 10_000,
    }),
    { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );

  return {
    generatedAt: now.toISOString(),
    issue: { repo, kind: params.kind as IssueTraceResponse['issue']['kind'], number: params.number },
    deliveries: deliveries.map(toDeliveryRow),
    runs,
    totals,
  };
}
