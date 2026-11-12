/**
 * `reconcile`：「自动执行后被人改回」的对账作业（tech-plan §7.5 第 4 条）。
 *
 * 为什么要这个作业：webhook 会丢，这是常识。§7.5 的三个反向事件
 * （`issues.unlabeled` / 人工 `request_changes` / `pull_request.closed` 且未合并）走的是投递通道，
 * 一旦漏投，`actions.reverted_at` 就永远不置位，面板的「改回率」会**系统性偏低**——
 * 而这是取消阈值后唯一能验证「它是否可信」的质量信号，偏低的代价比多花几次 GET 大得多。
 * 于是每小时用 `GithubClient` 重查最近 7 天已应用 actions 的现状，自己判自己。
 *
 * 判定规则（与 §7.5 第 2 条逐个对应，**顺序有意义**）：
 *  1. `label-removed`：`intent='label'` 的 action，它打的那个标签已经不在 issue/PR 上了；
 *  2. `pr-closed`：目标是 PR，且 `state='closed'` 而 `merged=false`（合并了就不算改回）；
 *  3. `changes-requested`：PR 上有**人**（`user.type !== 'Bot'`）在写操作之后提交过 `CHANGES_REQUESTED`。
 *
 * 四条实现取舍：
 *  - **已置位的不重复处理**：SQL 里 `reverted_at is null and revert_kind is null` 过滤，
 *    update 语句再带一次同样的条件（并发跑两份 reconcile 也不会互相覆盖）。
 *  - **不依赖 webhook**：全程只读 GitHub 现状 + 写 `actions`，与投递通道完全解耦。
 *  - **标签身份从哪来**：`actions` 表没有 label 名字段。优先用 `external_ref`（写执行器时代填），
 *    没有就回落到 `bot_labels` 里该 (repo, issue) 上最近一条 `applied_at <= action.applied_at` 的记录。
 *    两者都没有 → 记为 skipped（宁可少判一条，也不要瞎猜一个标签名去比）。
 *  - **只有 GitHub 调用失败才记 skipped**：解析/取数的程序错误直接抛出去，
 *    否则一个列名写错会被伪装成「这一条无法判定」，质量指标会静默失准。
 */
import type { GithubClient, RepoRef } from '../github/index.ts';
import { splitRepo } from '../github/index.ts';
import type { JobLogger, JobPool, JobResult } from './types.ts';
import { finishJob, JOB_NULL_LOGGER, rowCountOf, systemClock } from './types.ts';

/** 反向事件窗口：写操作后 7 天（§7.5 第 3 条）。 */
export const RECONCILE_WINDOW_DAYS = 7;

/** 单次对账最多处理多少条 action（每小时一轮，超出的下一轮继续）。 */
export const RECONCILE_BATCH_LIMIT = 500;

/** 三类改回（§7.5 第 3 条列的三种 `revert_kind`）。 */
export const REVERT_KINDS = ['label-removed', 'changes-requested', 'pr-closed'] as const;

export type RevertKind = (typeof REVERT_KINDS)[number];

/**
 * 候选查询（列名保持 snake_case，读回来由 `toCandidate()` 一次性转成 camelCase）。
 * `limit` 走参数而不是拼字符串（`$3::int`）。
 */
const CANDIDATE_SQL = `
select
  a.id::text as id,
  a.run_id as run_id,
  a.intent as intent,
  a.target as target,
  a.external_ref as external_ref,
  a.applied_at as applied_at
from actions a
where a.applied_at is not null
  and a.reverted_at is null
  and a.revert_kind is null
  and a.applied_at >= $1::timestamptz
  and a.applied_at <= $2::timestamptz
order by a.applied_at asc, a.id asc
limit $3::int
`;

/** 置位改回。`and reverted_at is null` 是幂等的第二道闸（第一道在候选查询里）。 */
const MARK_REVERTED_SQL = `
update actions
   set reverted_at = $2::timestamptz,
       revert_kind = $3,
       audit = coalesce(audit, '{}'::jsonb) || $4::jsonb
 where id = $1::bigint
   and reverted_at is null
`;

const LABEL_SQL = `
select label
  from bot_labels
 where repo = $1
   and issue_number = $2
   and applied_at <= $3::timestamptz
 order by applied_at desc
 limit 1
`;

export type ReconcileRevertsDeps = {
  readonly pool: JobPool;
  /** 只用到 `request`：对账全是读，不新增写操作（dry-run 也不会产生副作用）。 */
  readonly github: Pick<GithubClient, 'request'>;
  readonly clock?: () => number;
  readonly logger?: JobLogger;
};

export type ReconcileRevertsOptions = {
  /** 反向事件窗口（天），默认 7。 */
  readonly windowDays?: number;
  /** 单轮上限，默认 500。 */
  readonly limit?: number;
  /** 只看不写（排查用）：命中的条目会被报告但不落库。 */
  readonly dryRun?: boolean;
};

