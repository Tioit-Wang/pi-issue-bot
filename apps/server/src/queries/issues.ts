/**
 * 按 issue 聚合的会话视图：`GET /api/issues` 与 `GET /api/issues/:owner/:name/:kind/:number`。
 *
 * 事实源 `docs/spec/ux-issue-sessions.md` §1.3 / §3，外加 PM 评审后的 11 条修正（见 `contract-api.md` §11.2）。
 * 实现上真正吃紧的几条：
 *
 * 1. **机器人轮以 `runs` 为骨架**，不以 `actions` 为骨架：`writeback` 在 dry-run 下不写 `actions` 行，
 *    但 `run-task` 无论成败/信封是否合法都会写 `runs` + `envelopes`。同一 task 的多次 attempt **合并成一转**，
 *    `attempts` 只作脚注（否则重试会在时间线上凭空多一段机器人发言）。
 * 2. **正文源**：人类 = `webhook_deliveries.payload.comment.body`（退回 `tasks.prompt_text`）；
 *    机器人 = `envelopes.actions[intent=comment].body`；评论 id/链接来自 `actions.external_ref`
 *    （**是 comment id，不是 URL**），兜底回复的 `intent='fallback'` 也要算。
 * 3. **`humanTurns` 只数 `tasks.source='command'`**：`issues.opened|edited|reopened` 会建 `pipeline:format` 阶段任务，
 *    那是自动触发，单独记 `autoTurns`（否则列表上的「人问了几轮」被自动分诊灌水）。
 * 4. **`lastActivityAt` 取四源 max**：`tasks.queued_at`、`actions.applied_at`、`runs.ended_at`、`bot_labels.applied_at`。
 * 5. **`state` 不能只看「最新 task 的投递」**：`issues.closed` 不建任务，那样会永远显示 open。
 *    改为「该 issue 任意事件里 `received_at` 最新的投递」，取不到用 `issue_states.closed_at` 推断并置 `stateStale`。
 * 6. **jsonb 只按列取值**：`payload -> 'issue' ->> 'title'` 这类路径（`kind='pr'` 换成 `pull_request`），
 *    不把整份 payload 拉到 Node 侧。标题搜索因此不支持（没有物化列，spec 已把 `q` 拿掉）。
 *
 * 只读：本文件只有 `select`。
 */
import type { z } from 'zod';
import {
  type issuesListResponseSchema,
  type issuesQuerySchema,
  type issueSessionParamsSchema,
  type issueSessionResponseSchema,
} from '../../../../packages/contract/src/index.ts';
import {
  Params,
  QueryError,
  arrayOf,
  intOf,
  isoOf,
  isoOrNull,
  recordOf,
  sqlFailureClass,
  sqlTaskStatus,
  type SqlRunner,
} from './sql.ts';

/* ── 类型（字段名与契约一一对应，名字只去掉 Schema 后缀） ──────────────────────── */

export type IssuesQuery = z.infer<typeof issuesQuerySchema>;
export type IssuesListResponse = z.infer<typeof issuesListResponseSchema>;
export type IssueListItem = IssuesListResponse['issues'][number];
export type IssueSessionParams = z.infer<typeof issueSessionParamsSchema>;
export type IssueSessionResponse = z.infer<typeof issueSessionResponseSchema>;
export type IssueTurn = IssueSessionResponse['turns'][number];
export type IssueToolCall = IssueTurn['toolCalls'][number];

/* ── 口径常量（spec §3 的数字，改这里等于改契约） ─────────────────────────────── */

/** `lastPreview` 取正文前 120 字（默认页大小 30 定在 `issuesQuerySchema` 里）。 */
const PREVIEW_CHARS = 120;
/** 工具调用摘要取前 160 字（spec §3.2 的 `toolCalls[].summary`）。 */
const SUMMARY_CHARS = 160;
/** 单轮工具调用上限（spec §3.2）。 */
const TOOL_CALL_LIMIT = 50;
/** 单侧正文上限（契约 `issueTurnSchema.text.max`）。 */
const TEXT_CHARS = 40_000;
/** 一次会话最多返回多少轮（契约 `turns.max(500)`）。 */
const MAX_TURNS = 500;
/** 工具名取不到时的占位（契约 `issueToolCallSchema.name` 非空，面板不用判空）。 */
const UNKNOWN_TOOL = 'unknown';

/**
 * 工具参数里「适合当一行摘要」的键，按优先级排：Bash 的 `command` 最有用，其次读文件的路径、搜索的模式。
 * 只有字符串值才取（`jsonb_typeof = 'string'`），数组/对象不参与。
 */
const TOOL_ARG_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url'] as const;

/** `payload.event.args` 里按 `TOOL_ARG_KEYS` 优先级取第一个字符串值（`item.started` 才有）。 */
function sqlToolArgs(): string {
  const picks = TOOL_ARG_KEYS.map(
    (arg) =>
      `case when jsonb_typeof(e.payload -> 'event' -> 'args' -> '${arg}') = 'string' then nullif(e.payload #>> '{event,args,${arg}}', '') end`,
  );
  return `coalesce(${picks.join(', ')})`;
}

/** `payload` 里目标对象的键：PR 是 `pull_request`，其余是 `issue`。 */
function payloadKeyOf(kind: string): string {
  return kind === 'pr' ? 'pull_request' : 'issue';
}

/** 同一条 issue 的关联条件（`b` 是外层分组行）。 */
function sameIssue(alias: string): string {
  return `${alias}.repo = b.repo and ${alias}.target_kind = b.kind and ${alias}.target_number = b.number`;
}

