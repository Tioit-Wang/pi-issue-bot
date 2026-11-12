/**
 * v2.1 全链路集成的**共用接线层**（WS6 / `docs/v21-contract.md` §2、§3、§4、§6）。
 *
 * 为什么不把这些逻辑直接撒进 `webhook.ts` / `run-task.ts` / `compose.ts`：
 *  - 这三个文件的旧路径（`source='pipeline'|'command'`，以及 v0.3 的 agent 消息）被大量单测钉住，
 *    任何「顺手改一行」都可能把旧行为改坏；新逻辑集中在**新模块**，旧文件只留「if 注入了 v21 才走」的钩子；
 *  - 判定 / 渲染 / 执行 / 会话 / 压缩五件事都要读同一份 `repos.settings`，集中一处才能只解析一次；
 *  - 单测可以用内存假实现直接调这里的纯函数，不必起 PostgreSQL 或 pi-host。
 *
 * 本模块**不碰** `trigger/**`、`prompt/**`、`writeback/**`、`compact/**`、`config/**` 的实现，
 * 只做「按冻结契约调用 + 把结果落到库/事件流」这一层装配。
 */
import type { EventKey, WebhookAcceptedResponse, ErrorBody } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import {
  readV21Settings,
  resolveAgentExecution,
  resolveEventTrigger,
  resolveManagedCatalog,
} from '../config/v21-settings.ts';
import type { SqlRunner } from '../config/repo-config.ts';
import { decideEvent, decidePullRequest, DEFAULT_EVENT_TEMPLATES } from '../trigger/decide.ts';
import type { DecideEventInput, TriggerDecision } from '../trigger/decide.ts';
import { needsRepoIssues, renderTemplate, renderTemplateAsync } from '../prompt/render.ts';
import type { AsyncRenderContext, RenderContext, RenderResult } from '../prompt/render.ts';
import { createRepoIssuesProvider } from '../prompt/repo-issues.ts';
import type { RepoIssuesLister, RepoIssuesProvider } from '../prompt/repo-issues.ts';
import { agentTaskIdempotencyKey, eventFingerprint, findTaskIdByKey, insertMessage } from '../agent/index.ts';
import { errorBodyOf } from './errors.ts';
import { parseOutputV21Json } from '../../../../packages/envelope/src/index.ts';
import type { OutputV21, OutputV21Issue } from '../../../../packages/envelope/src/index.ts';
import { createV21PortFromGithub, executeV21 } from '../writeback/v21/execute.ts';
import type { ExecuteV21Result, V21ActionSwitches, V21PortSources } from '../writeback/v21/execute.ts';
import type { CatalogEntry } from '../writeback/v21/labels.ts';
import { createCompactionStore } from '../compact/store.ts';
import type {
  CompactionRecordInput,
  CompactInput,
  CompactResult,
  CompactStore,
} from '../compact/engine.ts';
import { planSessionOnEvent } from '../agent/session-state.ts';
import type { AgentSessionRow, SessionEventKey, SessionState, SessionTransition } from '../agent/session-state.ts';
import type { GithubReactionApi, GithubRequest, ReactionContent } from '../github/index.ts';

/* ── 0. 载荷读取的小工具（与 webhook.ts 的口径一致，刻意不 import 它的私有函数） ── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function num(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** 载荷里「没给」与「给了 0」必须能区分（issue.number 从 1 起，0 = 缺失）。 */
function nullableNum(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── 1. 事件判定（FR-2.1 ~ FR-2.5 / BR-6） ──────────────────────────────── */

/** webhook 的 `X-GitHub-Event` + `payload.action` → 五个事件键之一，或 PR 通配键。 */
export function v21EventKeyOf(event: string, action: string | null): EventKey | 'pull_request.*' | null {
  if (event.startsWith('pull_request')) {
    // §0「不纳入」：PR 事件本期一律按未触发留痕，不进 issue 会话
    return 'pull_request.*';
  }
  if (event === 'issue_comment') {
    return action === 'created' ? 'issue_comment.created' : null;
  }
  if (event === 'issues') {
    switch (action) {
      case 'opened':
        return 'issues.opened';
      case 'edited':
        return 'issues.edited';
      case 'labeled':
        return 'issues.labeled';
      case 'closed':
        return 'issues.closed';
      default:
        return null;
    }
  }
  return null;
}

/** 从 GitHub 载荷里抽出 `decideEvent()` 需要的那几项（其余由调用方给）。 */
export function v21DecisionInputOf(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly settings: unknown;
  readonly repoDisabled?: boolean | undefined;
  readonly contentDuplicate?: boolean | undefined;
  readonly dailyQuotaExceeded?: boolean | undefined;
}): DecideEventInput | null {
  const key = v21EventKeyOf(input.event, input.action);
  if (key === null || key === 'pull_request.*') {
    return null;
  }
  const payload = asRecord(input.payload);
  const issue = asRecord(payload?.['issue']);
  const comment = asRecord(payload?.['comment']);
  const sender = asRecord(payload?.['sender']);
  const changes = asRecord(payload?.['changes']);
  const label = asRecord(payload?.['label']);
  const commentUser = asRecord(comment?.['user']);
  const state = str(issue, 'state');

  return {
    event: key,
    action: input.action ?? '',
    settings: input.settings,
    changedFields: changes === null ? [] : Object.keys(changes),
    addedLabel: str(label, 'name'),
    issueState: state === 'closed' ? 'closed' : state === 'open' ? 'open' : null,
    actorIsBot:
      str(sender, 'type') === 'Bot' ||
      str(commentUser, 'type') === 'Bot' ||
      (str(commentUser, 'login') ?? '').endsWith('[bot]'),
    comment:
      comment === null
        ? null
        : {
            body: str(comment, 'body') ?? '',
            authorAssociation: str(comment, 'author_association'),
            authorLogin: str(commentUser, 'login') ?? str(sender, 'login'),
          },
    ...(input.repoDisabled === undefined ? {} : { repoDisabled: input.repoDisabled }),
    ...(input.contentDuplicate === undefined ? {} : { contentDuplicate: input.contentDuplicate }),
    ...(input.dailyQuotaExceeded === undefined ? {} : { dailyQuotaExceeded: input.dailyQuotaExceeded }),
  };
}

