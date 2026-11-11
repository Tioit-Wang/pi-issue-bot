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
  /** 幂等落库：返回行 = 新插入；0 行 = 同一 (repo, issue, fingerprint) 已经存在。 */
  insertMessage: `INSERT INTO "agent_messages" ("repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "created_at", "updated_at")
VALUES ($1, $2, $3, $4, 'queued', $5, $6, now(), now())
ON CONFLICT ("repo", "issue_number", "fingerprint") DO NOTHING
RETURNING "created_at"`,
  readMessage: `SELECT "repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "created_at"
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
RETURNING "repo", "issue_number", "fingerprint", "kind", "status", "comment_id", "comment_body", "created_at"`,
  markStatus: `UPDATE "agent_messages"
SET "status" = $4, "updated_at" = now()
WHERE "repo" = $1 AND "issue_number" = $2 AND "fingerprint" = $3`,
  /** 这个 issue 还有几条没处理（`running` + `queued`）。 */
  countPending: `SELECT COUNT(*)::int AS "n" FROM "agent_messages"
WHERE "repo" = $1 AND "issue_number" = $2 AND "status" IN ('queued', 'running')`,
  /** dispatcher 建任务：`source='agent'`，幂等键按消息算。 */
  insertTask: `INSERT INTO "tasks" ("id", "source", "repo", "target_kind", "target_number", "head_sha", "command", "actor_login", "queued_at", "idempotency_key", "status", "delivery_id", "prompt_text")
VALUES ($1, 'agent', $2, 'issue', $3, NULL, $4, $5, now(), $6, 'queued', NULL, $7)
ON CONFLICT ("idempotency_key") DO NOTHING
RETURNING "id"`,
  findTaskByIdempotencyKey: `SELECT "id" FROM "tasks" WHERE "idempotency_key" = $1`,
  loadSession: `SELECT "session_id", "cursor", "turns", "started_at"
FROM "agent_sessions"
WHERE "repo" = $1 AND "issue_number" = $2`,
  /** 一个 issue 一行：UPSERT。`turns` 由调用方算（轮换那一轮从 1 起）。 */
  saveSession: `INSERT INTO "agent_sessions" ("repo", "issue_number", "session_id", "cursor", "turns", "started_at", "updated_at")
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT ("repo", "issue_number") DO UPDATE SET
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
    createdAt: row['created_at'] instanceof Date ? row['created_at'] : new Date(0),
  };
}

/**
 * 落一条消息（幂等）。
 *
 * `inserted=false` 就是「同一句话已经来过」：调用方直接返回 `duplicate`，不建任务、不调模型
 * （L-01 / R-02）。`row` 是库里那一行（新插入时也读回来，方便调用方拿到 `created_at`）。
 */
export async function insertMessage(
  db: SqlRunner,
  input: {
    readonly key: AgentMessageKey;
    readonly kind: AgentMessageKind;
    readonly commentId?: number | null;
    readonly body: string;
  },
): Promise<{ readonly inserted: boolean; readonly row: AgentMessageRow | null }> {
  const result = await db.query(AGENT_SQL.insertMessage, [
    input.key.repo,
    input.key.issueNumber,
    input.key.fingerprint,
    input.kind,
    input.commentId ?? null,
    input.body,
  ]);
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
 * 返回 `{taskId}`：`taskId=null` 表示 `idempotency_key` 命中（这条消息已经有任务了），
 * 调用方按「已投递」处理（不重复入队）。
 */
export async function insertAgentTask(
  db: SqlRunner,
  input: {
    readonly taskId: string;
    readonly key: AgentMessageKey;
    readonly kind: AgentMessageKind;
    readonly body: string;
  },
): Promise<{ readonly taskId: string | null }> {
  const idempotencyKey = agentTaskIdempotencyKey(input.key);
  const result = await db.query(AGENT_SQL.insertTask, [
    input.taskId,
    input.key.repo,
    input.key.issueNumber,
    agentTaskCommand(input.kind),
    AGENT_TASK_ACTOR,
    idempotencyKey,
    input.body,
  ]);
  if ((result.rowCount ?? result.rows.length) > 0) {
    return { taskId: input.taskId };
  }
  const existing = await findTaskIdByKey(db, idempotencyKey);
  return { taskId: existing };
}

/** 按幂等键查已有任务 id（幂等命中时用来回填响应体的 `taskId`）。 */
export async function findTaskIdByKey(db: SqlRunner, idempotencyKey: string): Promise<string | null> {
  const result = await db.query(AGENT_SQL.findTaskByIdempotencyKey, [idempotencyKey]);
  const id = asRecord(result.rows[0])?.['id'];
  return typeof id === 'string' ? id : null;
}

/** 读会话行（没有 → `null` = 还没开过会话）。 */
export async function loadSession(
  db: SqlRunner,
  key: { readonly repo: string; readonly issueNumber: number },
): Promise<AgentSessionRow | null> {
  const result = await db.query(AGENT_SQL.loadSession, [key.repo, key.issueNumber]);
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

/** 写会话行（UPSERT；一个 issue 一行）。 */
export async function saveSession(
  db: SqlRunner,
  key: { readonly repo: string; readonly issueNumber: number },
  value: AgentSessionRow,
): Promise<void> {
  await db.query(AGENT_SQL.saveSession, [
    key.repo,
    key.issueNumber,
    value.sessionId,
    value.cursor,
    value.turns,
    value.startedAt,
  ]);
}