export type ReconcileRevertsStats = {
  /** 完成现状重查的 action 数（含重查后没发现改回的）。 */
  readonly checked: number;
  /** 本次置位的 action 数。 */
  readonly reverted: number;
  /** 无法判定而放弃的 action 数（target 不可解析 / 标签身份未知 / 重查失败）。 */
  readonly skipped: number;
  /** 按 `revert_kind` 拆的置位计数。 */
  readonly byKind: Readonly<Record<string, number>>;
  readonly windowDays: number;
};

/** 候选 action（行是 snake_case，`toCandidate()` 转成 camelCase）。 */
export type ReconcileCandidate = {
  readonly id: string;
  readonly runId: string;
  readonly intent: string;
  readonly target: string;
  readonly externalRef: string | null;
  readonly appliedAt: Date;
};

/** `owner/name#123` → 仓库 + 号。解析不了返回 null（`push_branch` 的 target 形如 `owner/name#branch`）。 */
export function parseActionTarget(target: string): { repo: string; number: number } | null {
  const matched = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(target);
  if (matched === null) {
    return null;
  }
  const repo = matched[1];
  const rawNumber = matched[2];
  if (repo === undefined || rawNumber === undefined) {
    return null;
  }
  const number = Number(rawNumber);
  return Number.isInteger(number) && number > 0 ? { repo, number } : null;
}

type IssueSnapshot = {
  readonly state?: string;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly pull_request?: unknown;
};

type PullSnapshot = {
  readonly state?: string;
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly closed_at?: string | null;
};

type ReviewSnapshot = {
  readonly state?: string;
  readonly submitted_at?: string;
  readonly user?: { readonly login?: string; readonly type?: string };
};

type Detection = { readonly kind: RevertKind; readonly evidence: Record<string, unknown> };

/** 一次判定的结果（`checked` 与 `skipped` 互斥，便于统计）。 */
type ActionVerdict =
  | { readonly status: 'checked'; readonly revert?: Detection }
  | { readonly status: 'skipped'; readonly reason: string };

/** `pg` 回来的行 → camelCase 候选（这一步是唯一的列名契约点）。 */
function toCandidate(row: Record<string, unknown>): ReconcileCandidate {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    intent: String(row['intent']),
    target: String(row['target']),
    externalRef: row['external_ref'] === null || row['external_ref'] === undefined ? null : String(row['external_ref']),
    appliedAt: row['applied_at'] instanceof Date ? row['applied_at'] : new Date(String(row['applied_at'])),
  };
}

function labelNamesOf(snapshot: IssueSnapshot): string[] {
  const labels = snapshot.labels ?? [];
  return labels
    .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
    .filter((name) => name !== '');
}

function isPullRequest(snapshot: IssueSnapshot): boolean {
  return snapshot.pull_request !== undefined && snapshot.pull_request !== null;
}

export async function reconcileReverts(
  deps: ReconcileRevertsDeps,
  options: ReconcileRevertsOptions = {},
): Promise<JobResult<ReconcileRevertsStats>> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? JOB_NULL_LOGGER;
  const startedAt = clock();
  const windowDays = options.windowDays ?? RECONCILE_WINDOW_DAYS;
  const limit = options.limit ?? RECONCILE_BATCH_LIMIT;

  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error(`reconcile：windowDays 必须是正整数，收到 ${String(windowDays)}`);
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`reconcile：limit 必须是正整数，收到 ${String(limit)}`);
  }

  const fromIso = new Date(startedAt - windowDays * 86_400_000).toISOString();
  const toIso = new Date(startedAt).toISOString();
  const candidates = (
    await deps.pool.query(CANDIDATE_SQL, [fromIso, toIso, limit])
  ).rows.map((row) => toCandidate(row as Record<string, unknown>));

  let checked = 0;
  let reverted = 0;
  let skipped = 0;
  const byKind: Record<string, number> = {};

  for (const candidate of candidates) {
    const verdict = await inspectCandidate(deps, candidate);
    if (verdict.status === 'skipped') {
      skipped += 1;
      logger.warn(
        { job: 'reconcile', actionId: candidate.id, target: candidate.target, reason: verdict.reason },
        '改回对账：这一条无法判定，跳过（不置位）',
      );
      continue;
    }

    checked += 1;
    const revert = verdict.revert;
    if (revert === undefined) {
      continue;
    }

    const { kind, evidence } = revert;
    if (options.dryRun === true) {
      logger.info(
        { job: 'reconcile', actionId: candidate.id, target: candidate.target, revertKind: kind, dryRun: true },
        '改回对账：dry-run 命中改回，不写库',
      );
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      continue;
    }

    const audit = { reconcile: { revertKind: kind, detectedAt: toIso, evidence } };
    const changed = rowCountOf(
      await deps.pool.query(MARK_REVERTED_SQL, [candidate.id, toIso, kind, JSON.stringify(audit)]),
    );
    if (changed === 0) {
      // 期间被 webhook 路径抢先置位：不算失败，也不算本次置位
      logger.info(
        { job: 'reconcile', actionId: candidate.id, target: candidate.target, revertKind: kind },
        '改回对账：已被其它路径置位，本次跳过',
      );
      continue;
    }
    reverted += 1;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    logger.info(
      {
        job: 'reconcile',
        actionId: candidate.id,
        intent: candidate.intent,
        target: candidate.target,
        revertKind: kind,
      },
      '改回对账：置位成功',
    );
  }

  logger.info(
    { job: 'reconcile', checked, reverted, skipped, windowDays, candidates: candidates.length },
    '改回对账完成',
  );

  return finishJob('reconcile-reverts', startedAt, clock, { checked, reverted, skipped, byKind, windowDays }, []);
}