/** 一次投递的 v2 判定；不在五个事件里（也不属于 PR）时返回 `null` = 无需留痕。 */
export function decideV21Delivery(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly settings: unknown;
  readonly repoDisabled?: boolean | undefined;
  readonly contentDuplicate?: boolean | undefined;
  readonly dailyQuotaExceeded?: boolean | undefined;
}): TriggerDecision | null {
  const key = v21EventKeyOf(input.event, input.action);
  if (key === 'pull_request.*') {
    return decidePullRequest();
  }
  const decideInput = v21DecisionInputOf(input);
  return decideInput === null ? null : decideEvent(decideInput);
}

/**
 * 判定行要写的两列（BR-6 / `docs/v21-contract.md` §2）。
 *
 * `decision` = `triggered|ignored`，`decision_reason` = `d.reason`（两侧都写）：
 * `TriggerDecision` 的判别联合两边**都有** `reason`（触发 = `enabled|conditional-met`，
 * 未触发 = `switch-off` 那一组），§2 明确要求「每次判定写 decision 与 decision_reason」。
 * 早期版本触发时留 null 是照着 `db/schema.ts` 的旧注释，但那样面板按 reason 聚合时
 * 触发侧全变成空值；这里以契约与接线核对表为准，两边都落具体 reason。
 */
export function v21DecisionRowOf(decision: TriggerDecision): {
  readonly decision: 'triggered' | 'ignored';
  readonly reason: string;
} {
  return {
    decision: decision.triggered ? 'triggered' : 'ignored',
    reason: decision.reason,
  };
}

export const V21_DECISION_SQL = {
  /** BR-6：不触发也要留痕。单独 UPDATE 而不是改 INSERT，是因为判定要等 `repos.settings` 读出来。 */
  write: 'UPDATE "webhook_deliveries" SET "decision" = $2, "decision_reason" = $3 WHERE "delivery_id" = $1',
} as const;

/** 把判定写进投递行。失败只由调用方记 warn：留痕是审计，不该让 GitHub 重投。 */
export async function writeV21Decision(
  db: SqlRunner,
  deliveryId: string,
  decision: TriggerDecision,
): Promise<void> {
  const row = v21DecisionRowOf(decision);
  await db.query(V21_DECISION_SQL.write, [deliveryId, row.decision, row.reason]);
}

/* ── 2. 模板渲染（FR-2.3 / FR-4.1） ─────────────────────────────────────── */

/** 未知占位符的结构化告警（FR-2.3 的生产消费方）。字段至少含 unknown 列表与 event/repo。 */
export type V21UnknownPlaceholderWarning = {
  /** 触发告警的事件键（五个 EventKey 之一） */
  readonly event: string;
  /** 仓库全名 `owner/name` */
  readonly repo: string;
  /** 原样保留下来的占位符名（已去重） */
  readonly unknown: readonly string[];
  /** 关联投递，便于按 delivery_id 查现场 */
  readonly deliveryId: string;
};

/**
 * `WebhookDeps.v21`：注入即启用 v2 路径，**不注入时旧行为逐字节不变**。
 *
 * 为什么用「注入才启用」而不是全局开关：旧路径（`source='pipeline'|'command'` 与 v0.3
 * 的 agent 消息）被上百个单测钉住，只要 v2 分支不改它们的入参/出参，就零回归风险。
 */
export type V21WebhookDeps = {
  readonly db: SqlRunner;
  /** 项目级 issue 索引提供者；由装配层创建**一份**并复用（缓存 5 分钟才有意义） */
  readonly repoIssues?: RepoIssuesProvider | undefined;
  /** 没传 provider 时按它现造一份（单测常用）；生产由 `createRepoIssuesLister(client.request)` 注入 */
  readonly listIssues?: RepoIssuesLister | undefined;
  readonly ttlMs?: number | undefined;
  /**
   * 未知占位符告警的可选观测钩子。
   *
   * 为什么除了 `logger.warn` 还要一个钩子：`logger.warn` 已经是生产消费方（结构化字段），
   * 但部署可能还想把「模板写错了」推到告警系统；不注入时什么都不做，不影响投递。
   */
  readonly onUnknownPlaceholders?: ((warning: V21UnknownPlaceholderWarning) => void) | undefined;
};

