/**
 * webhook 接收管线（B10，tech-plan §5.3 的九步 + 七个要点）。
 *
 * ```
 * 1. 原始 body（Fastify raw body parser，不能用 JSON parser，否则 HMAC 对不上）
 * 2. 验签 → 失败 401 且记审计
 * 3. INSERT webhook_deliveries … ON CONFLICT DO NOTHING   ← 主幂等点
 * 4. rowCount = 0 → 200 duplicate（GitHub 重投是常态，不是异常）
 * 5. 判定是否需要处理（事件/action 白名单 + 仓库开关 + dry-run）
 * 6. INSERT tasks（command / actor_login / queued_at 在这一步写死，F9）
 * 7. boss.send('run-task', …)（singletonKey = taskId）
 * 8. ★ 10 秒应答在 handler 内：入队成功后立刻打 eyes reaction（评论场景换一行「已收到」）
 * 9. 200，全程 < 2s
 * ```
 *
 * 三条落地要点：
 *  - **幂等只在数据库**：投递级（`webhook_deliveries.delivery_id`）+ 任务级（`tasks.idempotency_key`）
 *    两个唯一索引，没有内存去重表。
 *  - **第 8 步不排队**：`await` 在 handler 里完成，失败只 `warn`（回应失败不该让 GitHub 重投一次）。
 *  - **dry-run 不产生任何写动作**：`repos.dry_run` 为真（或 `replay` 强制）时只建任务、不打 reaction、
 *    不发确认评论。
 */
import { createHash, randomUUID } from 'node:crypto';
import { Webhooks } from '@octokit/webhooks';
import type { ErrorBody, RepoConfig, WebhookAcceptedResponse } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import type { FastifyRequest } from 'fastify';
import { readRepoPolicy } from '../config/repo-config.ts';
import type { RepoPolicy, SqlRunner } from '../config/repo-config.ts';
import { splitRepo } from '../github/index.ts';
import type { GithubClient } from '../github/index.ts';
import { RUNTIME_FLAG_SQL, buildIdempotencyKey, enqueueTask, isPauseFlagActive } from '../queue/index.ts';
import type { QueueBoss, RunTaskJobData } from '../queue/index.ts';
import { errorBodyOf } from './errors.ts';
import type { ZodFastify } from './types.ts';

export const WEBHOOK_SQL = {
  /**
   * 投递级幂等。`signature_valid` 由调用方给：验签失败也落库（审计要求），但不入队。
   */
  insertDelivery: `INSERT INTO "webhook_deliveries" ("delivery_id", "event", "action", "payload", "signature_valid")
VALUES ($1, $2, $3, $4::jsonb, $5)
ON CONFLICT ("delivery_id") DO NOTHING
RETURNING "delivery_id"`,
  readDelivery: `SELECT "signature_valid" FROM "webhook_deliveries" WHERE "delivery_id" = $1`,
  /** 同一 delivery 先前验签失败、这次通过：把标记翻正后继续处理（不是重复投递）。 */
  markSignatureValid: `UPDATE "webhook_deliveries" SET "signature_valid" = true WHERE "delivery_id" = $1`,
  insertTask: `INSERT INTO "tasks" ("id", "source", "repo", "target_kind", "target_number", "head_sha", "command", "actor_login", "queued_at", "idempotency_key", "status", "delivery_id", "prompt_text")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, 'queued', $10, $11)
ON CONFLICT ("idempotency_key") DO NOTHING
RETURNING "id"`,
  findTaskByIdempotencyKey: `SELECT "id" FROM "tasks" WHERE "idempotency_key" = $1`,
  /** `replay` 的数据源：原文 90 天内都在（§5.3 第 3 步）。 */
  readPayload: `SELECT "event", "payload" FROM "webhook_deliveries" WHERE "delivery_id" = $1`,
} as const;

/** 请求头（我们只依赖这三个，见契约 §9）。 */
export const WEBHOOK_HEADERS = {
  delivery: 'x-github-delivery',
  event: 'x-github-event',
  signature: 'x-hub-signature-256',
} as const;

/**
 * 新 issue 的「接管」评论（`PI_BOT_GREET` 开时发送）。
 *
 * 文案只讲三件事：我叫什么、怎么 @ 我、我会做什么。不承诺做不到的事。
 */
export const ISSUE_GREETING_BODY = [
  '我是 **pi-issue-bot**，这个 issue 由我接管。',
  '',
  '- 想让我做判定/复现/审查：`@pi-issue-bot-tioit /issue-triage`、`/issue-repro`、`/review-pr`',
  '',
  '判定结果会以标签 + 一条说明评论回帖；只在拿到可信结论时才写。',
].join('\n');