/* ── 列表 ─────────────────────────────────────────────────────────────────── */

type IssueRow = {
  repo: string;
  kind: string;
  number: number;
  title: string | null;
  url: string | null;
  state: string | null;
  state_stale: boolean | null;
  last_activity_at: Date | null;
  human_turns: number | string | null;
  auto_turns: number | string | null;
  bot_turns: number | string | null;
  labels: string[] | null;
  outcomes: unknown;
  bot_preview: string | null;
  last_reply_at: Date | null;
  last_actor_login: string | null;
  last_actor_kind: string | null;
  awaiting_reply: boolean | null;
  human_preview: string | null;
  /** `issue_feedback` 的时间线（升序，最多 20 条；元素是 jsonb_build_object 的产物）。 */
  feedback: unknown;
  /** `label_decisions` 摘要：最近一行的 desired / applied / reason + 被拦原因计数。 */
  label_last_at: Date | null;
  label_desired: unknown;
  label_applied: unknown;
  label_reason: string | null;
  label_blocked: unknown;
  label_rows: number | string | null;
};

/**
 * 列表的公共 CTE。三块：
 *  - `base`：按 `(repo, kind, number)` 分组，同时把「人类 / 自动」分开计数；
 *  - `deliveries` / `latest`：**一次扫完**投递表，取出每个 issue 最新一条投递里的 title/url/state
 *    （每行一个 lateral 会把整表扫 30 次）；
 *  - `agg`：挂四源 `lastActivityAt`、动作计数、标签、结果分布、两条预览。
 */