/**
 * 取本次 webhook 要用的 issue 索引提供者；两者都没给 = 模板里的占位符按未知处理。
 *
 * 为什么用 WeakMap 缓存：`deps.v21` 是进程级装配出来的**同一个对象**，若每次投递都
 * `createRepoIssuesProvider()` 现造一份，`prompt/repo-issues.ts` 那个 5 分钟缓存就永远只有
 * 一次命中（一次 webhook 风暴 = N 份空缓存 = N 次 GitHub 分页请求）。按 deps 对象复用
 * 才能让「同一波并发只发一次」这条约束在生产里真的成立。
 */
const providerCache = new WeakMap<V21WebhookDeps, RepoIssuesProvider>();

export function repoIssuesProviderOf(deps: V21WebhookDeps): RepoIssuesProvider | undefined {
  if (deps.repoIssues !== undefined) {
    return deps.repoIssues;
  }
  if (deps.listIssues === undefined) {
    return undefined;
  }
  const cached = providerCache.get(deps);
  if (cached !== undefined) {
    return cached;
  }
  const created = createRepoIssuesProvider({
    listIssues: deps.listIssues,
    ...(deps.ttlMs === undefined ? {} : { ttlMs: deps.ttlMs }),
  });
  providerCache.set(deps, created);
  return created;
}

/** v2 判定留痕的轨迹：`handleWebhook` 外层包装与内层管线之间只传这一份。 */
export type V21Trace = {
  decision: TriggerDecision | null;
  payload: unknown;
  action: string | null;
  /**
   * 第 3 步投递级幂等命中（同一 delivery 重投）。
   *
   * 置 true 时外层**不再回写判定**：这一行是上一次投递留下的，原判定必须保持原样；
   * 否则重投会把 `triggered` 覆写成 `repo-disabled`，审计时间线就自相矛盾了。
   */
  skipDecision: boolean;
};

/** webhook 载荷 → 渲染上下文（12 个占位符的数据源）。 */
export function v21RenderContextOf(input: {
  readonly repo: string;
  readonly eventAction: string;
  readonly payload: unknown;
  readonly repoIssues?: RepoIssuesProvider | undefined;
}): AsyncRenderContext {
  const payload = asRecord(input.payload);
  const issue = asRecord(payload?.['issue']);
  const comment = asRecord(payload?.['comment']);
  const sender = asRecord(payload?.['sender']);
  const issueUser = asRecord(issue?.['user']);
  const commentUser = asRecord(comment?.['user']);
  const labels = issue?.['labels'];
  const labelNames = Array.isArray(labels)
    ? labels.map((entry) => str(asRecord(entry), 'name') ?? '').filter((name) => name !== '')
    : [];

  const provider = input.repoIssues;
  return {
    repo: input.repo,
    actor: str(sender, 'login') ?? '',
    eventAction: input.eventAction,
    issue: {
      author: str(issueUser, 'login') ?? '',
      number: num(issue, 'number'),
      url: str(issue, 'html_url') ?? '',
      title: str(issue, 'title') ?? '',
      content: str(issue, 'body') ?? '',
      labels: labelNames,
      updatedAt: str(issue, 'updated_at') ?? '',
    },
    ...(comment === null
      ? {}
      : { comment: { author: str(commentUser, 'login') ?? '', body: str(comment, 'body') ?? '' } }),
    // 惰性：`renderTemplateAsync` 只在模板真写了 {{repo.issues}} 时才 await 这个函数
    ...(provider === undefined
      ? {}
      : { repoIssues: (): Promise<string> => provider.render(input.repo) }),
  };
}

/** 渲染一条 agent 消息正文；`unknown` 由调用方记配置告警，原文保留不改。 */
export async function renderV21AgentText(input: {
  readonly template: string;
  readonly ctx: AsyncRenderContext;
}): Promise<RenderResult> {
  return renderTemplateAsync(input.template, input.ctx);
}

/* ── 2.5 模板选择 / 未知占位符告警 / 一条 v2 消息的完整构建 ────────────────── */

/**
 * 取本轮真正要渲染的模板（FR-2.2 / FR-2.3 / FR-4.1）。
 *
 * 项目模板（`resolveEventTrigger(settings, event).prompt`）与平台内置默认模板
 * (`DEFAULT_EVENT_TEMPLATES[event]`) 在这里**收敛成同一个字符串**，之后一律交给
 * `renderTemplateAsync()`（`prompt/render.ts`）——不存在「默认模板走另一套私有渲染器」
 * 的分叉，所以 FR-2.3 的「一次遍历 / 未知原样保留」对两种模板都成立。
 */
export function v21TemplateOf(settings: unknown, event: EventKey): string {
  const prompt = resolveEventTrigger(settings, event).prompt;
  return prompt === null || prompt.trim() === '' ? DEFAULT_EVENT_TEMPLATES[event] : prompt;
}