/** 单条 action：重查现状 → 判定是否被改回（三条规则的顺序见文件头）。 */
async function inspectCandidate(deps: ReconcileRevertsDeps, candidate: ReconcileCandidate): Promise<ActionVerdict> {
  const parsed = parseActionTarget(candidate.target);
  if (parsed === null) {
    return { status: 'skipped', reason: 'target 不是 owner/name#<号> 形态（例如 push_branch 的分支目标）' };
  }

  let repoRef: RepoRef;
  try {
    repoRef = splitRepo(parsed.repo);
  } catch {
    return { status: 'skipped', reason: `target 里的仓库标识不合法：${parsed.repo}` };
  }

  const base = `repos/${repoRef.owner}/${repoRef.repo}`;
  const issueResult = await fetchOnce<IssueSnapshot>(deps, `GET /${base}/issues/${String(parsed.number)}`);
  if (!issueResult.ok) {
    return { status: 'skipped', reason: issueResult.reason };
  }
  const issue = issueResult.data;

  if (candidate.intent === 'label') {
    const labelName = await resolveLabelName(deps, candidate, parsed);
    if (labelName === null) {
      return { status: 'skipped', reason: 'label action 找不到标签名（external_ref 与 bot_labels 都没记录）' };
    }
    // 规则 1：标签被摘掉（最有信息量，先判）
    const currentLabels = labelNamesOf(issue);
    if (!currentLabels.includes(labelName)) {
      return {
        status: 'checked',
        revert: { kind: 'label-removed', evidence: { label: labelName, currentLabels } },
      };
    }
  }

  if (!isPullRequest(issue)) {
    return { status: 'checked' };
  }

  const pullResult = await fetchOnce<PullSnapshot>(deps, `GET /${base}/pulls/${String(parsed.number)}`);
  if (!pullResult.ok) {
    return { status: 'skipped', reason: pullResult.reason };
  }
  const pull = pullResult.data;

  // 规则 2：PR 被关且未合并（合并是「采纳」，不是改回）
  if (pull.merged !== true && pull.state === 'closed') {
    return {
      status: 'checked',
      revert: {
        kind: 'pr-closed',
        evidence: { state: pull.state, merged: pull.merged ?? false, closedAt: pull.closed_at ?? null },
      },
    };
  }

  // 规则 3：人提交了 changes-requested（机器人的 review 不算「被人改回」）
  const reviewsResult = await fetchOnce<readonly ReviewSnapshot[]>(deps, `GET /${base}/pulls/${String(parsed.number)}/reviews`);
  if (!reviewsResult.ok) {
    return { status: 'skipped', reason: reviewsResult.reason };
  }
  const appliedAtMs = candidate.appliedAt.getTime();
  const humanChange = (reviewsResult.data ?? []).find((review) => {
    if (review.state !== 'CHANGES_REQUESTED') {
      return false;
    }
    if (review.user?.type === 'Bot') {
      return false;
    }
    const submittedAt = review.submitted_at === undefined ? Number.NaN : Date.parse(review.submitted_at);
    // 时间拿不到就按「算数」处理：宁可多记一次改回，也别漏掉质量信号
    return Number.isNaN(submittedAt) ? true : submittedAt >= appliedAtMs;
  });
  if (humanChange !== undefined) {
    return {
      status: 'checked',
      revert: {
        kind: 'changes-requested',
        evidence: { reviewer: humanChange.user?.login ?? null, submittedAt: humanChange.submitted_at ?? null },
      },
    };
  }

  return { status: 'checked' };
}

type FetchResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly reason: string };

/** 只把「GitHub 调用失败」归一成 skipped；解析层面的程序错误照样抛（见文件头第 4 条）。 */
async function fetchOnce<T>(deps: ReconcileRevertsDeps, route: string): Promise<FetchResult<T>> {
  try {
    const response = await deps.github.request<T>(route);
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, reason: `重查现状失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 标签身份：优先 `external_ref`（写执行器记录的标签名），其次 `bot_labels` 的时间邻近记录。 */
async function resolveLabelName(
  deps: ReconcileRevertsDeps,
  candidate: ReconcileCandidate,
  parsed: { repo: string; number: number },
): Promise<string | null> {
  if (candidate.externalRef !== null && candidate.externalRef.trim() !== '') {
    return candidate.externalRef;
  }
  const rows = (
    await deps.pool.query(LABEL_SQL, [parsed.repo, parsed.number, candidate.appliedAt.toISOString()])
  ).rows as { label: string }[];
  return rows[0]?.label ?? null;
}