/**
 * 自由问答（`@bot 你的问题`，**不带** `/命令`）在 `tasks.command` 里的前缀。
 *
 * 为什么把问题编码进 `command` 而不是加一列：这条路径只需要「问题正文进 prompt」，
 * 加列要动迁移 + `contract-db.md` + 面板展示三处；base64url 让问题只活在任务行里，
 * 幂等键也天然按问题区分（同一问题重复 @ 是空操作，不同问题各自成任务）。
 */
export const FREE_MENTION_PREFIX = '@answer:';

/** 自由问答任务的 `tasks.command`（契约里 `command` ≤64 字符，所以问题正文另存 `prompt_text`）。 */
export const FREE_ANSWER_COMMAND = '@answer';

/** 问题正文 → 旧版 `command` 里的锚（仅用于兼容已存在的 `@answer:<base64>` 任务行）。 */
export function encodeFreeQuestion(question: string): string {
  return Buffer.from(question, 'utf8').toString('base64url');
}

/** 自由问答任务：新格式 `@answer`，以及兼容期的旧格式 `@answer:<base64url>`。 */
export function isFreeAnswerCommand(command: string): boolean {
  return command === FREE_ANSWER_COMMAND || command.startsWith(FREE_MENTION_PREFIX);
}

/** `command` 里的锚 → 问题正文；不是自由问答任务返回 `null`。 */
export function decodeFreeQuestion(command: string): string | null {
  if (!command.startsWith(FREE_MENTION_PREFIX)) {
    return null;
  }
  try {
    const text = Buffer.from(command.slice(FREE_MENTION_PREFIX.length), 'base64url').toString('utf8');
    return text.trim().length === 0 ? null : text;
  } catch {
    return null;
  }
}

/**
 * 从评论里取「纯 @ 提问」的正文：@ 到了句柄、**没有** `/命令`、正文非空。
 *
 * 返回 `null` 表示这条评论不是自由提问（交给命令通道或直接忽略）。
 */
export function extractFreeQuestion(body: unknown, mention: string = DEFAULT_BOT_MENTION): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const escaped = escapeRegExp(mention);
  const mentionPattern = new RegExp(`(?:^|\\s)@${escaped}\\b`, 'u');
  if (!mentionPattern.test(body)) {
    return null;
  }
  if (commandMentionPattern(mention).test(body)) {
    return null;
  }
  const question = body.replace(new RegExp(`(?:^|\\s)@${escaped}\\b`, 'gu'), ' ').trim();
  return question.length === 0 ? null : question.slice(0, 4000);
}
/** 缺省句柄：App 名为 `pi-bot` 的部署用它（其它 App 用 `PI_BOT_MENTION` 覆盖）。 */
export const DEFAULT_BOT_MENTION = 'pi-bot';

/** 转义正则字面量（句柄来自配置，不能直接拼进正则）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 命令触发正则：`@<handle> /review-pr`。
 *
 * 句柄**必须**可配：文档 §6.4 只规定「`@机器人 /命令`」，而 slug 由 App 名字决定
 * （本仓库实际部署的 App 是 `pi-issue-bot-tioit`）——写死 `pi-bot` 会让真实用户
 * @ 了机器人却没反应。
 */
export function commandMentionPattern(handle: string = DEFAULT_BOT_MENTION): RegExp {
  return new RegExp(`(?:^|\\s)@${escapeRegExp(handle)}\\s+(\\/[a-z][a-z0-9-]{1,30})(?=\\s|$)`, 'u');
}

/** 缺省句柄的正则（测试与「App 就叫 pi-bot」的部署用）。 */
export const COMMAND_MENTION_PATTERN = commandMentionPattern();

/* ── 注入面 ──────────────────────────────────────────────────────────────── */

/** 验签。默认实现是 `@octokit/webhooks`；测试注入假实现。 */
export type WebhookVerify = (input: {
  readonly deliveryId: string;
  readonly event: string;
  readonly rawBody: string;
  readonly signature: string;
}) => Promise<boolean>;

/** 入队。默认实现是 `queue/enqueueTask`；测试注入假 boss。 */
export type TaskEnqueuer = (data: RunTaskJobData) => Promise<string | null>;