/**
 * 未知占位符告警的**生产消费方**（FR-2.3）。
 *
 * 只在测试里断言 `unknown` 是不够的：模板是项目自己在面板里写的，写错了必须有人知道。
 * 这里落一条结构化 `warn`（字段含 unknown 列表 + event + repo + deliveryId），
 * 面板/告警系统可以直接按 `event` 聚合；`unknown` 里的占位符在正文里原样保留，
 * 既不静默丢、也不伪造数据。
 */
export function reportV21UnknownPlaceholders(
  logger: Logger,
  warning: V21UnknownPlaceholderWarning,
): void {
  logger.warn(
    {
      unknown: [...warning.unknown],
      event: warning.event,
      repo: warning.repo,
      deliveryId: warning.deliveryId,
    },
    'v2.1 模板含未知占位符：已原样保留（请检查项目事件模板配置）',
  );
}

/**
 * 从渲染结果首行认出技能触发词（`/issue-format` 这类四段结构的第一段）。
 *
 * 为什么还要单独传给 `insertMessage`：v2 的正文是模板渲染结果，不再经过 v0.3 的
 * `composeAgentMessage()`（它会摘 `/名字` 并产出 `skillIds`）。装配层仍要靠
 * `agent_messages.skill_ids` 找技能，所以这里把首行命令词显式结构化下来。
 */
export function v21SkillIdsOf(text: string): readonly string[] {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? '';
  const matched = /^\/([a-z][a-z0-9-]{1,30})$/u.exec(firstLine);
  const id = matched?.[1] ?? '';
  return id === '' ? [] : [id];
}

/** 一条 v2 消息的构建结果。 */
export type V21MessageBuild = {
  readonly template: string;
  readonly text: string;
  readonly unknown: readonly string[];
  readonly skillIds: readonly string[];
};

/**
 * 从 settings + 载荷构建本轮发给 agent 的消息正文（v2 路径的唯一入口）。
 *
 * 惰性两道闸（FR-2.3 / AC-22）：
 *  1. `needsRepoIssues(template)===false` 时**连 provider 都不取**，`listIssues` 零请求；
 *  2. 取了 provider 时也只是把一个函数交给 `renderTemplateAsync`，它在模板没写
 *     `{{repo.issues}}` 时根本不会 await（第二道保险）。
 * 取数失败时回落到同步渲染并把 `{{repo.issues}}` 当未知占位符保留 —— 绝不伪造列表。
 *
 * `decidedTemplate` 是 `decideEvent()` 已解析好的 `template`：热路径优先用**它**，
 * 不再对同一份 settings 二次 `resolveEventTrigger()`（接线核对表第 2 条）。
 * 省略时才走 `v21TemplateOf()` 的显式解析（面板预览 / 直接调用方 / 单测），
 * 两条路径的取值逻辑一致，由集成测试的等价性用例钉住，不会出现静默错值。
 */
export async function buildV21AgentMessage(input: {
  readonly settings: unknown;
  readonly event: EventKey;
  readonly repo: string;
  readonly eventAction: string;
  readonly payload: unknown;
  readonly deps: V21WebhookDeps;
  readonly logger: Logger;
  readonly deliveryId: string;
  /** 判定侧已解析好的模板；给了就不再二次解析 settings */
  readonly decidedTemplate?: string | undefined;
}): Promise<V21MessageBuild> {
  const template = input.decidedTemplate ?? v21TemplateOf(input.settings, input.event);
  const provider = needsRepoIssues(template) ? repoIssuesProviderOf(input.deps) : undefined;
  const ctx = v21RenderContextOf({
    repo: input.repo,
    eventAction: input.eventAction,
    payload: input.payload,
    ...(provider === undefined ? {} : { repoIssues: provider }),
  });

  let rendered: RenderResult;
  try {
    rendered = await renderV21AgentText({ template, ctx });
  } catch (error) {
    // provider.render() 是唯一可能抛错的异步源（GitHub 分页）。失败时按「没准备数据」处理，
    // `{{repo.issues}}` 进 unknown 并原样保留，不塞空串、更不编一份假索引。
    input.logger.warn(
      { repo: input.repo, event: input.event, err: describeError(error) },
      'v2.1 issue 索引取数失败：{{repo.issues}} 按未知占位符保留（不伪造数据）',
    );
    const syncCtx: RenderContext = {
      repo: ctx.repo,
      actor: ctx.actor,
      eventAction: ctx.eventAction,
      issue: ctx.issue,
      ...(ctx.comment === undefined ? {} : { comment: ctx.comment }),
      repoIssues: undefined,
    };
    rendered = renderTemplate(template, syncCtx);
  }

  if (rendered.unknown.length > 0) {
    const warning: V21UnknownPlaceholderWarning = {
      event: input.event,
      repo: input.repo,
      unknown: [...rendered.unknown],
      deliveryId: input.deliveryId,
    };
    reportV21UnknownPlaceholders(input.logger, warning);
    input.deps.onUnknownPlaceholders?.(warning);
  }

  return {
    template,
    text: rendered.text,
    unknown: rendered.unknown,
    skillIds: v21SkillIdsOf(rendered.text),
  };
}

/* ── 3. {{repo.issues}} 的 GitHub 适配器（§6.3） ─────────────────────────── */

type RawIssue = {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly updated_at?: unknown;
  readonly pull_request?: unknown;
};

function headerText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
}