function issueCte(params: Params, query: IssuesQuery): string {
  const kindParam = params.add(query.kind);
  const keyParam = params.add(payloadKeyOf(query.kind));
  const repoCond = query.repo === undefined ? '' : `\n    and t.repo = ${params.add(query.repo)}`;

  return `with base as (
  select
    t.repo,
    t.target_kind as kind,
    t.target_number as number,
    max(t.queued_at) as last_queued_at,
    count(*) filter (where t.source = 'command') as human_turns,
    count(*) filter (where t.source <> 'command') as auto_turns,
    max(t.queued_at) filter (where t.source = 'command') as last_human_at
  from tasks t
  where t.target_kind = ${kindParam}${repoCond}
  group by t.repo, t.target_kind, t.target_number
),
deliveries as (
  select
    d.payload -> 'repository' ->> 'full_name' as repo,
    (d.payload -> ${keyParam} ->> 'number')::int as number,
    d.payload -> ${keyParam} ->> 'title' as title,
    d.payload -> ${keyParam} ->> 'html_url' as url,
    d.payload -> ${keyParam} ->> 'state' as state,
    d.received_at
  from webhook_deliveries d
  where d.payload -> 'repository' ->> 'full_name' in (select repo from base)
    and jsonb_typeof(d.payload -> ${keyParam} -> 'number') = 'number'
),
latest as (
  select distinct on (repo, number) repo, number, title, url, state
  from deliveries
  where coalesce(title, '') <> '' or state is not null
  order by repo, number, received_at desc, number
),
agg as (
  select
    b.repo,
    b.kind,
    b.number,
    b.human_turns,
    b.auto_turns,
    b.last_queued_at,
    greatest(
      b.last_queued_at,
      coalesce(act.last_action_at, b.last_queued_at),
      coalesce(run.last_run_end, b.last_queued_at),
      coalesce(lb.last_label_at, b.last_queued_at)
    ) as last_activity_at,
    coalesce(act.bot_turns, 0) as bot_turns,
    lb.labels,
    oc.outcomes,
    iss.title,
    iss.url,
    coalesce(iss.state, case when st.closed_at is not null then 'closed' end) as state,
    (iss.state is null) as state_stale,
    act.last_reply_at as last_reply_at,
    la.login as last_actor_login,
    la.kind as last_actor_kind,
    (
      coalesce(iss.state, case when st.closed_at is not null then 'closed' end) = 'open'
      and la.kind = 'human'
      and (
        act.last_reply_at is null
        or act.last_reply_at < greatest(coalesce(b.last_human_at, to_timestamp(0)), coalesce(la.at, to_timestamp(0)))
      )
    ) as awaiting_reply,
    bp.body as bot_preview,
    hp.body as human_preview,
    fbt.events as feedback,
    ld.last_at as label_last_at,
    ld.desired as label_desired,
    ld.applied as label_applied,
    ld.reason as label_reason,
    ld.blocked as label_blocked,
    ld.row_count as label_rows
  from base b
  left join lateral (
    select
      count(*) as bot_turns,
      max(a.applied_at) as last_action_at,
      max(a.applied_at) filter (where a.intent in ('comment', 'fallback')) as last_reply_at
    from actions a
    join runs r on r.id = a.run_id
    join tasks t on t.id = r.task_id
    where ${sameIssue('t')}
  ) act on true
  left join lateral (
    select max(r.ended_at) as last_run_end
    from runs r
    join tasks t on t.id = r.task_id
    where ${sameIssue('t')}
  ) run on true
  left join lateral (
    select
      array_agg(l.label order by l.applied_at, l.label) as labels,
      max(l.applied_at) as last_label_at
    from bot_labels l
    where l.repo = b.repo and l.issue_number = b.number and l.removed_at is null
  ) lb on true
  left join lateral (
    select s.closed_at
    from issue_states s
    where s.repo = b.repo and s.issue_number = b.number
  ) st on true
  left join latest iss on iss.repo = b.repo and iss.number = b.number
  left join lateral (
    select jsonb_object_agg(s.status, s.n) as outcomes
    from (
      select ${sqlTaskStatus('t.status')} as status, count(*) as n
      from tasks t
      where ${sameIssue('t')}
      group by 1
    ) s
  ) oc on true
  left join lateral (
    select cm.body
    from runs r
    join tasks t on t.id = r.task_id
    join envelopes e on e.run_id = r.id
    cross join lateral (
      select a.value ->> 'body' as body
      from jsonb_array_elements(
        case when jsonb_typeof(e.actions) = 'array' then e.actions else '[]'::jsonb end
      ) as a(value)
      where a.value ->> 'intent' = 'comment' and coalesce(a.value ->> 'body', '') <> ''
      limit 1
    ) cm
    where ${sameIssue('t')}
    order by r.ended_at desc nulls last, r.attempt desc, r.id desc
    limit 1
  ) bp on true
  left join lateral (
    select coalesce(
      nullif(btrim(t.prompt_text), ''),
      nullif(btrim(d.payload -> 'comment' ->> 'body'), '')
    ) as body
    from tasks t
    left join webhook_deliveries d on d.delivery_id = t.delivery_id
    where ${sameIssue('t')}
      and coalesce(
        nullif(btrim(t.prompt_text), ''),
        nullif(btrim(d.payload -> 'comment' ->> 'body'), '')
      ) is not null
    order by t.queued_at desc
    limit 1
  ) hp on true
  left join lateral (
    select
      d.payload -> 'sender' ->> 'login' as login,
      case
        -- sender 缺失（老投递/测试夹具）时必须留在 null，不能默认成 bot
        when d.payload -> 'sender' ->> 'type' is null then null
        when d.payload -> 'sender' ->> 'type' = 'User' then 'human'
        else 'bot'
      end as kind,
      d.received_at as at
    from webhook_deliveries d
    where d.event = 'issue_comment'
      and d.action = 'created'
      and d.payload -> 'repository' ->> 'full_name' = b.repo
      and jsonb_typeof(d.payload -> ${keyParam} -> 'number') = 'number'
      and (d.payload -> ${keyParam} ->> 'number')::int = b.number
    order by d.received_at desc
    limit 1
  ) la on true
  /*
   * 无感反馈时间线（issue_feedback）：取最近 20 条再升序排，元素直接拼成契约的
   * IssueFeedbackEvent 形状（stage/content/appliedAt/at/commentId）。
   * reactionState 由 Node 侧从这条时间线里挑「最新终态」，不再多扫一次表。
   */
  left join lateral (
    select jsonb_agg(
             jsonb_build_object(
               'stage', s.stage,
               'content', s.content,
               'appliedAt', s.applied_at,
               'at', s.created_at,
               'commentId', s.comment_id
             )
             order by s.created_at asc, s.id asc
           ) as events
    from (
      select f.stage, f.content, f.applied_at, f.created_at, f.comment_id, f.id
      from issue_feedback f
      where f.repo = b.repo and f.target_kind = b.kind and f.target_number = b.number
        and f.stage in ('received', 'succeeded', 'failed', 'timed-out', 'cancelled')
      order by f.created_at desc, f.id desc
      limit 20
    ) s
  ) fbt on true
  /*
   * 打标判定摘要（label_decisions）：最近一行的 desired/applied/reason（当天可读的结论）
   * + 被拦原因计数（blocked_reason 聚合，数量降序，最多 20 条）。
   */
  left join lateral (
    select
      max(d.created_at) as last_at,
      (array_agg(d.desired order by d.created_at desc, d.id desc))[1] as desired,
      (array_agg(d.applied order by d.created_at desc, d.id desc))[1] as applied,
      (array_agg(d.reason order by d.created_at desc, d.id desc))[1] as reason,
      count(*) as row_count,
      (
        select jsonb_object_agg(k.blocked_reason, k.n)
        from (
          select d2.blocked_reason, count(*) as n
          from label_decisions d2
          where d2.repo = b.repo and d2.target_number = b.number and d2.blocked_reason is not null
          group by d2.blocked_reason
          order by count(*) desc, d2.blocked_reason asc
          limit 20
        ) k
      ) as blocked
    from label_decisions d
    where d.repo = b.repo and d.target_number = b.number
  ) ld on true
)`;
}

/** 状态取值只认 `open` / `closed`，其余（含取不到）一律 `unknown`。 */
function stateOf(raw: string | null): IssueListItem['state'] {
  return raw === 'open' || raw === 'closed' ? raw : 'unknown';
}

/** 标签清洗：长度 1–50、无控制字符、去重、最多 50 个（与 `verdictOf` 同口径）。 */
function labelsOf(raw: readonly string[] | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const seen = new Set<string>();
  for (const label of raw) {
    if (typeof label !== 'string' || label.length === 0 || label.length > 50) continue;
    if (/\p{Cc}/u.test(label)) continue;
    seen.add(label);
    if (seen.size >= 50) break;
  }
  return [...seen];
}

/* ── 无感反馈 / 打标判定（W3-H 给面板补的展示字段） ─────────────────────────── */

/** 契约里 `IssueFeedbackEvent` 的形状（间接取自 `IssueListItem.reactionState`，不手抄 DTO）。 */
type IssueFeedbackEvent = NonNullable<IssueListItem['reactionState']>;