/** 「收到了」这一步（第 8 步）的 GitHub 写动作。干跑时**一个都不调**。 */
export type WebhookAck = {
  /** `POST /repos/:o/:r/issues/:n/reactions { content: 'eyes' }` */
  addEyesReaction(input: {
    readonly repo: string;
    readonly issueNumber: number;
    /** 触发评论的 databaseId；给了就打评论级 reaction，缺省回落 issue 级。 */
    readonly commentId?: number | null;
  }): Promise<void>;
  /** 评论场景的等价物：一行「已收到」。 */
  postAckComment(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<void>;
};

export type WebhookDeps = {
  readonly verify: WebhookVerify;
  /** 写 `webhook_deliveries` / `tasks` / 读 `repos` / `runtime_flags`。真实实现是 `pg.Pool`。 */
  readonly db: SqlRunner;
  readonly enqueue: TaskEnqueuer;
  readonly ack: WebhookAck;
  readonly logger: Logger;
  readonly now?: () => Date;
  /**
   * 是否把「纯 @ 提问」（不带 `/命令`）也当成任务（`PI_BOT_FREE_MENTION`，默认开）。
   *
   * 关掉时只有 `@bot /命令` 会触发；打开时 `@bot 这个问题怎么解？` 也会跑一次 turn，
   * 只允许产出 comment（不打标、不写回）。
   */
  readonly freeMention?: boolean;
  /** 熔断/暂停判定。默认读 `runtime_flags.rate_limit_pause`。 */
  readonly isPaused?: () => Promise<boolean>;
  /** 评论里 @ 的句柄（App slug）；缺省 `pi-bot`。 */
  readonly mention?: string;
  /**
   * 新 issue 是否发一条「接管」评论（`PI_BOT_GREET`，默认开）。
   *
   * 为什么需要它：GitHub 的 @ 补全只列「仓库协作者 + 该 thread 的参与者」，App 的 bot
   * 不在协作者里；它在这个 issue 里说过话之后，用户才能在下拉里 @ 到它。这条评论
   * 同时也是使用说明，所以它解决的是「所有 issue 都能 @ 到 bot」。
   */
  readonly greet?: boolean;
};

export type WebhookInput = {
  readonly deliveryId: string;
  readonly event: string;
  /** 原始文本（验签必须用它，不能用 `JSON.stringify(JSON.parse(x))`）。 */
  readonly rawBody: string;
  /** `x-hub-signature-256`；`null` 仅允许出现在 `source='replay'` 时（跳过验签）。 */
  readonly signature: string | null;
  readonly source: 'live' | 'replay';
  /** `replay` 用：强制干跑（不产生任何 GitHub 写动作）。 */
  readonly forcedDryRun?: boolean;
  /** `replay` 用：投递行已存在，不该被当成「重复投递」。 */
  readonly skipDeliveryDedup?: boolean;
};

export type WebhookResult = {
  readonly status: number;
  readonly body: WebhookAcceptedResponse | ErrorBody;
  readonly elapsedMs: number;
};

/* ── 白名单与任务判定（纯函数，可单测）────────────────────────────────────── */

/** `issues.*` 里需要判定的事件（plan §6.1：opened / edited / reopened）。 */
export const ISSUE_ACTIONS: readonly string[] = Object.freeze(['opened', 'edited', 'reopened']);

export type WebhookTaskPlan = {
  /** 落 `tasks.command`：`/review-pr` 或 `auto:triage`。 */
  readonly command: string;
  /** 幂等键的 kind：`command:/review-pr` / `triage`。 */
  readonly kind: string;
  readonly source: 'webhook' | 'command';
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha: string | null;
  /** 判定类任务的锚：issue 版本（`updated_at`）的短哈希。 */
  readonly issueVersionHash: string | null;
  readonly actorLogin: string;
  readonly association: string | null;
  /** 触发评论的 databaseId（评论级回执用；issue/PR 事件为 `null`）。 */
  readonly commentId: number | null;
  /** 第 8 步用哪种回应：issue/PR 事件打 reaction，评论命令回一行评论。 */
  readonly ackStyle: 'reaction' | 'comment';
  /** 自由问答的问题正文（落 `tasks.prompt_text`；其它任务为 `undefined`）。 */
  readonly promptText?: string;
};

export type WebhookDecision =
  | { readonly action: 'task'; readonly plan: WebhookTaskPlan }
  | { readonly action: 'ignore'; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * issue 版本锚：`sha256(updated_at)` 前 16 位。
 *
 * 为什么不直接用 `MISSING_SET_ANCHOR`（`none`）：判定类任务的真正锚是「缺失项集合」，
 * 那个要 worker 读完 issue 正文才算得出来；但**任务级**去重必须在此刻就有锚，
 * 否则「issue 被编辑后重判」会被唯一键吃掉。用版本时间做锚的语义正好是
 * 「同一版内容只判一次，编辑后产生新任务」，而 worker 仍会在缺失项集合未变时跳过回复（plan §6.2）。
 */
export function issueVersionHash(updatedAt: unknown): string {
  const text = typeof updatedAt === 'string' ? updatedAt : '';
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** 从评论正文里取命令（`@pi-bot /review-pr`）；没有则 `null`。 */
export function extractCommand(body: unknown, mention: string = DEFAULT_BOT_MENTION): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const matched = commandMentionPattern(mention).exec(body);
  return matched?.[1] ?? null;
}

/** 机器人账号（`type: 'Bot'`）无论 association 一律忽略（plan §6.4）。 */
function isBotActor(user: Record<string, unknown> | null): boolean {
  return readString(user, 'type') === 'Bot';
}

/**
 * 事件/action 白名单 → 要不要建任务、建什么任务。
 *
 * 覆盖范围有意收窄（其余事件一律 `ignored`，但仍落 `webhook_deliveries` 供审计）：
 *  - `issue_comment.created` 且正文里有 `@pi-bot /cmd` → 命令任务（PR 或 issue）
 *  - `issues.opened|edited|reopened` → `auto:triage` 判定任务
 *  - 其余（含 `pull_request.*`、`push`、`label`…）→ 不建任务。PR 的审查由命令触发（plan §6.4）。
 */
export function decideWebhookTask(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  /** 评论里 @ 的句柄（App slug）；缺省 `pi-bot`。 */

  /**
   * 是否把「纯 @ 提问」（不带 `/命令`）也当成任务（`PI_BOT_FREE_MENTION`，默认开）。
   * 关掉时只有 `@bot /命令` 会建任务。
   */
  readonly freeMention?: boolean;
  readonly mention?: string;
}): WebhookDecision {
  const payload = asRecord(input.payload);
  const actorUser = asRecord(payload?.['sender']);
  if (isBotActor(actorUser)) {
    return { action: 'ignore', reason: '触发者是机器人账号' };
  }

  if (input.event === 'issue_comment') {
    if (input.action !== 'created') {
      return { action: 'ignore', reason: `issue_comment.${input.action ?? '未知'} 不在白名单` };
    }
    const comment = asRecord(payload?.['comment']);
    const issue = asRecord(payload?.['issue']);
    const number = readNumber(issue, 'number');
    if (number === null) {
      return { action: 'ignore', reason: 'issue_comment 载荷缺少 issue.number' };
    }
    const isPullRequest = asRecord(issue?.['pull_request']) !== null;
    const commentUser = asRecord(comment?.['user']);
    const login = readString(commentUser, 'login') ?? readString(actorUser, 'login') ?? 'unknown';
    const mention = input.mention ?? DEFAULT_BOT_MENTION;

    const command = extractCommand(comment?.['body'], mention);
    // 纯 @ 提问（没有 `/命令`）：走自由问答通道，问题正文编码进 `command`（见上面的说明）
    const question =
      command === null && input.freeMention === true ? extractFreeQuestion(comment?.['body'], mention) : null;
    if (command === null && question === null) {
      return { action: 'ignore', reason: `评论里没有 @${mention} 命令` };
    }

    const base = {
      source: 'command' as const,
      targetKind: isPullRequest ? ('pr' as const) : ('issue' as const),
      targetNumber: number,
      // 评论载荷里没有 PR 的 head sha（要额外打一次 API）；锚缺省走 `none`。
      headSha: null,
      issueVersionHash: null,
      actorLogin: login,
      association: readString(comment, 'author_association'),
      commentId: readNumber(comment, 'id'),
      // 回执统一走 eyes reaction：不发「已收到」评论，避免每个命令都多一条噪声
      ackStyle: 'reaction' as const,
    };

    if (command === null) {
      const asked = question ?? '';
      return {
        action: 'task',
        plan: {
          ...base,
          command: FREE_ANSWER_COMMAND,
          promptText: asked,
          // 幂等键按**问题正文**区分：同一问题重复 @ 是空操作，换个问题就能得到新回答
          // 幂等键 = 「问题正文 + 这条评论的 id」：同一条评论的重投仍是空操作，
          // 但**换个评论再问同一句话**应该得到新回答（只按正文 hash 会静默吞掉第二次提问）。
          kind: `answer:${createHash('sha256')
            .update(`${asked}\u0000${String(comment?.['id'] ?? 'none')}`, 'utf8')
            .digest('hex')
            .slice(0, 12)}`,
        },
      };
    }

    return {
      action: 'task',
      plan: {
        ...base,
        command,
        kind: `command:${command}`,
      },
    };
  }

  if (input.event === 'issues') {
    if (input.action === null || !ISSUE_ACTIONS.includes(input.action)) {
      return { action: 'ignore', reason: `issues.${input.action ?? '未知'} 不在白名单` };
    }
    const issue = asRecord(payload?.['issue']);
    const number = readNumber(issue, 'number');
    if (number === null) {
      return { action: 'ignore', reason: 'issues 载荷缺少 issue.number' };
    }
    const actorLogin = readString(actorUser, 'login') ?? 'unknown';
    return {
      action: 'task',
      plan: {
        command: 'auto:triage',
        kind: 'triage',
        source: 'webhook',
        targetKind: 'issue',
        targetNumber: number,
        headSha: null,
        issueVersionHash: issueVersionHash(issue?.['updated_at']),
        actorLogin,
        association: readString(issue, 'author_association'),
        commentId: null,
        ackStyle: 'reaction',
      },
    };
  }

  return { action: 'ignore', reason: `事件 ${input.event}.${input.action ?? '未知'} 不在白名单` };
}

/** 命令门禁（plan §6.4）：命令白名单 + `author_association` + login 白名单。 */
export type CommandGateResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkCommandGate(
  plan: WebhookTaskPlan,
  config: RepoConfig | null,
): CommandGateResult {
  if (plan.source !== 'command') {
    // 判定类事件不走命令门禁：它们由仓库开关与事件白名单控制
    return { allowed: true };
  }
  if (config === null) {
    return { allowed: false, reason: '仓库没有可用配置（config_valid=false）' };
  }
  if (!config.commands.enabled) {
    return { allowed: false, reason: '仓库配置关闭了命令（commands.enabled=false）' };
  }
  // 自由问答（`@answer:<base64>`）不是配置里的命令名，但同样受 enabled/association 约束
  const isFreeAnswer = isFreeAnswerCommand(plan.command);
  if (!isFreeAnswer && !config.commands.allowed.includes(plan.command)) {
    return { allowed: false, reason: `命令 ${plan.command} 不在白名单` };
  }
  if (config.commands.allow_users.includes(plan.actorLogin)) {
    return { allowed: true };
  }
  const association = plan.association ?? 'NONE';
  const allowedAssociations: readonly string[] = config.commands.author_associations;
  if (!allowedAssociations.includes(association)) {
    return { allowed: false, reason: `author_association=${association} 不在门禁白名单` };
  }
  return { allowed: true };
}

/** 任务的幂等键（公式在 `queue/idempotency.ts`，这里只负责喂对锚）。 */
export function idempotencyKeyFor(plan: WebhookTaskPlan, repo: string): string {
  return buildIdempotencyKey({
    kind: plan.kind,
    repo,
    target: `${plan.targetKind}#${String(plan.targetNumber)}`,
    headSha: plan.headSha,
    missingSetHash: plan.issueVersionHash,
    triggerActor: plan.actorLogin,
  });
}

/* ── 管线本体 ────────────────────────────────────────────────────────────── */

type AcceptedInput = {
  readonly deliveryId: string;
  readonly action: WebhookAcceptedResponse['action'];
  readonly taskId: string | null;
  readonly duplicate: boolean;
  readonly ackComment: string | null;
};

function accepted(input: AcceptedInput): WebhookAcceptedResponse {
  return {
    status: 'accepted',
    deliveryId: input.deliveryId,
    taskId: input.taskId,
    duplicate: input.duplicate,
    action: input.action,
    ackComment: input.ackComment,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 默认的暂停判定：读 `runtime_flags.rate_limit_pause`（§7.4）。 */
async function defaultIsPaused(db: SqlRunner, now: Date): Promise<boolean> {
  const result = await db.query(RUNTIME_FLAG_SQL.read, ['rate_limit_pause']);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return false;
  }
  const until = row['until'];
  return isPauseFlagActive(
    {
      key: 'rate_limit_pause',
      value: typeof row['value'] === 'string' ? row['value'] : '',
      until: until instanceof Date ? until : null,
    },
    now,
  );
}

/**
 * 跑一次投递（九步）。
 *
 * 失败形态（都用契约错误体）：
 *  - 缺请求头 / 验签失败 → 401 `unauthorized`（验签失败会落审计行，但不入队）
 *  - body 不是 JSON → 400 `bad-request`
 * 其余业务判定（重复、忽略、暂停、门禁不过）一律 **200**：GitHub 只看 2xx 决定是否重投。
 */
export async function handleWebhook(deps: WebhookDeps, input: WebhookInput): Promise<WebhookResult> {
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = performance.now();
  const log = deps.logger.child({ deliveryId: input.deliveryId, event: input.event });
  const finish = (status: number, body: WebhookResult['body']): WebhookResult => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (elapsedMs >= 2000) {
      // 第 9 步要求全程 < 2s；超了要能在日志里看见是哪一次
      log.warn({ elapsedMs }, 'webhook 处理超过 2s（目标 < 2s）');
    }
    return { status, body, elapsedMs };
  };

  // ── 第 2 步：验签 ────────────────────────────────────────────────────────
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody) as unknown;
  } catch {
    log.warn('webhook body 不是合法 JSON');
    return finish(400, errorBodyOf('bad-request', '请求体不是合法的 JSON'));
  }

  const action = readString(asRecord(payload), 'action');

  if (input.source === 'live') {
    const signature = input.signature;
    if (signature === null) {
      // 缺签名 = 未授权（契约 §0.2 最后一行：不设宽容模式）
      log.warn('缺少 X-Hub-Signature-256');
      return finish(401, errorBodyOf('unauthorized', '缺少 X-Hub-Signature-256 请求头'));
    }
    // 验签实现可能抛错（网络/依赖库），抛错一律按「验签失败」处理：不设宽容模式
    let valid: boolean;
    try {
      valid = await deps.verify({
        deliveryId: input.deliveryId,
        event: input.event,
        rawBody: input.rawBody,
        signature,
      });
    } catch (error) {
      log.warn({ err: describeError(error) }, '验签过程抛错，按失败处理');
      valid = false;
    }
    if (!valid) {
      // 记审计：验签失败也落库，但不入队（§5.3 第 3 步 / 第二段「七要点」最后一条）
      await deps.db.query(WEBHOOK_SQL.insertDelivery, [
        input.deliveryId,
        input.event,
        action,
        payload,
        false,
      ]);
      log.warn('webhook 验签失败');
      return finish(401, errorBodyOf('unauthorized', '签名校验失败'));
    }
  }

  // ── 第 3/4 步：投递级幂等 ────────────────────────────────────────────────
  if (input.skipDeliveryDedup !== true) {
    const inserted = await deps.db.query(WEBHOOK_SQL.insertDelivery, [
      input.deliveryId,
      input.event,
      action,
      payload,
      true,
    ]);
    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await deps.db.query(WEBHOOK_SQL.readDelivery, [input.deliveryId]);
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      const signatureValid = row?.['signature_valid'] === true;
      if (signatureValid) {
        log.info('重复投递，直接回 200');
        return finish(200, accepted({ deliveryId: input.deliveryId, action: 'duplicate', taskId: null, duplicate: true, ackComment: null }));
      }
      // 同一 delivery 先前验签失败、这次通过：翻正后继续，不当作重复
      await deps.db.query(WEBHOOK_SQL.markSignatureValid, [input.deliveryId]);
    }
  }

  // ── 第 5 步：熔断 / 仓库开关 / 白名单 ────────────────────────────────────
  const paused =
    deps.isPaused === undefined ? await defaultIsPaused(deps.db, now()) : await deps.isPaused();
  if (paused) {
    // 不丢事件、不占并发（契约 §9）：投递已落库，恢复后可用 replay 重放
    log.warn('熔断中，本次只记投递不入队');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'paused', taskId: null, duplicate: false, ackComment: null }));
  }

  const repo = readString(asRecord(asRecord(payload)?.['repository']), 'full_name');
  if (repo === null) {
    log.warn('载荷缺少 repository.full_name');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  let policy: RepoPolicy;
  try {
    policy = await readRepoPolicy(deps.db, repo);
  } catch (error) {
    log.error({ repo, err: describeError(error) }, '读取仓库策略失败');
    return finish(500, errorBodyOf('internal', '读取仓库配置失败'));
  }
  if (!policy.known) {
    log.info({ repo }, '仓库尚未同步配置（repos 无此行），忽略本次投递');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }
  if (!policy.enabled || !policy.configValid) {
    log.warn({ repo, enabled: policy.enabled, configValid: policy.configValid }, '仓库已禁用或配置非法，忽略');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  const decision = decideWebhookTask({
    event: input.event,
    action,
    payload,
    ...(deps.mention === undefined ? {} : { mention: deps.mention }),
    ...(deps.freeMention === undefined ? {} : { freeMention: deps.freeMention }),
  });
  if (decision.action === 'ignore') {
    log.info({ repo, reason: decision.reason }, '事件不在白名单，不建任务');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }
  const plan = decision.plan;

  const gate = checkCommandGate(plan, policy.config);
  if (!gate.allowed) {
    log.warn({ repo, command: plan.command, reason: gate.reason }, '命令门禁不通过');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'unauthorized', taskId: null, duplicate: false, ackComment: null }));
  }

  const dryRun = policy.dryRun || input.forcedDryRun === true;

  // ── 第 6 步：建任务（command / actor_login / queued_at 在这里写死，F9）────
  const idempotencyKey = idempotencyKeyFor(plan, repo);
  const taskId = randomUUID();
  const insertedTask = await deps.db.query(WEBHOOK_SQL.insertTask, [
    taskId,
    plan.source,
    repo,
    plan.targetKind,
    plan.targetNumber,
    plan.headSha,
    plan.command,
    plan.actorLogin,
    idempotencyKey,
    input.deliveryId,
    plan.promptText ?? null,
  ]);

  if ((insertedTask.rowCount ?? 0) === 0) {
    // 任务级幂等命中：同一 (kind, repo, target, anchor, actor) 已经建过
    const existing = await deps.db.query(WEBHOOK_SQL.findTaskByIdempotencyKey, [idempotencyKey]);
    const existingId = (existing.rows[0] as Record<string, unknown> | undefined)?.['id'];
    log.info({ repo, command: plan.command }, '任务级幂等命中，不再入队');
    // 去重也必须给回执：否则用户看到的是「@ 了但一点反应都没有」。
    // 同一句话再问一次会走到这条路径（幂等键按「问题 + 评论 id」算），
    // 所以要在这里补一个 eyes，而不是让用户以为机器人死了。
    if (!dryRun) {
      try {
        await deps.ack.addEyesReaction({
          repo,
          issueNumber: plan.targetNumber,
          commentId: plan.commentId,
        });
      } catch (error) {
        log.warn({ err: describeError(error) }, '去重分支打 reaction 失败（不影响 200）');
      }
    }
    return finish(200, accepted({
      deliveryId: input.deliveryId,
      action: 'duplicate',
      taskId: typeof existingId === 'string' ? existingId : null,
      duplicate: true,
      ackComment: null,
    }));
  }

  const taskLog = log.child({ taskId, repo });
  taskLog.info({ command: plan.command, target: `${plan.targetKind}#${String(plan.targetNumber)}`, dryRun }, '任务已入库');

  // ── 第 7 步：入队 ────────────────────────────────────────────────────────
  try {
    const jobId = await deps.enqueue({ taskId, command: plan.command, repo });
    taskLog.info({ jobId }, jobId === null ? '任务已在队列中（singletonKey 命中）' : '已入队');
  } catch (error) {
    // 入队失败但任务行已存在：留给排队闸门/清理任务兜底（≥10min 未开跑会被取消并评论）
    taskLog.error({ err: describeError(error) }, '入队失败');
    return finish(500, errorBodyOf('internal', '任务入队失败'));
  }

  // ── 第 8 步：★ 10 秒应答就在 handler 内（不经过队列）──────────────────────
  if (dryRun) {
    taskLog.info('dry-run：跳过 reaction / 确认评论（不产生任何 GitHub 写动作）');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment: null }));
  }

  let ackComment: string | null = null;
  try {
    if (plan.ackStyle === 'reaction') {
      await deps.ack.addEyesReaction({
        repo,
        issueNumber: plan.targetNumber,
        commentId: plan.commentId,
      });
      taskLog.info({ commentId: plan.commentId }, '已打 eyes reaction');
    } else {
      // 保底分支（决策层当前恒为 reaction）：文案里**不带任务编号**——用户在 GitHub 上
      // 不需要看到内部 id，排查靠 `delivery_id`/日志。
      const ackLabel = isFreeAnswerCommand(plan.command) ? '你的提问' : plan.command;
      ackComment = `已收到 ${ackLabel}，排队中……`;
      await deps.ack.postAckComment({ repo, issueNumber: plan.targetNumber, body: ackComment });
      taskLog.info('已回「已收到」评论');
    }
  } catch (error) {
    // 回应失败只记 warn：不该让 GitHub 因此重投一次（§5.3 七要点第三条）
    taskLog.warn({ err: describeError(error) }, '回应 GitHub 失败（不影响 200）');
    ackComment = null;
  }

  // ── 第 8.5 步：新 issue 的「接管」评论（`PI_BOT_GREET`，默认开）────────────
  //
  // 为什么单独发一条：GitHub 的 @ 补全只列「协作者 + 该 thread 的参与者」，机器人在这个
  // issue 里说过话之后用户才能在下拉里 @ 到它；这条评论同时就是使用说明。
  // 只对 `issues.opened` 的自动分类发一次；失败只记 warn（不能让 GitHub 重投）。
  if (deps.greet === true && plan.command === 'auto:triage' && action === 'opened') {
    try {
      await deps.ack.postAckComment({ repo, issueNumber: plan.targetNumber, body: ISSUE_GREETING_BODY });
      taskLog.info('已发「接管」评论');
    } catch (error) {
      taskLog.warn({ err: describeError(error) }, '接管评论发送失败（不影响 200）');
    }
  }

  // ── 第 9 步：200 ─────────────────────────────────────────────────────────
  return finish(200, accepted({ deliveryId: input.deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment }));
}

