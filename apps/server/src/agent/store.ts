/**
 * `agent_messages` / `agent_sessions` / `tasks` 的读写面（S1 的存储层）。
 *
 * 三条设计要点：
 *  1. **`agent_messages` 就是队列**（需求 §1.2 / dev-plan §2.1）：`status` 取
 *     `queued | running | done | failed`，`(repo, issue_number, status, created_at)` 上有索引；
 *     没有第二套内存队列，也没有 pg-boss 的排队语义（它的 `singletonKey` 会把第二条消息
 *     **丢掉**，见 `queue/boss.ts` 的注释）；
 *  2. **取件必须原子**：`claimNextForIssue()` 用一条 `UPDATE … WHERE (…) IN (SELECT … FOR UPDATE
 *     SKIP LOCKED LIMIT 1)` 把「选中 + 置 `running`」放进同一个语句。分成 SELECT 再 UPDATE 的话，
 *     两条语句各自是隐式事务，锁立刻释放，两个 dispatcher 会同时领到同一条；
 *  3. **幂等只在数据库**：`INSERT … ON CONFLICT DO NOTHING RETURNING` 决定「这条消息是不是新的」，
 *     `tasks.idempotency_key` 的唯一索引决定「这个任务是不是新的」。
 */
import { AGENT_COMMAND_PREFIX, AGENT_TASK_ACTOR } from './constants.ts';
import type { AgentMessageKind, AgentMessageStatus } from './constants.ts';
import type { SqlRunner } from '../config/repo-config.ts';

/** 一条 agent 消息（`agent_messages` 的一行）。 */
export type AgentMessageRow = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly fingerprint: string;
  readonly kind: AgentMessageKind;
  readonly status: AgentMessageStatus;
  readonly commentId: number | null;
  /** agent 真正看到的那条用户消息（人消息 = 摘过别名的原话，事件消息 = 模板渲染结果） */
  readonly body: string | null;
  /** 触发人 login（人消息 = 评论作者，事件消息 = issue 作者）；老行为 `null`。 */
  readonly actorLogin: string | null;
  /** 这条消息点名的技能 id（不带前导 `/`）：正文里的 `/name` 已被摘掉，只能靠它传递。 */
  readonly skillIds: readonly string[];
  readonly createdAt: Date;
};

/** 消息的定位键（= `agent_messages` 的主键）。 */
export type AgentMessageKey = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly fingerprint: string;
};

/** `agent_sessions` 的一行（会话状态的**唯一**来源）。 */
export type AgentSessionRow = {
  readonly sessionId: string | null;
  readonly cursor: number;
  readonly turns: number;
  readonly startedAt: Date | null;
};

/**
 * 会话域（BR-5「issue 与 PR 各自独立会话，上下文不互通」）。
 *
 * 为什么必须落库、且必须是主键的一部分：GitHub 的 PR 编号与 issue 编号**同属一个序列**，
 * 同一仓库里 PR #7 与 issue #7 是两件不同的事。旧主键只有 `(repo, issue_number)`，
 * 所以 PR 上的评论会写进 issue 的会话行 —— 上下文互相污染，且 issue 关单回收沙箱时
 * 顺手把 PR 的会话也标成 `idle`。
 */
export const AGENT_SESSION_DOMAINS = ['issue', 'pr'] as const;

export type AgentSessionDomain = (typeof AGENT_SESSION_DOMAINS)[number];

/**
 * 会话的定位键（= `agent_sessions` 的主键 `(repo, domain, issue_number)`）。
 *
 * `issueNumber` 对 PR 也是「编号」：列名保留 `issue_number` 是刻意的取舍 ——
 * 改名会牵动 `queries/**`、面板与历史迁移，而语义靠 `domain` 一列已经完整表达。
 */
export type AgentSessionKey = {
  readonly repo: string;
  readonly domain: AgentSessionDomain;
  readonly issueNumber: number;
};

/** 任务级幂等键前缀（与 `tasks.command` 的 `agent:` 前缀刻意区分开）。 */
export const AGENT_TASK_KEY_PREFIX = 'agent:message:';

/** 一条消息对应的 `tasks.idempotency_key`。 */
export function agentTaskIdempotencyKey(key: AgentMessageKey): string {
  return `${AGENT_TASK_KEY_PREFIX}${key.repo}#${String(key.issueNumber)}:${key.fingerprint}`;
}

