/**
 * 权限（需求 §5 规则 1：**@ 仅管理员**；`settings.agent.managers` 是唯一名单）。
 *
 * 两条落地约束：
 *  1. **拒绝单独记账**（`agent_denials`，PK `(repo, issue, actor_login)`）—— 不写进
 *     `agent_messages`：那张表的主键就是幂等键，把拒绝写进去会让「日后被提成管理员的同一个人
 *     说同一句话」永久静默，且查不到原因（dev-plan §2.1「权限拒绝独立记账」/ C-10 / L-08）；
 *  2. **同 issue 同 actor 只回一次**：第一次插入成功才回话，之后 `alreadyReplied=true` 静默。
 *     「只回一次」按 **issue** 维度（X-09：换个 issue 仍回一次）。
 */
import type { SqlRunner } from '../config/repo-config.ts';

/** `isManager()` 只需要这一小段 settings（避免把整份 `RepoSettings` 拉进这个纯函数）。 */
export type AgentManagerSettings =
  | {
      readonly agent?:
        | {
            readonly managers?: readonly string[] | undefined;
          }
        | undefined;
    }
  | null
  | undefined;

/** `agent_denials` 的键（**不含** actor：actor 由参数单独给）。 */
export type AgentDenialKey = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly actorLogin: string;
};

export const AGENT_DENIAL_SQL = {
  /** 插入即占位：`rowCount = 0` 表示这个人已经在这条 issue 上被拒过。 */
  insertDenial: `INSERT INTO "agent_denials" ("repo", "issue_number", "actor_login", "replied_at")
VALUES ($1, $2, $3, now())
ON CONFLICT ("repo", "issue_number", "actor_login") DO NOTHING
RETURNING "replied_at"`,
  readDenial: `SELECT "replied_at" FROM "agent_denials"
WHERE "repo" = $1 AND "issue_number" = $2 AND "actor_login" = $3`,
  /** 面板/排障用：这个 issue 上被拒过的人。 */
  listDenials: `SELECT "actor_login", "replied_at" FROM "agent_denials"
WHERE "repo" = $1 AND "issue_number" = $2 ORDER BY "replied_at" DESC LIMIT 50`,
} as const;

/**
 * 是不是管理员。
 *
 * 大小写不敏感（GitHub login 本身不区分大小写），空 login 一律不是。
 * **不**把 issue 作者 / 协作者算进来（OQ-9 已定：只有名单）。
 */
export function isManager(settings: AgentManagerSettings, login: string): boolean {
  const normalized = login.trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  const managers = settings?.agent?.managers ?? [];
  return managers.some((manager) => manager.trim().toLowerCase() === normalized);
}

/**
 * 记一次拒绝，返回「这次要不要回话」。
 *
 * `alreadyReplied: false` = 第一次被拒（调用方回一句「无权限」）；
 * `true` = 这个 actor 在这条 issue 上已经被拒过（静默）。
 */
export async function recordDenial(
  db: SqlRunner,
  key: AgentDenialKey,
  actor: string,
): Promise<{ readonly alreadyReplied: boolean }> {
  const inserted = await db.query(AGENT_DENIAL_SQL.insertDenial, [key.repo, key.issueNumber, actor]);
  const rowCount = inserted.rowCount ?? inserted.rows.length;
  return { alreadyReplied: rowCount === 0 };
}