/** `issue_feedback.stage` 的 5 个契约取值（SQL 里已经过滤过一次，这里是第二道闸）。 */
const FEEDBACK_STAGES = ['received', 'succeeded', 'failed', 'timed-out', 'cancelled'] as const;
/** reaction 的 content 白名单；库里有别的 content 时给 `null`（不猜）。 */
const REACTION_CONTENTS = ['eyes', 'rocket', 'confused'] as const;
/** 时间线最多回多少条（契约 `feedback.max(20)`）。 */
const MAX_FEEDBACK = 20;

/** `issue_feedback` 的一行（jsonb 产物）→ 契约的 `IssueFeedbackEvent`；坏行返回 `null`。 */
function feedbackEventOf(raw: unknown): IssueFeedbackEvent | null {
  const record = recordOf(raw);
  const stage = FEEDBACK_STAGES.find((value) => value === record['stage']);
  const at = isoOrNull(record['at']);
  if (stage === undefined || at === null) return null;
  const content = REACTION_CONTENTS.find((value) => value === record['content']) ?? null;
  const rawComment = record['commentId'];
  const commentId =
    typeof rawComment === 'string' && rawComment !== ''
      ? rawComment.slice(0, 64)
      : typeof rawComment === 'number'
        ? String(rawComment).slice(0, 64)
        : null;
  return { stage, content, appliedAt: isoOrNull(record['appliedAt']), at, commentId };
}

/** 时间线（升序）：解析不了的行直接丢——一条脏数据不该让整个列表 500。 */
function feedbackTimelineOf(raw: unknown): IssueFeedbackEvent[] {
  return arrayOf(raw)
    .map(feedbackEventOf)
    .filter((item): item is IssueFeedbackEvent => item !== null)
    .slice(-MAX_FEEDBACK);
}

/** 当前 reaction 状态 = 时间线里**最新一个终态**（`received` 只是「我收到了」，不算终态）。 */
function reactionStateOf(timeline: readonly IssueFeedbackEvent[]): IssueFeedbackEvent | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index];
    if (event !== undefined && event.stage !== 'received') return event;
  }
  return null;
}

/** `label_decisions` 的聚合列 → 契约的 `IssueLabelDecisionSummary`；一行都没有时返回 `null`。 */
function labelDecisionSummaryOf(row: IssueRow): IssueListItem['labelDecisions'] {
  if (intOf(row.label_rows) === 0) return null;
  const blocked = recordOf(row.label_blocked);
  const entries = Object.entries(blocked)
    .map(([reason, count]) => ({ reason: reason.slice(0, 120), count: intOf(count) }))
    .filter((entry) => entry.reason !== '' && entry.count > 0)
    .slice(0, 20);
  return {
    lastAt: isoOrNull(row.label_last_at),
    desired: labelsOf(arrayOf(row.label_desired).filter((value): value is string => typeof value === 'string')),
    applied: labelsOf(arrayOf(row.label_applied).filter((value): value is string => typeof value === 'string')),
    reason: oneLine(row.label_reason, 500),
    blocked: entries,
  };
}

/** 正文/摘要压成一行并截断（列表预览与工具摘要共用）。 */
function oneLine(raw: string | null | undefined, maxChars: number): string | null {
  if (raw === null || raw === undefined) return null;
  const flat = raw.replace(/\s+/gu, ' ').trim();
  if (flat === '') return null;
  return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
}

/**
 * 取第一行并截断（工具参数摘要用）。
 *
 * Bash 的 `command` 是多行脚本：直接塞进一行摘要会把气泡撑爆，所以只留第一个非空行再截 160 字。
 */
function firstLine(raw: string | null | undefined, maxChars: number): string | null {
  if (raw === null || raw === undefined) return null;
  const line = raw
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (line === undefined || line === '') return null;
  const flat = line.replace(/\s+/gu, ' ');
  return flat.length > maxChars ? flat.slice(0, maxChars) : flat;
}

/** 长正文：保留换行（会话气泡按原文渲染），只做长度保护。 */
function longText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (raw.trim() === '') return null;
  return raw.length > TEXT_CHARS ? raw.slice(0, TEXT_CHARS) : raw;
}

/** 结果分布 `{failed: 2}`：库里的 status 已在 SQL 里映射成契约取值。 */
function outcomesOf(raw: unknown): IssueListItem['outcomes'] {
  const record = recordOf(raw);
  const out: IssueListItem['outcomes'] = {};
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
    const value = record[status];
    if (value === undefined || value === null) continue;
    const count = intOf(value, 0);
    if (count > 0) out[status] = count;
  }
  return out;
}

function toListItem(row: IssueRow): IssueListItem {
  const title = oneLine(row.title, 500);
  // 反馈时间线算一次：`reactionState` 与 `feedback` 都从它派生（同源，不会自相矛盾）
  const feedback = feedbackTimelineOf(row.feedback);
  return {
    repo: row.repo,
    kind: row.kind as IssueListItem['kind'],
    number: intOf(row.number),
    title,
    url: row.url === null ? null : row.url.slice(0, 500),
    state: stateOf(row.state),
    stateStale: row.state_stale !== false,
    lastActivityAt: isoOf(row.last_activity_at, new Date(0).toISOString()),
    humanTurns: intOf(row.human_turns),
    autoTurns: intOf(row.auto_turns),
    botTurns: intOf(row.bot_turns),
    labels: labelsOf(row.labels),
    outcomes: outcomesOf(row.outcomes),
    lastReplyAt: isoOrNull(row.last_reply_at),
    lastActorLogin: row.last_actor_login === null ? null : row.last_actor_login.slice(0, 100),
    lastActorKind: row.last_actor_kind === 'human' || row.last_actor_kind === 'bot' ? row.last_actor_kind : null,
    awaitingReply: row.awaiting_reply === true,
    lastPreview: oneLine(row.bot_preview, PREVIEW_CHARS) ?? oneLine(row.human_preview, PREVIEW_CHARS),
    reactionState: reactionStateOf(feedback),
    labelDecisions: labelDecisionSummaryOf(row),
    feedback,
  };
}