/** 从 Link 头里读最后一页；读不到就按「已取到的条数」给 total（宁可少报也不编数）。 */
function totalFromLink(
  linkHeader: unknown,
  rowsLength: number,
  perPage: number,
  page: number,
): number {
  const link = headerText(linkHeader);
  const last = link === null ? null : /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/u.exec(link);
  if (last !== null) {
    const lastPage = Number(last[1] ?? '0');
    if (Number.isFinite(lastPage) && lastPage > 0) {
      return lastPage * perPage;
    }
  }
  return (page - 1) * perPage + rowsLength;
}

/**
 * 把 `GithubClient.request` 适配成 `createRepoIssuesProvider` 需要的 `listIssues`。
 *
 * 走 `GET /repos/{owner}/{repo}/issues`（**不是** search 接口）：GitHub 的 issues 接口
 * 会把 PR 混进来，所以 `pull_request` 字段必须原样透给 provider 去过滤（§6.3「排除 PR」）。
 */
export function createRepoIssuesLister(request: GithubRequest): RepoIssuesLister {
  return async ({ repo, state, perPage, page }) => {
    const slash = repo.indexOf('/');
    const owner = slash > 0 ? repo.slice(0, slash) : repo;
    const name = slash > 0 ? repo.slice(slash + 1) : '';
    const response = await request<readonly RawIssue[]>('GET /repos/{owner}/{repo}/issues', {
      owner,
      repo: name,
      state,
      per_page: perPage,
      page,
    });
    const rows = Array.isArray(response.data) ? response.data : [];
    return {
      total: totalFromLink(response.headers?.['link'], rows.length, perPage, page),
      items: rows.map((row) => ({
        number: typeof row.number === 'number' ? row.number : 0,
        title: typeof row.title === 'string' ? row.title : '',
        state: typeof row.state === 'string' ? row.state : 'open',
        isPullRequest: row.pull_request !== undefined && row.pull_request !== null,
        updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
      })),
    };
  };
}

/**
 * 把 `GithubReactionApi`（旧路径的窄接口）适配成 v2 执行器的 reaction 面。
 *
 * 只差 `content` 的类型宽度：v2 的 schema 已经把 content 校验成同一组枚举，
 * 这里做一次显式收窄比在两个包之间改公共类型安全得多（旧假实现一个都不用改）。
 */
export function v21ReactionsOf(reactions: GithubReactionApi): NonNullable<V21PortSources['reactions']> {
  return {
    addReaction: (input) =>
      reactions.addReaction({ ...input, content: input.content as ReactionContent }),
    listReactions: (input) =>
      reactions.listReactions({ ...input, content: input.content as ReactionContent }),
    removeReaction: (input) => reactions.removeReaction(input),
  };
}

/** 开 PR 的能力：v2.1 之前没有任何代码路径会开 PR，所以这一层单独用 REST 接上。 */
export function createV21OpenPullRequest(request: GithubRequest): NonNullable<V21PortSources['openPullRequest']> {
  return async ({ repo, head, title, body }) => {
    const slash = repo.indexOf('/');
    const owner = slash > 0 ? repo.slice(0, slash) : repo;
    const name = slash > 0 ? repo.slice(slash + 1) : '';
    const info = await request<{ readonly default_branch?: unknown }>('GET /repos/{owner}/{repo}', {
      owner,
      repo: name,
    });
    const base = typeof info.data?.default_branch === 'string' ? info.data.default_branch : 'main';
    const created = await request<{ readonly number?: unknown }>('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo: name,
      head,
      base,
      title,
      body,
    });
    return { number: typeof created.data?.number === 'number' ? created.data.number : 0 };
  };
}

/* ── 4. v2 产出分流（FR-5.3） ──────────────────────────────────────────── */

/** 执行 v2 产出时运行时才知道的上下文。 */
export type V21ExecuteContext = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly dryRun: boolean;
  /** issue 当前标签（`label` 目标态的差集依据） */
  readonly currentLabels?: readonly string[] | undefined;
  /** 我们历史上打过的标签（删除时记 owner） */
  readonly botLabels?: readonly string[] | undefined;
};

/** 一次分流的结果。`handled=false` = 不是 v2 产出，调用方回落旧的 4-intent 信封。 */
export type V21Execution = {
  readonly handled: boolean;
  readonly valid: boolean;
  readonly errors: readonly OutputV21Issue[];
  readonly output: OutputV21 | null;
  readonly result: ExecuteV21Result | null;
};

export type V21Executor = (text: string, ctx: V21ExecuteContext) => Promise<V21Execution>;

/**
 * 造一个 v2 执行器：试探解析 → 成功才执行，失败原样交回旧路径。
 *
 * 「整份拒绝」由 `executeV21()` 保证：未知 type / 缺字段 / 开关未开时一条动作都不执行，
 * 错误进 `errors`（调用方写 `envelopes.errors` 与 `run_events`）。
 */