/**
 * 反解：任务行 → 它处理的是哪条消息。
 *
 * 为什么用 `idempotency_key` 当连接键：`tasks` 没有 `agent_message` 外键（0000 的表结构在
 * S0 就冻结了），而 `idempotency_key` 是唯一索引 + 我们自己拼的字符串，天然一对一。
 */
export function parseAgentTaskIdempotencyKey(input: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly idempotencyKey: string | null | undefined;
}): AgentMessageKey | null {
  const value = input.idempotencyKey ?? '';
  if (!value.startsWith(AGENT_TASK_KEY_PREFIX)) {
    return null;
  }
  const rest = value.slice(AGENT_TASK_KEY_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) {
    return null;
  }
  const target = rest.slice(0, at);
  const fingerprint = rest.slice(at + 1);
  const expected = `${input.repo}#${String(input.issueNumber)}`;
  if (target !== expected || fingerprint === '') {
    return null;
  }
  return { repo: input.repo, issueNumber: input.issueNumber, fingerprint };
}

/** dispatcher 建的 agent 任务落 `tasks.command` 的值（`agent:mention` / `agent:event`）。 */
export function agentTaskCommand(kind: AgentMessageKind): string {
  return `${AGENT_COMMAND_PREFIX}${kind}`;
}

export const AGENT_SQL = {
  /**
   * 幂等落库：返回行 = 「这条消息现在该被处理一次」；0 行 = 已经有同一 (repo, issue, fingerprint)
   * 且它还在排队/在处理/已成功，属于真重复。
   *
   * 为什么要 `DO UPDATE`：需求 §P0「上次失败不参与去重」——上一轮是超时、崩溃或未产出时，
   * 同内容再来一次必须视为**重试**放行，否则一次故障就把这条内容永久锁死（主键占住 + `DO NOTHING`）。
   * `WHERE status = 'failed'` 是这条规则的边界：`queued` / `running` / `done` 一律不动，
   * 保持「同一句话只处理一次」的幂等（L-01 / R-02）。
   *
   * 并发上只让一个重投放行：`DO UPDATE` 会先锁住冲突行再按**最新版本**重算 `WHERE`，
   * 抢输的那条看到 `status='queued'` 就不再更新，返回 0 行 → 上层仍判 duplicate。
   * `created_at` 不改：重试保留它在队列里的原始位置（`claimOldest` 按 `created_at` 排序）。
   */
  insertMessage: `INSERT INTO "agent_messages" ("repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "actor_login", "skill_ids", "created_at", "updated_at")
VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7, $8::jsonb, now(), now())
ON CONFLICT ("repo", "issue_number", "fingerprint") DO UPDATE
SET "status" = 'queued', "updated_at" = now()
WHERE "agent_messages"."status" = 'failed'
RETURNING "created_at"`,
  readMessage: `SELECT "repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "actor_login", "skill_ids", "created_at"
FROM "agent_messages"
WHERE "repo" = $1 AND "issue_number" = $2 AND "fingerprint" = $3`,
  /**
   * 有待处理消息的 issue 列表：**排除已经有 `running` 的 issue**（一个 issue 同时只跑一条），
   * 按「最老的一条 queued」排序，于是先来的 issue 先被领。
   */
  queuedIssues: `SELECT m."repo", m."issue_number"
FROM "agent_messages" m
WHERE m."status" = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM "agent_messages" r
    WHERE r."repo" = m."repo" AND r."issue_number" = m."issue_number" AND r."status" = 'running'
  )
GROUP BY m."repo", m."issue_number"
ORDER BY MIN(m."created_at") ASC, m."repo" ASC, m."issue_number" ASC
LIMIT $1`,
  /**
   * 领一条：选中该 issue **最老**的 queued 并置 `running`（同一语句，`FOR UPDATE SKIP LOCKED`
   * 保证并发 dispatcher 不会领到同一条）。
   *
   * 额外的 `NOT EXISTS (running)` 是串行的第二道闸：这个 issue 已经有一条在跑时不再领新的
   * （「一个 issue 一个 agent，串行」）。两个 dispatcher 真同时进这条语句的窗口只能靠
   * `queue.agentDispatch` 的 concurrency=1 收住（见 `dispatcher.ts` 的注释）。
   */
  claimOldest: `UPDATE "agent_messages"
SET "status" = 'running', "updated_at" = now()
WHERE ("repo", "issue_number", "fingerprint") IN (
  SELECT "repo", "issue_number", "fingerprint"
  FROM "agent_messages"
  WHERE "repo" = $1 AND "issue_number" = $2 AND "status" = 'queued'
  ORDER BY "created_at" ASC, "fingerprint" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
  AND NOT EXISTS (
    SELECT 1 FROM "agent_messages" running
    WHERE running."repo" = $1 AND running."issue_number" = $2 AND running."status" = 'running'
      AND running."fingerprint" <> "agent_messages"."fingerprint"
  )
RETURNING "repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "actor_login", "created_at"`,
  markStatus: `UPDATE "agent_messages"
SET "status" = $4, "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2 AND "fingerprint" = $3`,
  /** 这个 issue 还有几条没处理（`running` + `queued`）。 */
  countPending: `SELECT COUNT(*)::int AS "n" FROM "agent_messages"
WHERE "repo" = $1 AND "issue_number" = $2 AND "status" IN ('queued', 'running')`,
  /**
   * dispatcher 建任务：`source='agent'`，幂等键按消息算。
   *
   * 冲突时保持 `DO NOTHING`（**P0-2 复核后回退**）：`insertAgentTask()` 在 0 行时会用
   * `findTaskIdByKey()` 把上一轮那条任务的 id 回填出来，dispatcher 拿到**非 null** 的 taskId
   * 照常 `enqueue`，而 `queue.send` 的 `singletonKey` 是消息粒度的
   * （`agent:<repo>#<n>:<fingerprint>`），上一轮的 job 已经结束 —— 所以「重跑同一 task 行」
   * 本来就是通的。此前一度改成 `DO UPDATE SET status='queued'`，那是多余改动：
   * 它把 `tasks` 的终态语义改了（还会引入 `ended_at` 与排队闸门的不一致），
   * 而 `tasks` 的入队字段与状态机由 AGENTS §7.4 / §9 约束，不该被去重逻辑顺手改写。
   */
  insertTask: `INSERT INTO "tasks" ("id", "source", "repo", "target_kind", "target_number", "head_sha", "command", "actor_login", "queued_at", "idempotency_key", "status", "delivery_id", "prompt_text", "agent_skill_ids")
VALUES ($1, 'agent', $2, 'issue', $3, NULL, $4, $5, now(), $6, 'queued', NULL, $7, $8::jsonb)
ON CONFLICT ("idempotency_key") DO NOTHING
RETURNING "id"`,
  findTaskByIdempotencyKey: `SELECT "id" FROM "tasks" WHERE "idempotency_key" = $1`,
  /**
   * 读会话行：**三段键**（仓库 + 域 + 编号）。少一段就会把 PR 的会话读成 issue 的。
   */
  loadSession: `SELECT "session_id", "cursor", "turns", "started_at"
FROM "agent_sessions"
WHERE "repo" = $1 AND "domain" = $2 AND "issue_number" = $3`,
  /** 一个（issue, 域）一行：UPSERT。`turns` 由调用方算（轮换那一轮从 1 起）。 */
  saveSession: `INSERT INTO "agent_sessions" ("repo", "domain", "issue_number", "session_id", "cursor", "turns", "started_at", "updated_at")
VALUES ($1, $2, $3, $4, $5, $6, $7, now())
ON CONFLICT ("repo", "domain", "issue_number") DO UPDATE SET
  "session_id" = excluded."session_id",
  "cursor" = excluded."cursor",
  "turns" = excluded."turns",
  "started_at" = excluded."started_at",
  "updated_at" = now()`,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function messageRowOf(raw: unknown): AgentMessageRow | null {
  const row = asRecord(raw);
  if (row === null) {
    return null;
  }
  const repo = row['repo'];
  const fingerprint = row['fingerprint'];
  if (typeof repo !== 'string' || typeof fingerprint !== 'string') {
    return null;
  }
  const commentId = row['comment_id'];
  return {
    repo,
    issueNumber: numberOf(row['issue_number'], 0),
    fingerprint,
    kind: (row['kind'] === 'event' ? 'event' : 'mention') satisfies AgentMessageKind,
    status: String(row['status'] ?? 'queued') as AgentMessageStatus,
    commentId: typeof commentId === 'number' ? commentId : null,
    body: typeof row['comment_body'] === 'string' ? row['comment_body'] : null,
    actorLogin: typeof row['actor_login'] === 'string' ? row['actor_login'] : null,
    skillIds: toStringArray(row['skill_ids']),
    createdAt: row['created_at'] instanceof Date ? row['created_at'] : new Date(0),
  };
}

/**
 * 落一条消息（幂等）。
 * `inserted=false` 就是「同一句话已经来过且还没失败」：调用方直接返回 `duplicate`，不建任务、不调模型
 * （L-01 / R-02）。`inserted=true` 包含两种情况：真的新插入，或者既有行是 `failed`
 * 被这次重投重置成 `queued`（需求「上次失败不参与去重」——超时/崩溃后同内容再来得放行）。
 * `row` 是库里那一行（保留 `created_at` 原值，重试沿用原始排队位置）。
 */
export async function insertMessage(
  db: SqlRunner,
  input: {
    readonly key: AgentMessageKey;
    readonly kind: AgentMessageKind;
    readonly commentId?: number | null;
    readonly body: string;
    /** 触发人 login（人消息 = 评论作者，事件消息 = issue 作者）；老调用点可以不传。 */
    readonly actorLogin?: string | null;
    /** 点名的技能 id（不带前导 /）；与 	asks.agent_skill_ids 同源。 */
    readonly skillIds?: readonly string[];
  },
): Promise<{ readonly inserted: boolean; readonly row: AgentMessageRow | null }> {
  const result = await db.query(AGENT_SQL.insertMessage, [
    input.key.repo,
    input.key.issueNumber,
    input.key.fingerprint,
    input.kind,
    input.commentId ?? null,
    input.body,
    input.actorLogin ?? null,
    JSON.stringify(input.skillIds ?? []),
  ]);
  // `DO UPDATE … WHERE status='failed'` 命中时 `RETURNING` 也会出行，所以 >0 就代表「该处理一次」。
  const inserted = (result.rowCount ?? result.rows.length) > 0;
  const existing = await readMessage(db, input.key);
  return { inserted, row: existing };
}

/** 读一条消息（不存在 → `null`）。 */
export async function readMessage(db: SqlRunner, key: AgentMessageKey): Promise<AgentMessageRow | null> {
  const result = await db.query(AGENT_SQL.readMessage, [key.repo, key.issueNumber, key.fingerprint]);
  return messageRowOf(result.rows[0]);
}

/** 有排队的 issue（`limit` 条，最老的先）。 */
export async function listQueuedIssueKeys(
  db: SqlRunner,
  limit: number,
): Promise<readonly { readonly repo: string; readonly issueNumber: number }[]> {
  const result = await db.query(AGENT_SQL.queuedIssues, [limit]);
  const keys: Array<{ repo: string; issueNumber: number }> = [];
  for (const raw of result.rows) {
    const row = asRecord(raw);
    const repo = row?.['repo'];
    if (typeof repo !== 'string') {
      continue;
    }
    keys.push({ repo, issueNumber: numberOf(row?.['issue_number'], 0) });
  }
  return keys;
}

/**
 * 领这个 issue 最老的一条 queued 并置 `running`。没有可领的 → `null`。
 *
 * 已有一条 `running` 时**也返回 `null`**（`SELECT` 里没有排除它，但调用方应先用
 * `listQueuedIssueKeys` 过滤；这里再判一次，防两个 dispatcher 交叉）。
 */
export async function claimNextForIssue(
  db: SqlRunner,
  key: { readonly repo: string; readonly issueNumber: number },
): Promise<AgentMessageRow | null> {
  const result = await db.query(AGENT_SQL.claimOldest, [key.repo, key.issueNumber]);
  return messageRowOf(result.rows[0]);
}

/** 改状态（`done` / `failed` / `queued` 回滚用）。返回是否真的改到了行。 */
export async function markMessage(
  db: SqlRunner,
  key: AgentMessageKey,
  status: AgentMessageStatus,
): Promise<boolean> {
  const result = await db.query(AGENT_SQL.markStatus, [
    key.repo,
    key.issueNumber,
    key.fingerprint,
    status,
  ]);
  return (result.rowCount ?? result.rows.length) > 0;
}

/** 这个 issue 还有几条没处理（面板/调度用）。 */
export async function countPending(db: SqlRunner, key: { repo: string; issueNumber: number }): Promise<number> {
  const result = await db.query(AGENT_SQL.countPending, [key.repo, key.issueNumber]);
  return numberOf(asRecord(result.rows[0])?.['n'], 0);
}

/**
 * 建一条 agent 任务（`source='agent'`）。
 *
 * 返回 `{taskId}`：`taskId=null` 表示建任务失败且按幂等键也查不到行（异常情况）；
 * `taskId` 非 null 表示「该入队这个 id」——
 *  - 全新插入 → 返回 `input.taskId`；
 *  - `idempotency_key` 命中（同一消息已经有任务行）→ 返回**那一行既有的 id**。
 *
 * 为什么命中也要返回 id：P0-2「上次失败不参与去重」。消息被 `insertMessage` 重置成
 * `queued` 后，它上一轮的任务行还占着幂等键；这里把旧 id 交给 dispatcher，dispatcher 照常
 * `enqueue`（`queue.send` 的 `singletonKey` 是消息粒度，上一轮 job 已结束，能重投），
 * `run-task` 按 taskId 直接跑，于是同内容真的重试了一次。
 */
export async function insertAgentTask(
  db: SqlRunner,
  input: {
    readonly taskId: string;
    readonly key: AgentMessageKey;
    readonly kind: AgentMessageKind;
    readonly body: string;
    /** 触发人 login：写进 `tasks.actor_login`，回复靠它加 `@login`（缺省回落 `AGENT_TASK_ACTOR`）。 */
    readonly actorLogin?: string | null;
    /**
     * 这条消息**点名**的技能 id（不带前导 `/`）。
     *
     * 必须由消息组装侧显式传下来：`@bot /label-triage` 里的 token 在组装时已被摘掉，
     * 装配层再从正文里找只会永远找不到（issue #26）。
     */
    readonly skillIds?: readonly string[];
  },
): Promise<{ readonly taskId: string | null }> {
  const idempotencyKey = agentTaskIdempotencyKey(input.key);
  const result = await db.query(AGENT_SQL.insertTask, [
    input.taskId,
    input.key.repo,
    input.key.issueNumber,
    agentTaskCommand(input.kind),
    input.actorLogin ?? AGENT_TASK_ACTOR,
    idempotencyKey,
    input.body,
    JSON.stringify(input.skillIds ?? []),
  ]);
  // 先看 `RETURNING`（新插入）；0 行说明幂等键命中，再把既有 id 查回来交给调用方入队。
  const returnedId = asRecord(result.rows[0])?.['id'];
  if (typeof returnedId === 'string') {
    return { taskId: returnedId };
  }
  const existing = await findTaskIdByKey(db, idempotencyKey);
  return { taskId: existing };
}

/** `jsonb` 字符串数组 → `string[]`（宽松：非数组/坏元素一律丢弃，不抛）。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '') out.push(item);
  }
  return out;
}

/** 按幂等键查已有任务 id（幂等命中时用来回填响应体的 `taskId`）。 */
export async function findTaskIdByKey(db: SqlRunner, idempotencyKey: string): Promise<string | null> {
  const result = await db.query(AGENT_SQL.findTaskByIdempotencyKey, [idempotencyKey]);
  const id = asRecord(result.rows[0])?.['id'];
  return typeof id === 'string' ? id : null;
}

/** 读会话行（没有 → `null` = 还没开过会话）。`key` 必须带 `domain`（BR-5）。 */
export async function loadSession(
  db: SqlRunner,
  key: AgentSessionKey,
): Promise<AgentSessionRow | null> {
  const result = await db.query(AGENT_SQL.loadSession, [key.repo, key.domain, key.issueNumber]);
  const row = asRecord(result.rows[0]);
  if (row === null) {
    return null;
  }
  const sessionId = row['session_id'];
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    cursor: numberOf(row['cursor'], 0),
    turns: numberOf(row['turns'], 0),
    startedAt: row['started_at'] instanceof Date ? row['started_at'] : null,
  };
}

/** 写会话行（UPSERT；一个（域, 编号）一行）。`key` 必须带 `domain`（BR-5）。 */
export async function saveSession(
  db: SqlRunner,
  key: AgentSessionKey,
  value: AgentSessionRow,
): Promise<void> {
  await db.query(AGENT_SQL.saveSession, [
    key.repo,
    key.domain,
    key.issueNumber,
    value.sessionId,
    value.cursor,
    value.turns,
    value.startedAt,
  ]);
}