/**
 * 游标：`base64url("<lastActivityAt>|<repo>#<kind><number>")`。
 *
 * 元组必须**含 `kind`**：`(lastActivityAt, repo, kind, number)` 才是唯一键，
 * 否则同仓库的 `issue#5` 与 `pr#5` 会互相挤掉（漏行/重复）。
 */
function encodeIssueCursor(at: string, repo: string, kind: string, number: number): string {
  return Buffer.from(`${at}|${repo}#${kind}${number}`, 'utf8').toString('base64url');
}

type IssueCursor = { at: string; repo: string; kind: string; number: number };

function decodeIssueCursor(raw: string | undefined): IssueCursor | null {
  if (raw === undefined || raw === '') return null;
  const invalid = (): never => {
    throw new QueryError('bad-request', 'cursor 不是合法游标，请原样回传上一页的 nextCursor');
  };
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return invalid();
  }
  const bar = text.indexOf('|');
  const hash = text.lastIndexOf('#');
  if (bar <= 0 || hash <= bar) return invalid();
  const at = text.slice(0, bar);
  const repo = text.slice(bar + 1, hash);
  const match = /^(issue|pr)(\d+)$/u.exec(text.slice(hash + 1));
  const parsed = new Date(at);
  if (repo === '' || match === null || Number.isNaN(parsed.getTime())) return invalid();
  const kind = match[1] ?? '';
  const number = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(number) || number <= 0) return invalid();
  return { at: parsed.toISOString(), repo, kind, number };
}

/**
 * 列表：`lastActivityAt` 降序，keyset 分页（`(lastActivityAt, repo, kind, number)` 严格小于游标）。
 *
 * 没有 `q`：标题只在 jsonb 里，按 §0 的约定不做 jsonb 深挖（spec 已把标题搜索留给后续物化列）。
 */
export async function queryIssues(
  runner: SqlRunner,
  now: Date,
  query: IssuesQuery,
): Promise<IssuesListResponse> {
  const limit = query.limit;
  const params = new Params();
  const cte = issueCte(params, query);

  const where: string[] = [];
  const cursor = decodeIssueCursor(query.cursor);
  if (cursor !== null) {
    const at = params.add(cursor.at, 'timestamptz');
    const repo = params.add(cursor.repo);
    const kind = params.add(cursor.kind);
    const number = params.add(cursor.number, 'int');
    where.push(`(a.last_activity_at, a.repo, a.kind, a.number) < (${at}, ${repo}, ${kind}, ${number})`);
  }
  // ── 派生状态筛选：顺序必须与 `issueStatusFilterSchema` 的优先级一致 ────────────
  const statusFilter = query.status;
  if (statusFilter !== undefined) {
    const n = (key: string): string => `coalesce((a.outcomes ->> '${key}')::int, 0)`;
    const running = `${n('running')} > 0`;
    const queued = `${n('queued')} > 0`;
    const failed = `${n('failed')} > 0`;
    const succeeded = `${n('succeeded')} > 0`;
    const notRunning = `not (${running})`;
    const notQueued = `not (${queued})`;
    switch (statusFilter) {
      case 'running':
        where.push(running);
        break;
      case 'queued':
        where.push(`${notRunning} and ${queued}`);
        break;
      case 'failed':
        where.push(`${notRunning} and ${notQueued} and ${failed} and not (${succeeded})`);
        break;
      case 'answered':
        where.push(`${notRunning} and ${notQueued} and ${succeeded}`);
        break;
      case 'idle':
        where.push(`${notRunning} and ${notQueued} and not (${failed}) and not (${succeeded})`);
        break;
    }
  }

  // ── issue 状态：`unknown` = 取不到元数据（agg.state is null）────────────────────
  if (query.state !== undefined) {
    where.push(query.state === 'unknown' ? 'a.state is null' : `a.state = ${params.add(query.state)}`);
  }

  // ── 我方欠一个回答：判定在 SQL 里算好（`awaiting_reply`），这里只筛这一列 ──────────
  if (query.awaiting === 'true') {
    where.push('a.awaiting_reply');
  }
  const whereSql = where.length === 0 ? '' : `\n  where ${where.join('\n    and ')}`;
  const limitParam = params.add(limit + 1, 'int');

  const rows = (
    await runner.query(
      `${cte}
select * from agg a${whereSql}
order by a.last_activity_at desc, a.repo desc, a.kind desc, a.number desc
limit ${limitParam}`,
      params.list(),
    )
  ).rows as IssueRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const lastAt = last === undefined ? null : isoOrNull(last.last_activity_at);

  return {
    generatedAt: now.toISOString(),
    issues: page.map(toListItem),
    hasMore,
    nextCursor:
      hasMore && last !== undefined && lastAt !== null
        ? encodeIssueCursor(lastAt, last.repo, last.kind, intOf(last.number))
        : null,
  };
}

/* ── 会话 ─────────────────────────────────────────────────────────────────── */

type MetaRow = {
  title: string | null;
  url: string | null;
  state: string | null;
  state_stale: boolean | null;
  labels: string[] | null;
  participants: string[] | null;
  bot_login: string | null;
  /** `issue_feedback` 时间线（升序，最多 20 条）。 */
  feedback: unknown;
};