export function createV21Executor(options: {
  readonly write: V21PortSources['write'];
  readonly settings: (repo: string) => Promise<unknown>;
  readonly reactions?: V21PortSources['reactions'];
  readonly openPullRequest?: V21PortSources['openPullRequest'];
  readonly now?: (() => number) | undefined;
}): V21Executor {
  const api = createV21PortFromGithub({
    write: options.write,
    ...(options.reactions === undefined ? {} : { reactions: options.reactions }),
    ...(options.openPullRequest === undefined ? {} : { openPullRequest: options.openPullRequest }),
  });

  return async (text, ctx) => {
    const parsed = parseOutputV21Json(text);
    if (!parsed.ok) {
      return { handled: false, valid: false, errors: parsed.errors, output: null, result: null };
    }
    const rawSettings = await options.settings(ctx.repo);
    const settings = readV21Settings(rawSettings).settings;
    const execution = resolveAgentExecution(rawSettings);
    const switches: V21ActionSwitches = {
      create_issue: execution.actions.create_issue,
      open_pr: execution.actions.open_pr,
      close_issue: execution.actions.close_issue,
    };
    const catalog: readonly CatalogEntry[] = resolveManagedCatalog(rawSettings).map((entry) => ({
      name: entry.name,
      meaning: entry.meaning,
      managed: entry.managed,
      status: entry.status,
    }));
    const result = await executeV21({
      output: parsed.output,
      repo: ctx.repo,
      issueNumber: ctx.issueNumber,
      dryRun: ctx.dryRun,
      actionsEnabled: switches,
      currentLabels: ctx.currentLabels ?? [],
      botLabels: ctx.botLabels ?? [],
      catalog,
      maxPerIssue: settings.labels.max_per_issue,
      api,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const errors: readonly OutputV21Issue[] = result.errors.map((error) => ({
      path: `/actions/${String(error.index)}/${error.type}`,
      message: error.message,
    }));
    return { handled: true, valid: result.ok, errors, output: parsed.output, result };
  };
}

/* ── 5. 压缩留痕（FR-5.6 / AC-25） ─────────────────────────────────────── */

/**
 * 从 RACP 事件里认出 `itemType==='compaction'`。
 *
 * 为什么是「识别事件」而不是「在这里做压缩」：RACP 客户端目前**没有** session/history
 * 与 compact 操作，`packages/racp-client/src/schema.ts` 只在 itemType 枚举里留了
 * `'compaction'`。请求前自动压缩因此还接不上；本层能做的是把 host 报出来的压缩
 * 事件如实落进 `agent_compactions`，不假装已经自动压缩。
 */
export function compactionRecordOf(
  payload: unknown,
  ctx: { readonly repo: string; readonly issueNumber: number; readonly sessionId: string },
): CompactionRecordInput | null {
  const event = asRecord(payload);
  const item = asRecord(event?.['item']) ?? event;
  if (item === null || item['itemType'] !== 'compaction' && event?.['itemType'] !== 'compaction') {
    return null;
  }
  if (ctx.sessionId === '') {
    // `agent_compactions.session_id` 非空：没有会话 id 时宁可不写，也不写一条无法归因的行
    return null;
  }
  const detail = asRecord(item['checkpoint']) ?? item;
  return {
    repo: ctx.repo,
    issueNumber: ctx.issueNumber,
    sessionId: ctx.sessionId,
    generation: num(detail, 'generation'),
    beforeTokens: num(detail, 'beforeTokens'),
    afterTokens: num(detail, 'afterTokens'),
    summaryChars: typeof detail['summary'] === 'string' ? detail['summary'].length : num(detail, 'summaryChars'),
    fallback: detail['fallback'] === true,
  };
}

/** 装配层注入给 `runTask` 的事件钩子类型。 */
export type V21EventHook = (event: {
  readonly kind: string;
  readonly payload: unknown;
  readonly repo: string;
  readonly issueNumber: number;
  readonly sessionId: string;
}) => Promise<void>;

/** 用 `createCompactionStore()` 造事件钩子：命中压缩事件就只追加一行记录。 */
export function createV21CompactionHook(db: SqlRunner): V21EventHook {
  const store = createCompactionStore(db);
  return async (event) => {
    const record = compactionRecordOf(event.payload, {
      repo: event.repo,
      issueNumber: event.issueNumber,
      sessionId: event.sessionId,
    });
    if (record !== null) {
      await store.record(record);
    }
  };
}

/** 暴露给装配层的压缩引擎入口（`createCompactor` 的柯里化形态）。 */
export type V21Compactor = (input: CompactInput) => Promise<CompactResult>;

/** `CompactStore` 的公开别名（装配层用 `createCompactionStore(db)` 提供）。 */
export type V21CompactionStore = CompactStore;

/* ── 6. 会话状态（FR-3.4 / AC-23） ─────────────────────────────────────── */

export const V21_SESSION_SQL = {
  read: `SELECT "state", "sandbox_id", "session_id", "turns", "cursor"
FROM "agent_sessions" WHERE "repo" = $1 AND "issue_number" = $2`,
  /**
   * 只 UPDATE / INSERT，**永远不 DELETE**：
   * issue 随时可能重开，任何归档动作都会让重开的 issue 失去上下文（§6）。
   */
  create: `INSERT INTO "agent_sessions" ("repo", "issue_number", "state", "sandbox_id", "closed_at", "cursor", "turns", "updated_at")
VALUES ($1, $2, $3, $4, NULL, 0, 0, now())
ON CONFLICT ("repo", "issue_number") DO NOTHING`,
  recycle: `UPDATE "agent_sessions"
SET "state" = 'idle', "sandbox_id" = NULL, "closed_at" = now(), "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2`,
  reuse: `UPDATE "agent_sessions"
SET "state" = 'active', "sandbox_id" = COALESCE("sandbox_id", $3), "closed_at" = NULL, "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2`,
} as const;

/** 从库行还原 `planSessionOnEvent()` 要的运行时快照。 */
export function v21SessionRowOf(
  row: Record<string, unknown> | undefined,
  key: { readonly repo: string; readonly issueNumber: number },
): AgentSessionRow | null {
  if (row === undefined) {
    return null;
  }
  const state = str(row, 'state');
  return {
    repo: key.repo,
    issueNumber: key.issueNumber,
    sessionId: str(row, 'session_id'),
    state: state === 'active' ? 'active' : ('idle' as SessionState),
    sandboxId: str(row, 'sandbox_id'),
    turns: num(row, 'turns'),
    cursor: num(row, 'cursor'),
  };
}

/**
 * 一次事件后的会话状态迁移（关闭 → 只回收沙箱；重开/其它事件 → 复用并标 active）。
 *
 * 返回迁移结论供留痕；`keepSession=false`（首次创建）时只 INSERT 一行，不删任何东西。
 */
export async function applyV21SessionOnEvent(
  db: SqlRunner,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly event: SessionEventKey;
    readonly issueState: 'open' | 'closed';
    readonly sandboxId?: string | null | undefined;
  },
): Promise<SessionTransition> {
  const read = await db.query(V21_SESSION_SQL.read, [input.repo, input.issueNumber]);
  const row = read.rows[0] as Record<string, unknown> | undefined;
  const transition = planSessionOnEvent({
    session: v21SessionRowOf(row, { repo: input.repo, issueNumber: input.issueNumber }),
    issueState: input.issueState,
    event: input.event,
  });
  const sandboxId = input.sandboxId ?? null;
  if (transition.action === 'create') {
    await db.query(V21_SESSION_SQL.create, [input.repo, input.issueNumber, transition.state, sandboxId]);
  } else if (transition.action === 'recycle-sandbox') {
    await db.query(V21_SESSION_SQL.recycle, [input.repo, input.issueNumber]);
  } else {
    await db.query(V21_SESSION_SQL.reuse, [input.repo, input.issueNumber, sandboxId]);
  }
  return transition;
}

/* ── 7. v2 独立分支：判定 → 渲染 → 落 agent_messages → 投递 ───────────────── */

/** 一条 v2 消息在库里的定位信息（全部来自 webhook 载荷，不依赖 v0.3 的 plan）。 */
export type V21MessageIdentity = {
  readonly issueNumber: number;
  readonly commentId: number | null;
  readonly actorLogin: string;
  readonly issueUpdatedAt: string;
  readonly targetTitle: string | null;
  readonly targetBody: string | null;
};

/** 从载荷里抽 v2 消息要用的字段。`issue.number` 缺失时给 0（GitHub 编号从 1 起）。 */
export function v21MessageIdentityOf(payload: unknown): V21MessageIdentity {
  const root = asRecord(payload);
  const issue = asRecord(root?.['issue']);
  const comment = asRecord(root?.['comment']);
  const sender = asRecord(root?.['sender']);
  const issueUser = asRecord(issue?.['user']);
  const commentUser = asRecord(comment?.['user']);
  return {
    issueNumber: nullableNum(issue, 'number') ?? 0,
    commentId: nullableNum(comment, 'id'),
    actorLogin:
      str(sender, 'login') ?? str(commentUser, 'login') ?? str(issueUser, 'login') ?? 'unknown',
    issueUpdatedAt: str(issue, 'updated_at') ?? '',
    targetTitle: str(issue, 'title'),
    targetBody: str(issue, 'body'),
  };
}

/** `handleWebhook()` 传给 v2 分支的运行时快照（webhook.ts 只负责拼这份 + 接线）。 */
export type V21WebhookRuntime = {
  readonly deps: V21WebhookDeps;
  readonly logger: Logger;
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly repo: string;
  readonly settings: unknown;
  readonly dryRun: boolean;
  /** 已由 `decideV21Delivery()` 算好的判定（含 PR 的 `pr-ignored`） */
  readonly decision: TriggerDecision;
  /**
   * 本次是否被 v0.3 认成命令通道（`@bot /review-pr`）。
   * 命令任务 `source='command'` 的写回/幂等语义由旧路径负责，v2 分支一律不接管。
   */
  readonly legacyCommand: boolean;
  readonly dispatchAgent?:
    | ((key: { readonly repo: string; readonly issueNumber: number }) => Promise<unknown>)
    | undefined;
  readonly addEyesReaction?:
    | ((input: {
        readonly repo: string;
        readonly issueNumber: number;
        readonly commentId: number | null;
      }) => Promise<void>)
    | undefined;
};

export type V21WebhookOutcome = {
  readonly status: number;
  readonly body: WebhookAcceptedResponse | ErrorBody;
};

function v21Accepted(
  deliveryId: string,
  action: 'ignored' | 'enqueued' | 'duplicate',
  taskId: string | null,
  duplicate: boolean,
): WebhookAcceptedResponse {
  return { status: 'accepted', deliveryId, taskId, duplicate, action, ackComment: null };
}

/**
 * v2.1 的**独立分支**（与 v0.3 `submitAgentMessage()` 平行，不共用组装逻辑）。
 *
 * 返回 `null` = 本次不接管（旧命令通道 / 非 v2 事件），调用方继续跑旧管线；
 * 其余情况一律给出最终应答：
 *  - `pr-ignored` / `switch-off` / `not-mentioned` / `bot-self` … → 200 `ignored`，**不入队**；
 *  - 触发 → `resolveEventTrigger` 选模板 → `renderTemplateAsync` 渲染 → 正文写
 *    `agent_messages.comment_body`（`insertMessage` 的 `body` 参数）→ 即时 dispatch → 回执。
 *
 * 为什么必须独立：v0.3 的 `decideWebhookTask()` 只放行 `opened`/`edited` + `@提及`，
 * `issues.labeled` / `issues.closed` 即使 v2 判定为触发也会被它判 ignore 直接丢掉。
 * 把 v2 结果仅当作「旧消息正文的覆盖」是接不上 FR-2.1 的事件面的。
 */
export async function handleV21Webhook(rt: V21WebhookRuntime): Promise<V21WebhookOutcome | null> {
  if (rt.legacyCommand) {
    return null;
  }
  const { decision } = rt;
  if (!decision.triggered) {
    rt.logger.info(
      { repo: rt.repo, event: decision.event, reason: decision.reason },
      'v2.1 判定未触发：只留痕，不入队',
    );
    return { status: 200, body: v21Accepted(rt.deliveryId, 'ignored', null, false) };
  }

  const eventKey = decision.event;
  const identity = v21MessageIdentityOf(rt.payload);
  if (identity.issueNumber <= 0) {
    rt.logger.warn(
      { repo: rt.repo, event: eventKey, deliveryId: rt.deliveryId },
      'v2.1 载荷缺少 issue.number：按忽略处理',
    );
    return { status: 200, body: v21Accepted(rt.deliveryId, 'ignored', null, false) };
  }

  try {
    const build = await buildV21AgentMessage({
      settings: rt.settings,
      event: eventKey,
      repo: rt.repo,
      eventAction: rt.action ?? '',
      payload: rt.payload,
      deps: rt.deps,
      logger: rt.logger,
      deliveryId: rt.deliveryId,
      // `decideEvent()` 已把项目 prompt（空白则回落到内置默认）解析成 template，直接用
      decidedTemplate: decision.template,
    });
    const key = {
      repo: rt.repo,
      issueNumber: identity.issueNumber,
      // 事件消息豁免永久幂等：key 含事件键 + issue.updated_at（同一版内容只跑一轮）
      fingerprint: eventFingerprint({
        repo: rt.repo,
        issueNumber: identity.issueNumber,
        templateId: eventKey,
        issueUpdatedAt: identity.issueUpdatedAt,
      }),
    };
    const saved = await insertMessage(rt.deps.db, {
      key,
      kind: 'event',
      commentId: identity.commentId,
      // ★ 渲染结果作为本轮发给 agent 的消息正文（落 agent_messages.comment_body）
      body: build.text,
      actorLogin: identity.actorLogin,
      skillIds: build.skillIds,
    });
    if (!saved.inserted) {
      const existing = await findTaskIdByKey(rt.deps.db, agentTaskIdempotencyKey(key)).catch(
        () => null,
      );
      rt.logger.info({ repo: rt.repo, issue: identity.issueNumber }, 'v2.1 消息幂等命中：不重复投递');
      return { status: 200, body: v21Accepted(rt.deliveryId, 'duplicate', existing, true) };
    }

    // 立刻为这个 issue 领一条（cron 只是兜底）；失败只 warn，不影响 200。
    if (rt.dispatchAgent !== undefined) {
      try {
        await rt.dispatchAgent({ repo: rt.repo, issueNumber: identity.issueNumber });
      } catch (error) {
        rt.logger.warn({ err: describeError(error) }, 'v2.1 agent 即时投递失败（留给兜底）');
      }
    }
    const taskId = await findTaskIdByKey(rt.deps.db, agentTaskIdempotencyKey(key)).catch(() => null);

    // dry-run 一个 GitHub 写动作都不发（与旧路径同一口径）。
    if (!rt.dryRun && rt.addEyesReaction !== undefined) {
      try {
        await rt.addEyesReaction({
          repo: rt.repo,
          issueNumber: identity.issueNumber,
          commentId: identity.commentId,
        });
      } catch (error) {
        rt.logger.warn({ err: describeError(error) }, 'v2.1 回执打 eyes 失败（不影响 200）');
      }
    }
    return { status: 200, body: v21Accepted(rt.deliveryId, 'enqueued', taskId, false) };
  } catch (error) {
    rt.logger.error(
      { repo: rt.repo, event: eventKey, err: describeError(error) },
      'v2.1 agent 消息落库失败',
    );
    return {
      status: 500,
      body: errorBodyOf('internal', 'v2.1 agent 消息落库失败'),
    };
  }
}