/**
 * `pi-bot replay <delivery-id>`：拿 `webhook_deliveries.payload` 原文重放，**强制干跑**。
 *
 * 返回 `null` = 没有这条投递（CLI 以 NOT_IMPLEMENTED 之外的错误码退出）。
 * 跳过验签与投递去重是有意的：原文已经验过一次，重放的目的就是「再跑一遍入队」。
 */
export async function replayDelivery(
  deps: WebhookDeps,
  deliveryId: string,
): Promise<WebhookResult | null> {
  const result = await deps.db.query(WEBHOOK_SQL.readPayload, [deliveryId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return null;
  }
  const event = typeof row['event'] === 'string' ? row['event'] : 'unknown';
  const rawBody = JSON.stringify(row['payload'] ?? {});
  return handleWebhook(deps, {
    deliveryId,
    event,
    rawBody,
    signature: null,
    source: 'replay',
    forcedDryRun: true,
    skipDeliveryDedup: true,
  });
}

/* ── 真实实现：验签 / 入队 / reaction ────────────────────────────────────── */

/** `@octokit/webhooks` 的 `verify()` 包一层（失败不抛，返回 false）。 */
export function createOctokitVerifier(secret: string): WebhookVerify {
  if (secret === '') {
    throw new Error('createOctokitVerifier: secret 不能为空（空 secret 等于不验签）');
  }
  const webhooks = new Webhooks({ secret });
  return async (input) => {
    try {
      return await webhooks.verify(input.rawBody, input.signature);
    } catch {
      return false;
    }
  };
}

/** pg-boss 入队（`singletonKey = taskId`，`expireInSeconds` 按命令取值）。 */
export function createQueueEnqueuer(boss: QueueBoss): TaskEnqueuer {
  return (data) => enqueueTask(boss, data);
}

/** 真实 reaction / 确认评论实现（走 `GithubClient.request`，不引入写执行器）。 */
export function createGithubWebhookAck(client: GithubClient): WebhookAck {
  return {
    async addEyesReaction(input) {
      const { owner, repo } = splitRepo(input.repo);
      // 评论触发时打到**那条评论**上（用户看自己评论的角标就能确认「收到了」）；
      // issue/PR 事件没有评论可打，回落到 issue 级 reaction。
      if (input.commentId !== undefined && input.commentId !== null) {
        await client.request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
          owner,
          repo,
          comment_id: input.commentId,
          content: 'eyes',
        });
        return;
      }
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
        owner,
        repo,
        issue_number: input.issueNumber,
        content: 'eyes',
      });
    },
    async postAckComment(input) {
      const { owner, repo } = splitRepo(input.repo);
      await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: input.issueNumber,
        body: input.body,
      });
    },
  };
}