type TaskTurnRow = {
  id: string;
  actor_login: string | null;
  command: string;
  source: string;
  queued_at: Date;
  status: string;
  failure_class: string | null;
  comment_body: string | null;
  comment_url: string | null;
  prompt_text: string | null;
};

type RunRow = {
  run_id: string;
  task_id: string;
  attempt: number;
  started_at: Date | null;
  ended_at: Date | null;
  queued_at: Date;
  task_status: string;
  failure_class: string | null;
  body: string | null;
  comment_intent: string | null;
  comment_ref: string | null;
  labels: string[] | null;
};

type ToolCallRow = {
  run_id: string;
  call_id: string;
  at: Date;
  name: string | null;
  args_raw: string | null;
  output_raw: string | null;
  failed: boolean | null;
  total: number | string;
};

/** 触发渠道：只有 `tasks.source='command'` 才是人类；`/命令` 是 command，其余（`@answer`/纯提问）是 mention。 */
function channelOf(row: TaskTurnRow): IssueTurn['channel'] {
  if (row.source !== 'command') return 'auto';
  return row.command.startsWith('/') ? 'command' : 'mention';
}

function toHumanTurn(row: TaskTurnRow): IssueTurn {
  return {
    id: `task:${row.id}`,
    role: 'human',
    login: row.actor_login === null ? null : row.actor_login.slice(0, 100),
    at: isoOf(row.queued_at, new Date(0).toISOString()),
    channel: channelOf(row),
    // 正文优先取触发评论原文（payload.comment.body）；没有评论（`issues.opened` 这类事件）才退回 prompt_text。
    text: longText(row.comment_body) ?? longText(row.prompt_text),
    commentId: null,
    commentUrl: row.comment_url === null ? null : row.comment_url.slice(0, 500),
    labels: [],
    status: row.status as IssueTurn['status'],
    failureClass: (row.failure_class ?? null) as IssueTurn['failureClass'],
    taskId: null,
    attempts: 1,
    toolCalls: [],
    truncated: false,
  };
}

/** `actions.external_ref` 是评论 id（字符串，可能不是纯数字）；只拼 GitHub 的评论锚点，不假设它是 URL。 */
function commentUrlOf(repo: string, number: number, ref: string | null): string | null {
  if (ref === null || ref === '') return null;
  return `https://github.com/${repo}/issues/${number}#issuecomment-${ref}`.slice(0, 500);
}

/** 合并后的机器人轮（同一 task 的多次 attempt 只出一轮）。 */
type BotGroup = {
  taskId: string;
  runId: string;
  attempt: number;
  attempts: number;
  at: Date;
  taskStatus: string;
  failureClass: string | null;
  body: string | null;
  commentRef: string | null;
  labels: string[] | null;
  truncated: boolean;
};

/**
 * 把同一 task 的 run 行合并成一转。
 *
 * 输入按 `attempt desc` 排好序，所以第一行就是「最后一次 attempt」（代表行）；
 * 正文与评论 id 若代表行为空，则回退到同组里更早的 attempt（信封不合法的重试可能只有前一次留下正文）。
 */
function groupBotRuns(rows: readonly RunRow[], truncatedByRun: ReadonlyMap<string, boolean>): BotGroup[] {
  const groups = new Map<string, RunRow[]>();
  for (const row of rows) {
    const list = groups.get(row.task_id) ?? [];
    list.push(row);
    groups.set(row.task_id, list);
  }
  const out: BotGroup[] = [];
  for (const [taskId, attempts] of groups) {
    const head = attempts[0];
    if (head === undefined) continue;
    const withBody = attempts.find((row) => longText(row.body) !== null);
    const withRef = attempts.find((row) => row.comment_ref !== null);
    out.push({
      taskId,
      runId: head.run_id,
      attempt: intOf(head.attempt),
      attempts: attempts.length,
      at: head.ended_at ?? head.started_at ?? head.queued_at,
      taskStatus: head.task_status,
      failureClass: head.failure_class,
      body: withBody?.body ?? null,
      commentRef: withRef?.comment_ref ?? null,
      labels: head.labels,
      truncated: truncatedByRun.get(head.run_id) === true,
    });
  }
  return out;
}

function toBotTurn(
  group: BotGroup,
  repo: string,
  number: number,
  botLogin: string | null,
  toolCalls: readonly IssueToolCall[],
): IssueTurn {
  return {
    id: `run:${group.runId}`,
    role: 'bot',
    login: botLogin,
    at: isoOf(group.at, new Date(0).toISOString()),
    channel: null,
    text: longText(group.body),
    commentId: group.commentRef,
    commentUrl: commentUrlOf(repo, number, group.commentRef),
    labels: labelsOf(group.labels),
    status: group.taskStatus as IssueTurn['status'],
    failureClass: (group.failureClass ?? null) as IssueTurn['failureClass'],
    taskId: group.taskId,
    attempts: Math.max(1, group.attempts),
    toolCalls: [...toolCalls],
    truncated: group.truncated,
  };
}

/** 轮次排序：`at` 升序；同一时刻人类在前（spec §3.2 末条），再按 id 稳定排序。 */
function compareTurns(left: IssueTurn, right: IssueTurn): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  const rank = (turn: IssueTurn): number => (turn.role === 'human' ? 0 : 1);
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 会话；`(repo, kind, number)` 没有任何 `tasks` 行时返回 `null`（http 层据此回 404，不在查询层抛）。
 *
 * 4 条 SQL：人类轮（tasks）、头部元信息、机器人轮（runs + envelopes + actions + bot_labels）、
 * 工具调用（run_events）。分开是因为基数完全不同（N / 1 / M / M×50），拼成一条会退化成行数相乘。
 */