/* ── HTTP 接线 ───────────────────────────────────────────────────────────── */

export type WebhookRouteOptions = {
  /** 请求体上限，默认 25 MB（契约 §9 的 413 口径）。 */
  readonly bodyLimitBytes?: number;
};

function headerValue(
  headers: FastifyRequest['headers'],
  name: string,
): string | null {
  const raw = headers[name];
  if (typeof raw === 'string') {
    return raw === '' ? null : raw;
  }
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return null;
}

/**
 * 注册 `POST /webhook`。
 *
 * **raw body 解析器必须只作用在这条路由上**：`addContentTypeParser` 是实例级的，
 * 直接在根实例上替换 JSON 解析器会让所有 JSON 路由都拿到 Buffer。所以放进一个
 * 封装作用域（`app.register`），解析器只对作用域内的路由生效。
 */
export function registerWebhookRoute(
  app: ZodFastify,
  deps: WebhookDeps,
  options: WebhookRouteOptions = {},
): void {
  const bodyLimit = options.bodyLimitBytes ?? 25 * 1024 * 1024;
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit },
      (_request, body, done) => {
        // 原样交给 handler：HMAC 必须对原始字节验
        done(null, body);
      },
    );

    scope.post('/webhook', async (request, reply) => {
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body.toString('utf8')
        : typeof request.body === 'string'
          ? request.body
          : '';

      const deliveryId = headerValue(request.headers, WEBHOOK_HEADERS.delivery);
      const event = headerValue(request.headers, WEBHOOK_HEADERS.event);
      if (deliveryId === null || event === null) {
        return reply.status(401).send(
          errorBodyOf('unauthorized', '缺少 X-GitHub-Delivery 或 X-GitHub-Event 请求头'),
        );
      }

      const result = await handleWebhook(deps, {
        deliveryId,
        event,
        signature: headerValue(request.headers, WEBHOOK_HEADERS.signature),
        rawBody,
        source: 'live',
      });
      return reply.status(result.status).send(result.body);
    });
  });
}