export async function queryIssueSession(
  runner: SqlRunner,
  now: Date,
  params: IssueSessionParams,
): Promise<IssueSessionResponse | null> {
  const repo = `${params.owner}/${params.name}`;
  const kind = params.kind;
  const number = params.number;
  const key = payloadKeyOf(kind);

  // ── 1. 人类轮（顺带当存在性检查：没有 tasks 行 = 这条 issue 从没被处理过） ──
  const taskRows = (
    await runner.query(
      `select
         t.id,
         t.actor_login,
         t.command,
         t.source,
         t.queued_at,
         t.prompt_text,
         ${sqlTaskStatus('t.status')} as status,
         ${sqlFailureClass('last_run.failure_class')} as failure_class,
         d.payload -> 'comment' ->> 'body' as comment_body,
         d.payload -> 'comment' ->> 'html_url' as comment_url
       from tasks t
       left join webhook_deliveries d on d.delivery_id = t.delivery_id
       left join lateral (
         select r.failure_class
         from runs r
         where r.task_id = t.id
         order by r.attempt desc, r.started_at desc, r.id desc
         limit 1
       ) last_run on true
       where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
       order by t.queued_at asc, t.id asc`,
      [repo, kind, number],
    )
  ).rows as TaskTurnRow[];

  if (taskRows.length === 0) return null;

  // ── 2. 头部：标题 / 链接 / 状态 / 标签 / 参与者 / 机器人 login ────────────────
  const metaRows = (
    await runner.query(
      `select
         iss.title,
         iss.url,
         coalesce(iss.state, case when st.closed_at is not null then 'closed' end) as state,
         (iss.state is null) as state_stale,
         (
           select array_agg(l.label order by l.applied_at, l.label)
           from bot_labels l
           where l.repo = $1 and l.issue_number = $3 and l.removed_at is null
         ) as labels,
         (
           select array_agg(x.login order by x.first_at)
           from (
             select t.actor_login as login, min(t.queued_at) as first_at
             from tasks t
             where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
               and t.actor_login is not null
             group by 1
           ) x
         ) as participants,
         (select rp.config -> 'bot' ->> 'login' from repos rp where rp.repo_full_name = $1) as bot_login,
        fbt.events as feedback
       from (select 1) z
      left join lateral (
        select
          d.payload -> $4 ->> 'title' as title,
          d.payload -> $4 ->> 'html_url' as url,
          d.payload -> $4 ->> 'state' as state
        from webhook_deliveries d
        where d.payload -> 'repository' ->> 'full_name' = $1
          and d.payload -> $4 ->> 'number' = $5
        order by d.received_at desc, d.delivery_id desc
        limit 1
      ) iss on true
      left join lateral (
        select s.closed_at
        from issue_states s
        where s.repo = $1 and s.issue_number = $3
      ) st on true
     /*
      * 无感反馈：时间线 + 待落地项（applied_at is null：dry-run 计划 / 排队中）。
      * 与列表同一条 SQL 形状，reactionState 由 Node 侧挑「最新终态」。
      */
     left join lateral (
       select jsonb_agg(
                jsonb_build_object(
                  'stage', s.stage,
                  'content', s.content,
                  'appliedAt', s.applied_at,
                  'at', s.created_at,
                  'commentId', s.comment_id
                )
                order by s.created_at asc, s.id asc
              ) as events
       from (
         select f.stage, f.content, f.applied_at, f.created_at, f.comment_id, f.id
         from issue_feedback f
         where f.repo = $1 and f.target_kind = $2 and f.target_number = $3
           and f.stage in ('received', 'succeeded', 'failed', 'timed-out', 'cancelled')
         order by f.created_at desc, f.id desc
         limit 20
       ) s
     ) fbt on true`,
      // $5 是编号的字符串形态：$3 已被 issue_number / target_number 推成整数，
      // 同一个参数再写 `$3::text` 会让 PG 报 operator 不存在（integer = text）。
      [repo, kind, number, key, String(number)],
    )
  ).rows as MetaRow[];
  const meta = metaRows[0];
  const botLogin = botLoginOfFromRow(meta);

  // ── 3. 机器人轮：以 runs 为骨架，同一 task 的多次 attempt 合并 ────────────────
  // 评论 id 只认契约里的 comment / 契约外的 fallback（兜底回复也是「AI 回了人话」，不能整段消失）。
  const runRows = (
    await runner.query(
      `select
         r.id as run_id,
         r.task_id,
         r.attempt,
         r.started_at,
        r.ended_at,
         t.queued_at,
         ${sqlTaskStatus('t.status')} as task_status,
         ${sqlFailureClass('r.failure_class')} as failure_class,
         cm.body,
         ar.intent as comment_intent,
         ar.external_ref as comment_ref,
         lab.labels
       from runs r
       join tasks t on t.id = r.task_id
       left join lateral (
         select a.value ->> 'body' as body
         from envelopes e
         cross join lateral jsonb_array_elements(
           case when jsonb_typeof(e.actions) = 'array' then e.actions else '[]'::jsonb end
         ) as a(value)
         where e.run_id = r.id
           and a.value ->> 'intent' = 'comment'
           and coalesce(a.value ->> 'body', '') <> ''
         limit 1
       ) cm on true
       left join lateral (
         select a.intent, a.external_ref
         from actions a
         where a.run_id = r.id
           and a.intent in ('comment', 'fallback')
           and a.external_ref is not null
         order by coalesce(a.applied_at, a.created_at) desc, a.id desc
         limit 1
       ) ar on true
       left join lateral (
         select array_agg(distinct bl.label order by bl.label) as labels
         from bot_labels bl
         where bl.repo = t.repo and bl.issue_number = t.target_number
           and bl.applied_at >= coalesce(r.started_at, t.queued_at)
           and bl.applied_at <= coalesce(r.ended_at, 'infinity'::timestamptz)
       ) lab on true
       where t.repo = $1 and t.target_kind = $2 and t.target_number = $3
       order by r.task_id, r.attempt desc, r.started_at desc, r.id desc`,
      [repo, kind, number],
    )
  ).rows as RunRow[];

  // ── 4. 工具调用：按 toolCallId 合并 item.started / tool.progress / item.completed ──
  //
  // 真库里工具名**只在** `item.started` 的 `payload.event.toolName`，`tool.progress` 只有输出：
  // 按单条事件取名字永远得到 unknown。一个 toolCallId 横跨多条事件（started + N 条 progress + completed），
  // 所以先按 toolCallId 归并再计数；`item.delta` 是正文流，一律不进来（否则 50 条上限被流式增量吃光）。
  const toolCallsByRun = new Map<string, IssueToolCall[]>();
  const truncatedByRun = new Map<string, boolean>();
  if (runRows.length > 0) {
    const toolRows = (
      await runner.query(
        `with raw as (
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
             case when e.kind = 'item.started' then ${sqlToolArgs()} end as args_raw,
             case
               when e.kind = 'tool.progress' then coalesce(
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
             ) as failed
           from run_events e
           where e.run_id = any($1::text[])
             and e.kind in ('item.started', 'tool.progress', 'item.completed')
             -- item.started 同样用于消息条目（itemType=message，itemId 是消息 uuid，没有 toolCallId / toolName），
             -- 只认 itemType=tool，否则每条消息都会冒充一次工具调用
             and e.payload ->> 'itemType' = 'tool'
         ),
         merged as (
           select
             run_id,
             call_id,
             min(created_at) as at,
             (array_agg(tool_name order by created_at) filter (where tool_name is not null))[1] as name,
             (array_agg(args_raw order by created_at) filter (where args_raw is not null))[1] as args_raw,
             (array_agg(output_raw order by created_at) filter (where output_raw is not null))[1] as output_raw,
             coalesce(bool_or(failed), false) as failed
           from raw
           where call_id is not null
           group by run_id, call_id
         ),
         ranked as (
           select
             merged.*,
             count(*) over (partition by run_id) as total,
             row_number() over (partition by run_id order by at, call_id) as rn
           from merged
         )
         select run_id, call_id, at, name, args_raw, output_raw, failed, total
         from ranked
         where rn <= ${TOOL_CALL_LIMIT}
         order by run_id, at, call_id`,
        [runRows.map((row) => row.run_id)],
      )
    ).rows as ToolCallRow[];

    for (const row of toolRows) {
      const list = toolCallsByRun.get(row.run_id) ?? [];
      list.push({
        name: oneLine(row.name, 200) ?? UNKNOWN_TOOL,
        // 参数优先（Bash 的 command 是多行脚本 → 只留第一行）；没有 args 才退回输出首行
        summary: firstLine(row.args_raw, SUMMARY_CHARS) ?? firstLine(row.output_raw, SUMMARY_CHARS),
        // 该 toolCallId 最早一条事件的时间 = 工具开始时间
        at: isoOf(row.at, new Date(0).toISOString()),
        ok: row.failed !== true,
      });
      toolCallsByRun.set(row.run_id, list);
      if (intOf(row.total) > TOOL_CALL_LIMIT) truncatedByRun.set(row.run_id, true);
    }
  }

  const turns: IssueTurn[] = [
    ...taskRows.map(toHumanTurn),
    ...groupBotRuns(runRows, truncatedByRun).map((group) =>
      toBotTurn(group, repo, number, botLogin, toolCallsByRun.get(group.runId) ?? []),
    ),
  ]
    .sort(compareTurns)
    .slice(0, MAX_TURNS);

  const participants = (meta?.participants ?? [])
    .filter((login): login is string => typeof login === 'string' && login !== '')
    .map((login) => login.slice(0, 100));
  if (botLogin !== null && !participants.includes(botLogin)) participants.push(botLogin);

  // 反馈时间线：`reactionState` = 最新终态；`pendingFeedback` = 记了台账但 `applied_at` 还空着的
  const feedback = feedbackTimelineOf(meta?.feedback);
  return {
    generatedAt: now.toISOString(),
    issue: {
      repo,
      kind,
      number,
      title: oneLine(meta?.title, 500),
      url: meta?.url === null || meta?.url === undefined ? null : meta.url.slice(0, 500),
      state: stateOf(meta?.state ?? null),
      stateStale: meta?.state_stale !== false,
      labels: labelsOf(meta?.labels),
      participants: participants.slice(0, 100),
      reactionState: reactionStateOf(feedback),
      pendingFeedback: feedback.filter((event) => event.appliedAt === null),
    },
    turns,
  };
}

/** `MetaRow` → 机器人 login（`repos.config.bot.login`；没有 `repos` 行或没配就是 `null`）。 */
function botLoginOfFromRow(meta: MetaRow | undefined): string | null {
  if (meta === undefined || meta.bot_login === null) return null;
  const login = meta.bot_login;
  return login !== '' && login.length <= 100 ? login : null;
}
