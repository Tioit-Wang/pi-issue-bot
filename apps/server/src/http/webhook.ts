/**
 * webhook 接收管线（B10，tech-plan §5.3 的九步 + 七个要点；多仓库见 `docs/impl-multi-repo.md` §4 W1-B）。
 *
 * ```
 * 1. 原始 body（Fastify raw body parser，不能用 JSON parser，否则 HMAC 对不上）
 * 2. 验签 → 失败 401 且记审计
 * 3. INSERT webhook_deliveries … ON CONFLICT DO NOTHING   ← 主幂等点
 * 4. rowCount = 0 → 200 duplicate（GitHub 重投是常态，不是异常）
 * 4.5 ★ 项目解析：安装事件白名单 → repos 行 → installation 准入 → 未知仓库审计
 * 5. 判定是否需要处理（事件/action 白名单 + 仓库开关 + 两级熔断/暂停）
 * 6. INSERT tasks（command / actor_login / queued_at 在这一步写死，F9）
 * 7. boss.send('run-task', …)（singletonKey = taskId）
 * 8. ★ 10 秒应答在 handler 内：入队成功后立刻打 eyes reaction
 * 9. 200，全程 < 2s
 * ```
 *
 * 三条落地要点：
 *  - **幂等只在数据库**：投递级（`webhook_deliveries.delivery_id`）+ 任务级（`tasks.idempotency_key`）
 *    两个唯一索引，没有内存去重表。
 *  - **第 8 步不排队**：`await` 在 handler 里完成，失败只 `warn`（回应失败不该让 GitHub 重投一次）。
 *  - **无感反馈**（§0.4）：回执只有 reaction，「已收到」评论与 `ackStyle` 分支已删除；
 *    dry-run 时一个 GitHub 写动作都不发。
 *
 * 多仓库改造后的两条关键判定（都在第 4.5 步，`docs/impl-multi-repo.md` §4 W1-B 第 1/2 条）：
 *  - **installation 准入**：仓库行上的 `installation_id` 与载荷里的 `installation.id` 不一致 →
 *    `ignored:installation-mismatch`。这挡住「同一个仓库被另一个 App 安装接管」的串台；
 *  - **未知仓库不静默**：`repos` 没有这一行时记 warn，并把 `repo` 写进 `webhook_deliveries.repo`
 *    （0003 新增的审计列），仍然回 200 `ignored`（GitHub 只认 2xx）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { Webhooks } from '@octokit/webhooks';
import {
  DEFAULT_TRIGGER_ALIASES,
  parseTriggerBody,
  resolveTriggerAliases,
  type ErrorBody,
  type RepoConfig,
  type WebhookAcceptedResponse,
} from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import type { FastifyRequest } from 'fastify';
import {
  PIPELINE_GATE_NOTICE_INTERVAL_SECONDS,
  PIPELINE_LIMITS,
  PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS,
  PIPELINE_SUPPLEMENT_MAX_ITEMS,
  PIPELINE_TARGET_BODY_MAX_CHARS,
} from '../config/pipeline-constants.ts';
import { readRepoPolicy, upsertRepo } from '../config/repo-config.ts';
import type { RepoPolicy, SqlRunner } from '../config/repo-config.ts';
import { splitRepo } from '../github/index.ts';
import type { GithubClient } from '../github/index.ts';
import {
  RUNTIME_FLAG_SQL,
  buildIdempotencyKey,
  enqueueTask,
  installationPauseKey,
  isPauseFlagActive,
} from '../queue/index.ts';
import type { QueueBoss, RunTaskJobData } from '../queue/index.ts';
import { describeDirective, isPipelineManager, parsePipelineDirective } from '../workflows/pipeline-directives.ts';
import {
  applyTransition,
  bareIssueVersion,
  createReadyRow,
  decideTransition,
  ensurePipeline,
  gateNoticeAllowed,
  loadPipeline,
  recheckCooldownElapsed,
} from '../workflows/pipeline.ts';
import type {
  PipelineEvent,
  PipelineRow,
  PipelineTransition,
  SupplementActor,
} from '../workflows/pipeline.ts';
import { errorBodyOf } from './errors.ts';
import type { ZodFastify } from './types.ts';

export const WEBHOOK_SQL = {
  /**
   * 投递级幂等。`signature_valid` 由调用方给：验签失败也落库（审计要求），但不入队。
   * `repo`（$4）是**第 4.5 步的审计列**：载荷里有 `repository.full_name` 就写进来，
   * 包括「repos 没有这一行」的未知仓库投递——排查「哪一次投递没被处理」时只能靠它。
   */
  insertDelivery: `INSERT INTO "webhook_deliveries" ("delivery_id", "event", "action", "repo", "payload", "signature_valid")
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT ("delivery_id") DO NOTHING
RETURNING "delivery_id"`,
  readDelivery: `SELECT "signature_valid" FROM "webhook_deliveries" WHERE "delivery_id" = $1`,
  /** 同一 delivery 先前验签失败、这次通过：把标记翻正后继续处理（不是重复投递）。 */
  markSignatureValid: `UPDATE "webhook_deliveries" SET "signature_valid" = true WHERE "delivery_id" = $1`,
  /**
   * 建任务。`target_title` / `target_body` / `target_supplement` 是**入队时快照**（§4.2）：
   * 阶段任务可能在 `awaiting_info` 里等好几天，而 `webhook_deliveries.payload` 只留 90 天。
   */
  insertTask: `INSERT INTO "tasks" ("id", "source", "repo", "target_kind", "target_number", "head_sha", "command", "actor_login", "queued_at", "idempotency_key", "status", "delivery_id", "prompt_text", "target_title", "target_body", "target_supplement")
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, 'queued', $10, $11, $12, $13, $14::jsonb)
ON CONFLICT ("idempotency_key") DO NOTHING
RETURNING "id"`,
  findTaskByIdempotencyKey: `SELECT "id" FROM "tasks" WHERE "idempotency_key" = $1`,
  /**
   * 最近一条 issue 任务的正文快照。
   *
   * 评论补充重跑时要**整体替换** `target_supplement`（不是丢掉旧数组）：置顶的补充段
   * 要连续累积最近 3 条（§16.2 第 2 条），历史只能从「上一条任务」里读回来。
   */
  latestTargetSnapshot: `SELECT "target_title", "target_body", "target_supplement"
FROM "tasks"
WHERE "repo" = $1 AND "target_kind" = 'issue' AND "target_number" = $2
ORDER BY "queued_at" DESC, "id" DESC
LIMIT 1`,
  /** `replay` 的数据源：原文 90 天内都在（§5.3 第 3 步）。 */
  readPayload: `SELECT "event", "payload" FROM "webhook_deliveries" WHERE "delivery_id" = $1`,
  /** 安装事件：按 installation 批量禁用（`installation.deleted` / `installation_repositories.removed`）。 */
  disableInstallationRepos: `UPDATE "repos"
SET "enabled" = false, "updated_at" = now()
WHERE "installation_id" = $1 AND "repo_full_name" = ANY($2::text[])
RETURNING "repo_full_name"`,
  /** 安装事件：整个 installation 的仓库全禁用（`installation.deleted`）。 */
  disableInstallationAll: `UPDATE "repos"
SET "enabled" = false, "updated_at" = now()
WHERE "installation_id" = $1
RETURNING "repo_full_name"`,
} as const;

/** 请求头（我们只依赖这三个，见契约 §9）。 */
export const WEBHOOK_HEADERS = {
  delivery: 'x-github-delivery',
  event: 'x-github-event',
  signature: 'x-hub-signature-256',
} as const;


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
 * 触发别名集合：接受单个句柄（兼容旧签名）或别名数组。
 *
 * 判定统一交给 `parseTriggerBody()`（`packages/contract/src/trigger.ts`）：大小写不敏感、
 * 代码块内不触发、`foo@ibot` 不误命中、命令参数不丢。
 */
export function triggerAliasList(input: string | readonly string[] | undefined): readonly string[] {
  if (input === undefined) {
    return [DEFAULT_BOT_MENTION];
  }
  return typeof input === 'string' ? [input] : input;
}

/**
 * 从评论里取「纯 @ 提问」的正文：@ 到了别名、**没有** `/命令`、正文非空。
 *
 * 返回 `null` 表示这条评论不是自由提问（交给命令通道或直接忽略）。
 */
export function extractFreeQuestion(
  body: unknown,
  aliases: string | readonly string[] = DEFAULT_BOT_MENTION,
): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const parsed = parseTriggerBody(body, triggerAliasList(aliases));
  return parsed.kind === 'question' ? parsed.question : null;
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

/** 要打的 reaction 内容（GitHub 支持的四种；`confused` 用于失败/超时/取消）。 */
export type ReactionContent = 'eyes' | 'rocket' | 'confused' | 'heart';

/**
 * 「收到了」这一步（第 8 步）的 GitHub 写动作。干跑时**一个都不调**。
 *
 * **只有 reaction，没有评论**（`docs/impl-multi-repo.md` §0.4「无感反馈」）：
 * 原来的 `postAckComment`（「已收到 …，排队中……」）已删除，`ackStyle` 分支随之消失。
 */
export type WebhookAck = {
  /** `POST /repos/:o/:r/issues/:n/reactions { content: 'eyes' }` */
  addEyesReaction(input: {
    readonly repo: string;
    readonly issueNumber: number;
    /** 触发评论的 databaseId；给了就打评论级 reaction，缺省回落 issue 级。 */
    readonly commentId?: number | null;
  }): Promise<void>;
  /**
   * 任意 reaction（同一条 REST 通道，只是 `content` 不同）。
   *
   * 为什么做成**可选**方法：完整的 reaction 状态机（入队 eyes → 终态 rocket/confused、
   * `issue_feedback` 幂等台账）归 W2-D 的 `feedback/`；W1-B 只在闸门/超时这类
   * 「任务没跑起来」的路径上需要打 `confused`。可选 = 老装配不必立刻实现，
   * 缺它时调用方降级成 warn（不是错误）。形状与 `queue/queue-gate.ts` 的
   * `QueueGateReactionPort.addReaction` 一致，真实的 ack 对象可以两处复用。
   */
  addReaction?(input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId?: number | null;
    readonly content: ReactionContent;
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
  /**
   * 熔断/暂停判定（两级 + 安装级）。默认实现读 `runtime_flags`：
   *  - 全局行 `rate_limit_pause`（`repo IS NULL`）→ 停全部；
   *  - 仓库行 `rate_limit_pause`（`repo = 'owner/name'`）→ 只停这个仓库；
   *  - `pause:installation:<id>`（全局行）→ 停整个安装（`installation.suspend` 写的）。
   *
   * 注入时收到已解析出的仓库（安装事件 / 仓库未解析时是 `null`）；
   * 零参数实现照样可赋值（老签名兼容）。
   */
  readonly isPaused?: (repo: string | null) => Promise<boolean>;
  /** 部署默认触发别名（仓库配置里的 `triggers` 与它按规则合并）。 */
  readonly aliases?: readonly string[];
  /** 兼容旧签名：单个句柄（等价于只给一个别名）。 */
  readonly mention?: string;
  /**
   * 当前可用的上传技能名（`['/demo']`）。`/命令` 的门禁靠它放行面板上传的技能；
   * 不注入 → 只认仓库配置 `commands.allowed`。
   */
  readonly listSkills?: (repo: string) => Promise<readonly string[]>;
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

/** 补充评论的一条（`tasks.target_supplement` 的元素，§16.2 第 2 条）。 */
export type TaskSupplement = {
  readonly commentId: number | null;
  readonly author: string;
  readonly body: string;
  /** ISO8601（jsonb 里只放字符串：面板侧统一按 UTC 解析） */
  readonly at: string;
};

export type WebhookTaskPlan = {
  /**
   * 落 `tasks.command`：
   *  - 人工通道：`/review-pr` / `@answer`；
   *  - 流水线阶段任务：`pipeline:format` / `pipeline:classify` / `pipeline:notice`（§4.6）。
   */
  readonly command: string;
  /** 幂等键的 kind：`command:/review-pr` / `answer:<hash>` / `pipeline` / `notice`。 */
  readonly kind: string;
  /** `tasks.source`：只有 `command`（人工）与 `pipeline`（固定流水线）能写回评论（§4.6）。 */
  readonly source: 'webhook' | 'command' | 'pipeline';
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha: string | null;
  /**
   * 任务级幂等锚（进 `buildIdempotencyKey` 的 `anchor`）：
   *  - 流水线：`pipeline:<stage>:<issueVersion>[:<commentId>]`（§4.6 / §16.2 第 3 条）；
   *  - 人工命令：`null`（锚走 `headSha` / `none`）。
   */
  readonly issueVersionHash: string | null;
  readonly actorLogin: string;
  readonly association: string | null;
  /** 触发评论的 databaseId（评论级回执用；issue/PR 事件为 `null`）。 */
  readonly commentId: number | null;
  /** 自由问答的问题正文（落 `tasks.prompt_text`；其它任务为 `undefined`）。 */
  readonly promptText?: string;
  /**
   * 幂等键里的触发者。流水线任务固定写 `'pipeline'`：同一份内容被不同的人触发
   * 也必须落到同一个键上（`trigger_actor` 是给人工 `/retry` 与 webhook 重投区分用的）。
   */
  readonly idempotencyActor?: string;
  /** 入队时快照的标题 / 正文（§4.2；流水线任务才有）。 */
  readonly targetTitle?: string | null;
  readonly targetBody?: string | null;
  /** 补充评论段（最近 3 条、每条 ≤1000 字符）；评论补充重跑时**整体替换**这个数组。 */
  readonly supplements?: readonly TaskSupplement[];
};

/**
 * 「这条普通评论可能是补信息」的判定结果（§16.2 第 1 条，E4 评论优先通道）。
 *
 * 为什么不在 `decideWebhookTask` 里直接决定要不要入队：那是纯函数、**不许查库**，
 * 而「要不要重跑」取决于 `issue_pipeline.stage/state`（只有 `format/awaiting_info` 重跑）。
 * 所以这里只把载荷整理好，`handleWebhook` 查完状态行再决定。
 */
export type PipelineSupplementDecision = {
  readonly action: 'pipeline-supplement';
  readonly targetNumber: number;
  readonly isPullRequest: boolean;
  readonly actorLogin: string;
  readonly association: string | null;
  readonly commentId: number | null;
  /** 评论正文（原文，截断留到拼 `target_supplement` 时做） */
  readonly body: string;
  /** issue 版本（`issue.updated_at` 派生）：评论补充的锚要再追加 `:<commentId>` */
  readonly issueVersion: string;
  /** 顺便带上 issue 的标题 / 正文（comment 载荷里就有，省一次 API 调用） */
  readonly title: string | null;
  readonly issueBody: string | null;
  /** issue 作者的 login（判定「作者补充」vs「路人评论」，§16.2 第 1 条） */
  readonly issueAuthor: string | null;
};

export type WebhookDecision =
  | { readonly action: 'task'; readonly plan: WebhookTaskPlan }
  | { readonly action: 'ignore'; readonly reason: string }
  | PipelineSupplementDecision;

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

/** 从评论正文里取命令（`@ibot /review-pr`）；没有则 `null`。 */
export function extractCommand(
  body: unknown,
  aliases: string | readonly string[] = DEFAULT_BOT_MENTION,
): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const parsed = parseTriggerBody(body, triggerAliasList(aliases));
  return parsed.kind === 'command' ? parsed.command : null;
}

/** 机器人账号（`type: 'Bot'`）无论 association 一律忽略（plan §6.4）。 */
function isBotActor(user: Record<string, unknown> | null): boolean {
  return readString(user, 'type') === 'Bot';
}

/**
 * 事件/action 白名单 → 要不要建任务、建什么任务。
 *
 * 覆盖范围有意收窄（其余事件一律 `ignored`，但仍落 `webhook_deliveries` 供审计）：
 *  - `issue_comment.created` 且正文里有 `@pi-bot /cmd` → 命令任务（PR 或 issue）；
 *  - `issue_comment.created` 且是「纯 @ 提问」→ 自由问答任务（PR 或 issue）；
 *  - `issue_comment.created` 且**既没命令也没 @**（issue）→ `pipeline-supplement`（补充信息候选，§16.2）；
 *  - `issues.opened|edited|reopened` → `pipeline:format` 阶段任务（E1 全量切换，§16.1 第 2 条）；
 *  - 其余（含 `pull_request.*`、`push`、`label`…）→ 不建任务。PR 的审查由命令触发（plan §6.4）。
 *
 * `issues.closed` 不在这里判定：它只推进状态机（不建任务），由 `handleWebhook` 单独处理。
 */
export function decideWebhookTask(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  /** 触发别名（裸名，大小写不敏感）；缺省用部署默认 `pi-bot`。 */
  readonly aliases?: readonly string[];
  /** 兼容旧签名：单个句柄。与 `aliases` 同时给时以 `aliases` 为准。 */
  readonly mention?: string;
  /**
   * 是否把「纯 @ 提问」（不带 `/命令`）也当成任务（`PI_BOT_FREE_MENTION`，默认开）。
   * 关掉时只有 `@别名 /命令` 会建任务。
   */
  readonly freeMention?: boolean;
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
    const aliases = triggerAliasList(input.aliases ?? input.mention);

    const command = extractCommand(comment?.['body'], aliases);
    // 纯 @ 提问（没有 `/命令`）：走自由问答通道，问题正文落 `tasks.prompt_text`
    const question =
      command === null && input.freeMention === true ? extractFreeQuestion(comment?.['body'], aliases) : null;
    if (command === null && question === null) {
      // §16.2 第 1 条（E4 评论优先）：**普通评论不再一律 ignored**。
      // 只有 issue（PR 不受流水线影响）且正文非空时交回给 `handleWebhook` 查状态行，
      // 由它判断「stage/state 是否在等补充信息」。这里不查库（纯函数）。
      const body = readString(comment, 'body');
      if (isPullRequest || body === null || body.trim() === '') {
        return { action: 'ignore', reason: `评论里没有 @${aliases.join(' / @')} 命令` };
      }
      return {
        action: 'pipeline-supplement',
        targetNumber: number,
        isPullRequest,
        actorLogin: login,
        association: readString(comment, 'author_association'),
        commentId: readNumber(comment, 'id'),
        body,
        issueVersion: issueVersionHash(issue?.['updated_at']),
        title: readString(issue, 'title'),
        issueBody: readString(issue, 'body'),
        issueAuthor: readString(asRecord(issue?.['user']), 'login'),
      };
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
      // 回执统一走 eyes reaction（§0.4：自动通道零评论，没有第二种回执形态）
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
    const version = issueVersionHash(issue?.['updated_at']);
    // E1 全量切换：issue 事件一律入流水线（老的判定分支已删除，不保留灰度判断）
    return {
      action: 'task',
      plan: {
        command: 'pipeline:format',
        kind: 'pipeline',
        source: 'pipeline',
        targetKind: 'issue',
        targetNumber: number,
        headSha: null,
        // 幂等锚的原料 = **裸 issueVersion**（`sha256(updated_at)` 前 16 位）；
        // 锚（`pipeline:format:<issueVersion>`）只由入队处拼一次 —— 这里若写带前缀的锚，
        // `issue_pipeline.issue_version` 会存成 `pipeline:format:x`，`enqueueStageTask()`
        // 再拼一次就得到 `pipeline:classify:pipeline:format:x`（同一个 issue 两种锚）。
        // `issues.edited` 追加编辑标识（同一版本重复投递必须幂等，编辑之后必须产生新任务）
        issueVersionHash: input.action === 'edited' ? `${version}:edit` : version,
        actorLogin,
        association: readString(issue, 'author_association'),
        commentId: null,
        // 同一份内容被不同人触发也落到同一个键（`trigger_actor` 进键会破坏「同版本只跑一次」）
        idempotencyActor: 'pipeline',
        targetTitle: readString(issue, 'title'),
        targetBody: readString(issue, 'body'),
        supplements: [],
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
  /** 面板上传且已启用的技能名（`['/demo']`）：它们不进仓库配置，但同样是合法命令。 */
  knownSkills: readonly string[] = [],
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
  // 自由问答（`@answer:<base64>`）不是配置里的命令名，但同样受 enabled/association 约束；
  // 面板上传的技能同理：**仓库配置不必为它改一行**（spec D0「上传即生效」）。
  const isFreeAnswer = isFreeAnswerCommand(plan.command);
  const isKnownSkill = knownSkills.includes(plan.command);
  if (!isFreeAnswer && !isKnownSkill && !config.commands.allowed.includes(plan.command)) {
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
    triggerActor: plan.idempotencyActor ?? plan.actorLogin,
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

/* ── 第 4.5 步：项目解析 / 暂停 / 安装事件 ─────────────────────────────────── */

/** 全局熔断/暂停的 flag key（`runtime_flags.key`，与 `RUNTIME_FLAG_KEY.rateLimitPause` 同值）。 */
const PAUSE_FLAG_KEY = 'rate_limit_pause';

/** 载荷里的「哪个项目、哪个安装」。两个都可能缺（安装事件没有仓库，手动事件可能没有安装）。 */
export type ProjectRef = {
  /** `repository.full_name`（`owner/name`） */
  readonly repo: string | null;
  /** `installation.id`，十进制字符串（与 `repos.installation_id` 的 bigint 同型） */
  readonly installationId: string | null;
};

/** bigint 型 id → 十进制字符串（pg 给字符串，webhook 载荷给数字，两种都要收）。 */
function idStringOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.trim();
  }
  return null;
}

/**
 * 从载荷里取项目与安装（**第 4.5 步的唯一入口**）。
 *
 * 只认 `repository.full_name`（§0.1：项目 = 仓库，不引入 projects 表）；
 * 安装事件没有 `repository`，它们的仓库列表在 `repositories*` 数组里，由
 * `applyInstallationEvent()` 自己遍历。
 */
export function projectRefOf(payload: unknown): ProjectRef {
  const record = asRecord(payload);
  return {
    repo: readString(asRecord(record?.['repository']), 'full_name'),
    installationId: idStringOf(asRecord(record?.['installation'])?.['id']),
  };
}

/** 一次读多条**全局**flag（`repo IS NULL`），返回 key → row。 */
async function readGlobalFlags(
  db: SqlRunner,
  keys: readonly string[],
): Promise<Map<string, { value: string; until: Date | null }>> {
  const flags = new Map<string, { value: string; until: Date | null }>();
  if (keys.length === 0) {
    return flags;
  }
  const result = await db.query(RUNTIME_FLAG_SQL.readMany, [keys]);
  for (const item of result.rows) {
    const row = item as Record<string, unknown>;
    const key = row['key'];
    if (typeof key !== 'string') {
      continue;
    }
    flags.set(key, {
      value: typeof row['value'] === 'string' ? row['value'] : '',
      until: row['until'] instanceof Date ? row['until'] : null,
    });
  }
  return flags;
}

/** 仓库级暂停（`runtime_flags` 的仓库行：迁移 0003 新增的 `repo` 列）。 */
async function repoPauseFlag(
  db: SqlRunner,
  repo: string,
): Promise<{ value: string; until: Date | null } | null> {
  const result = await db.query(RUNTIME_FLAG_SQL.readRepo, [PAUSE_FLAG_KEY, repo]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    value: typeof row['value'] === 'string' ? row['value'] : '',
    until: row['until'] instanceof Date ? row['until'] : null,
  };
}

/**
 * 现在谁在暂停：`global` / `installation` / `repo` / `null`（没暂停）。
 *
 * 三级都读 `runtime_flags`（全局行一次查完，仓库行只在必要时多查一次）：
 *  - `rate_limit_pause` + `repo IS NULL` → 全局熔断（5 次/15min 触发）；
 *  - `pause:installation:<id>` + `repo IS NULL` → 安装被 suspend（GitHub 侧或人工停用）；
 *  - `rate_limit_pause` + `repo = 'owner/name'` → 单仓库熔断（3 次/10min 触发）。
 */
async function pauseScopeOf(
  db: SqlRunner,
  now: Date,
  project: ProjectRef,
): Promise<'global' | 'installation' | 'repo' | null> {
  const keys: string[] = [PAUSE_FLAG_KEY];
  if (project.installationId !== null) {
    keys.push(installationPauseKey(project.installationId));
  }
  const flags = await readGlobalFlags(db, keys);
  if (isPauseFlagActive(flags.get(PAUSE_FLAG_KEY) ?? null, now)) {
    return 'global';
  }
  if (
    project.installationId !== null &&
    isPauseFlagActive(flags.get(installationPauseKey(project.installationId)) ?? null, now)
  ) {
    return 'installation';
  }
  if (project.repo !== null && isPauseFlagActive(await repoPauseFlag(db, project.repo), now)) {
    return 'repo';
  }
  return null;
}

/**
 * 安装事件白名单（§4 W1-B 第 2 条）。
 *
 * 这些事件的 payload **没有 `repository`**，只能按 `installation.id` 定位仓库：
 *  - `installation.created` → 把载荷里的 `repositories[]` 建成 `repos` 行；
 *  - `installation_repositories.added` → 同上，列表字段是 `repositories_added[]`；
 *  - `installation_repositories.removed` / `installation.deleted` → 按 installation_id 批量 `enabled=false`；
 *  - `installation.suspend|unsuspend` → 写 `runtime_flags{pause:installation:<id>, repo:NULL}`。
 */
export const INSTALLATION_EVENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  installation: Object.freeze(['created', 'deleted', 'suspend', 'unsuspend']),
  installation_repositories: Object.freeze(['added', 'removed']),
});

/** `event.action` 是否在安装事件白名单里。 */
export function isInstallationEvent(event: string, action: string | null): boolean {
  if (action === null) {
    return false;
  }
  const actions = INSTALLATION_EVENTS[event];
  return actions !== undefined && actions.includes(action);
}

/** 安装事件载荷里的仓库数组 → `owner/name` 列表（元素形如 `{ full_name }`）。 */
function fullNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const item of value) {
    const name = readString(asRecord(item), 'full_name');
    if (name !== null) {
      names.push(name);
    }
  }
  return names;
}

/** 安装事件的处理结果（进日志；安装事件不建任务，所以不参与响应体的 action）。 */
export type InstallationOutcome = {
  /** 是否是可识别的安装事件（否则调用方按普通忽略处理） */
  readonly handled: boolean;
  /** 一句话结论（`created:2` / `deleted:5` / `suspend:pause:installation:42` …） */
  readonly detail: string;
  /** 影响的仓库行数（`repos`）/ flag 行数（`runtime_flags`） */
  readonly changed: number;
};

/**
 * 处理安装事件：建行 / 禁用 / 暂停。
 *
 * 三条刻意的取舍：
 *  - **新装的仓库 `enabled=false, dry_run=true`**（§4 W1-B 第 2 条）：装了 App 不等于马上自动开工，
 *    面板里把开关打开才接活；默认 settings 来自 `PI_BOT_DEFAULT_SETTINGS`（`upsertRepo` 内部 seed）；
 *  - **重建行不覆盖已有配置**：`upsertRepo` 的 `ON CONFLICT` 只补 `source/installation_id`，
 *    重新安装 App 不该把面板里调好的 triggers/labels 冲掉；
 *  - **removed/deleted 只禁不删**：删行会丢成本与审计历史（禁用即可，历史仍可查）。
 */
async function applyInstallationEvent(
  deps: WebhookDeps,
  args: {
    readonly event: string;
    readonly action: string | null;
    readonly payload: unknown;
    readonly installationId: string | null;
    readonly now: Date;
    readonly log: Logger;
  },
): Promise<InstallationOutcome> {
  const { event, action, payload, installationId, now, log } = args;
  if (installationId === null) {
    log.warn({ event, action }, '安装事件缺少 installation.id，忽略');
    return { handled: true, detail: 'missing-installation-id', changed: 0 };
  }
  const record = asRecord(payload);

  // added / created → 建行（enabled=false, dry_run=true, source='installation'）
  if (action === 'created' || action === 'added') {
    const list = action === 'added' ? record?.['repositories_added'] : record?.['repositories'];
    const repos = fullNamesOf(list);
    let changed = 0;
    for (const repo of repos) {
      try {
        const result = await upsertRepo(deps.db, {
          repo,
          source: 'installation',
          installationId,
          enabled: false,
          dryRun: true,
        });
        if (!result.ok) {
          // 默认 settings 不合法是部署问题（`PI_BOT_DEFAULT_SETTINGS` 写错），不是这条事件的问题
          log.error({ repo, err: result.error }, '安装事件建行失败：默认配置不合法');
          continue;
        }
        changed += 1;
      } catch (error) {
        log.error({ repo, err: describeError(error) }, '安装事件建行失败');
      }
    }
    return { handled: true, detail: `${String(action)}:${String(changed)}`, changed };
  }

  // removed → 只禁掉这次被移除的那几个仓库
  if (action === 'removed') {
    const repos = fullNamesOf(record?.['repositories_removed']);
    if (repos.length === 0) {
      // 载荷没给列表时保守处理：整个 installation 一并禁用（宁可多禁，也别让已卸载的仓库继续接活）
      const result = await deps.db.query(WEBHOOK_SQL.disableInstallationAll, [installationId]);
      return { handled: true, detail: 'removed:all', changed: result.rowCount ?? result.rows.length };
    }
    const result = await deps.db.query(WEBHOOK_SQL.disableInstallationRepos, [installationId, repos]);
    return {
      handled: true,
      detail: `removed:${String(repos.length)}`,
      changed: result.rowCount ?? result.rows.length,
    };
  }

  // deleted → 整个 installation 的仓库全禁用（不删行：成本与审计历史要留）
  if (action === 'deleted') {
    const result = await deps.db.query(WEBHOOK_SQL.disableInstallationAll, [installationId]);
    return { handled: true, detail: 'deleted', changed: result.rowCount ?? result.rows.length };
  }

  // suspend / unsuspend → 全局作用域的安装级暂停开关（repo = NULL）
  const key = installationPauseKey(installationId);
  const active = action === 'suspend';
  await deps.db.query(RUNTIME_FLAG_SQL.upsert, [
    key,
    active ? '1' : '0',
    // suspend 不过期（人工开关，`until = null` 在读侧等于「一直有效」）；
    // unsuspend 写一个过去时间而不是删行（`runtime_flags` 只增不删）
    active ? null : new Date(now.getTime() - 1000),
  ]);
  return { handled: true, detail: `${String(action)}:${key}`, changed: 1 };
}

/**
 * installation 准入（§4 W1-B 第 1 条）：仓库行属于某个安装、投递却来自另一个安装 → 拒绝。
 *
 * 三种不该拦的情况：
 *  - 仓库行没有 `installation_id`（`source='manual'`，面板手动加的仓库）：谁投递都收；
 *  - 投递里没有 `installation`（老格式 / replay 的旧原文）：放行，不因为缺信息就丢事件；
 *  - 两边一致：正常路径。
 */
function installationMismatch(policy: RepoPolicy, incoming: string | null): string | null {
  if (policy.installationId === null || incoming === null || policy.installationId === incoming) {
    return null;
  }
  return `installation 不匹配：仓库记录 installation_id=${policy.installationId}，本次投递来自 ${incoming}`;
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

  // 载荷里的「哪个项目、哪个安装」：第 4.5 步的判定依据，也进投递行的 `repo` 审计列
  const project = projectRefOf(payload);
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
        project.repo,
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
      project.repo,
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

  // ── 第 4.5 步 ⓐ：安装事件白名单 ──────────────────────────────────────────
  // 这些事件的 payload **没有 `repository`**，所以必须在 `repo === null` 分支之前拦下，
  // 否则「装了两个仓库」永远落不了库（GitHub 只在安装时才发这几条事件）。
  if (isInstallationEvent(input.event, action)) {
    const outcome = await applyInstallationEvent(deps, {
      event: input.event,
      action,
      payload,
      installationId: project.installationId,
      now: now(),
      log,
    });
    // 契约的响应枚举里没有「installation」一档：安装事件统一回 200 `ignored`
    // （它确实没建任务），审计靠 `webhook_deliveries` 与日志里的 detail。
    log.info({ action, detail: outcome.detail, changed: outcome.changed }, '安装事件已处理');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  // ── 第 5 步：熔断 / 暂停（全局 → 安装 → 仓库，三级依次看）─────────────────
  const pauseScope =
    deps.isPaused === undefined
      ? await pauseScopeOf(deps.db, now(), project)
      : (await deps.isPaused(project.repo))
        ? 'external'
        : null;
  if (pauseScope !== null) {
    // 不丢事件、不占并发（契约 §9）：投递已落库，恢复后可用 replay 重放
    log.warn({ repo: project.repo, scope: pauseScope }, '熔断/暂停中，本次只记投递不入队');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'paused', taskId: null, duplicate: false, ackComment: null }));
  }

  // ── 第 4.5 步 ⓑ：项目解析（`repos` 行 + installation 准入）─────────────────
  const repo = project.repo;
  if (repo === null) {
    log.warn({ event: input.event, action }, '载荷缺少 repository.full_name（且不是安装事件），忽略');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  let policy: RepoPolicy;
  try {
    policy = await readRepoPolicy(deps.db, repo);
  } catch (error) {
    log.error({ repo, err: describeError(error) }, '读取仓库策略失败');
    return finish(500, errorBodyOf('internal', '读取仓库配置失败'));
  }

  // 未知仓库**不再静默**：`repo` 已在第 3 步写进 `webhook_deliveries.repo`，
  // 这里再记一条 warn，运维照 `delivery_id` 就能找到「哪次投递没被处理、属于哪个仓库」。
  if (!policy.known) {
    log.warn({ repo, reason: 'unknown-repo' }, '未知仓库（repos 没有这一行）：已记审计，忽略本次投递');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  // installation 准入：仓库属于 A 安装、投递却来自 B 安装 → 拒绝（否则会用错 token 干活）
  const mismatch = installationMismatch(policy, project.installationId);
  if (mismatch !== null) {
    log.warn(
      {
        repo,
        reason: 'installation-mismatch',
        expected: policy.installationId,
        actual: project.installationId,
      },
      mismatch,
    );
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  if (!policy.enabled || !policy.settingsValid) {
    log.warn(
      { repo, enabled: policy.enabled, settingsValid: policy.settingsValid, reason: 'repo-unusable' },
      '仓库已禁用或配置非法，忽略',
    );
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  const deploymentAliases =
    deps.aliases ??
    [...DEFAULT_TRIGGER_ALIASES, DEFAULT_BOT_MENTION, ...(deps.mention === undefined ? [] : [deps.mention])];
  const aliases = resolveTriggerAliases({
    configured: policy.settings?.triggers,
    deployment: deploymentAliases,
  });
  const at = now();
  const dryRun = policy.dryRun || input.forcedDryRun === true;

  // ── 第 5.5 步 ⓐ：管理员指令（`/recheck`、`/pipeline next|prev`，§1.7 Q7 / §8 / §12 V20）──
  // **不进命令门禁**：流水线走独立分支（§16.1 第 3 条），`commands.enabled` / 白名单 / 关联白名单
  // 都管不到它；权限由 `settings.pipeline.managers` + `author_association='OWNER'` 单独判。
  const directive = await runDirective({
    db: deps.db,
    repo,
    event: input.event,
    action,
    payload,
    aliases,
    settings: policy.settings,
    at,
    dryRun,
    log,
  });
  if (directive !== null) {
    if (directive.kind === 'ignored') {
      log.info({ repo, reason: directive.reason }, '管理员指令未执行');
      // 被拒的指令只打 eyes，**不执行、不回复**（§1.7 Q7）
      await reactQuietly(deps, {
        dryRun,
        repo,
        issueNumber: directive.plan.targetNumber,
        commentId: directive.plan.commentId,
        log,
      });
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    if (directive.kind === 'duplicate') {
      log.info({ repo, taskId: directive.taskId }, '管理员指令：阶段任务已存在（幂等命中）');
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'duplicate', taskId: directive.taskId, duplicate: true, ackComment: null }));
    }
    // 指令触发的阶段任务与其它任务走同一条入队通道
    try {
      const jobId = await deps.enqueue({ taskId: directive.taskId, command: directive.plan.command, repo });
      log.info({ repo, taskId: directive.taskId, command: directive.plan.command, jobId }, '管理员指令：阶段任务已入队');
    } catch (error) {
      log.error({ repo, err: describeError(error) }, '管理员指令：入队失败');
      return finish(500, errorBodyOf('internal', '任务入队失败'));
    }
    await reactQuietly(deps, {
      dryRun,
      repo,
      issueNumber: directive.plan.targetNumber,
      commentId: directive.plan.commentId,
      log,
    });
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'enqueued', taskId: directive.taskId, duplicate: false, ackComment: null }));
  }

  // ── `issues.closed`：只推进状态机，不建任务（§2 最后一行）────────────────────
  if (input.event === 'issues' && action === 'closed') {
    const closedNumber = readNumber(asRecord(asRecord(payload)?.['issue']), 'number');
    if (closedNumber !== null) {
      const closedKey = { repo, issueNumber: closedNumber };
      const closedRow = await loadPipeline(deps.db, closedKey);
      await applyTransition(deps.db, closedKey, decideTransition(closedRow, { kind: 'issue-closed', at }));
    }
    log.info({ repo }, 'issues.closed：状态机置 closed，不建任务');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  const decision = decideWebhookTask({
    event: input.event,
    action,
    payload,
    aliases,
    ...(deps.freeMention === undefined ? {} : { freeMention: deps.freeMention }),
  });
  if (decision.action === 'ignore') {
    log.info({ repo, reason: decision.reason }, '事件不在白名单，不建任务');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }
  // ── 第 5.5 步 ⓑ：补充评论（E4 评论优先，§16.2 第 1 条）────────────────────────
  let plan: WebhookTaskPlan;
  if (decision.action === 'pipeline-supplement') {
    const key = { repo, issueNumber: decision.targetNumber };
    const row = await loadPipeline(deps.db, key);
    const outcome = decideSupplementOutcome(row, decision, policy.settings);
    if (outcome.kind !== 'rerun') {
      log.info({ repo, issue: decision.targetNumber, reason: outcome.reason }, '普通评论不触发重跑');
      // §8：`pending` / `running` 只打 eyes；其余状态（`ready` / `blocked` / 无行）连 eyes 也不必
      if (outcome.kind === 'silent' && outcome.react) {
        await reactQuietly(deps, {
          dryRun,
          repo,
          issueNumber: decision.targetNumber,
          commentId: decision.commentId,
          log,
        });
      }
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    const supplementEvent: PipelineEvent =
      outcome.channel === 'classify'
        ? { kind: 'manager-comment', fromManager: true, at, issueVersion: decision.issueVersion }
        : {
            kind: 'supplement-comment',
            actor: outcome.actor,
            commentId: decision.commentId,
            at,
            issueVersion: decision.issueVersion,
          };
    const supplementTransition = decideTransition(row, supplementEvent);
    if (supplementTransition.ignore !== undefined) {
      log.info({ repo, issue: decision.targetNumber, reason: supplementTransition.ignore }, '补充评论被状态机忽略');
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    await applyTransition(deps.db, key, supplementTransition);
    plan = supplementPlanFor(decision, outcome.channel);
    // 正文快照：评论补充重跑时**整体替换** `target_supplement`（最近 3 条，含这一条）
    plan = await withTargetSnapshot(deps.db, repo, plan, {
      commentId: decision.commentId,
      author: decision.actorLogin,
      body: decision.body,
      at: at.toISOString(),
    });
    log.info({ repo, issue: decision.targetNumber, command: plan.command }, '评论补充：立即重跑（锚含 commentId）');
  } else {
    plan = decision.plan;
  }

  // ── 第 5.5 步 ⓒ：阶段闸门（§8 表格逐行；PR 完全不受影响）────────────────────
  if (plan.source === 'command' && plan.targetKind === 'issue') {
    const key = { repo, issueNumber: plan.targetNumber };
    const row = await loadPipeline(deps.db, key);
    const gateDecision = decideGateOutcome(row, at);
    if (gateDecision.kind === 'ignore') {
      log.info({ repo, issue: plan.targetNumber, reason: gateDecision.reason }, '流水线已关闭，忽略 @');
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    if (gateDecision.kind === 'silent') {
      // `pending` / `running`：只打 eyes，不回复（正在跑，回复是噪音）
      log.info({ repo, issue: plan.targetNumber }, '流水线跑动中：只打 eyes，不建命令任务');
      await reactQuietly(deps, {
        dryRun,
        repo,
        issueNumber: plan.targetNumber,
        commentId: plan.commentId,
        log,
      });
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    if (gateDecision.kind === 'notice') {
      // 被拦的命令**不建命令任务**（不进 `tasks`）；回执走轻量 `pipeline:notice`（Q8：AI 撰写）
      const noticePlan = noticePlanFor(plan, gateDecision.gateState, at);
      await applyTransition(deps.db, key, { gateNoticeAt: at });
      log.info(
        { repo, issue: plan.targetNumber, gateState: gateDecision.gateState },
        '流水线未 ready：命令被拦，改建 pipeline:notice',
      );
      // ★ 门禁回执**只产评论、绝不推状态**：这里立刻建 notice 任务并返回，
      // 绝不落到第 5.5 步 ⓓ —— 那里会用 `action='created'` 当成「issue 刚开」，
      // 把 `format/awaiting_info` / `classify/awaiting_info` / `blocked` 全部改写回
      // `format/pending`（`blocked_reason` 被清空、`issue_version` 被写成回执桶），
      // 症状就是「issue 永久卡在 format/pending，而门禁只打 eyes」。
      return await submitPlanTask(deps, {
        plan: noticePlan,
        repo,
        deliveryId: input.deliveryId,
        dryRun,
        log,
      });
    }
    if (gateDecision.kind === 'allow' && row === null) {
      // §1.3：无行 = 放行，并懒创建 `ready` 行（存量 issue 不该被闸门全拦）
      await createReadyRow(deps.db, key, at);
      log.info({ repo, issue: plan.targetNumber }, '无流水线行：放行并懒创建 agent/ready 行');
    }
  }

  // ── 第 5.5 步 ⓓ：issue 事件推进状态机（§2 前 12 行）──────────────────────────
  //
  // `plan.command !== 'pipeline:notice'` 是**双保险**（notice 分支上面已经 return）：
  // 门禁回执只产评论、绝不推状态。回执要是流到这里，`action='created'` 会被当成
  // 「issue 刚开」→ `decideTransition({kind:'issue-opened'})` 把 `awaiting_info` / `blocked`
  // 统统改写回 `format/pending`，issue 就永久卡死在第 0 阶段。
  if (
    decision.action === 'task' &&
    plan.source === 'pipeline' &&
    plan.command !== 'pipeline:notice'
  ) {
    const key = { repo, issueNumber: plan.targetNumber };
    const row = await loadPipeline(deps.db, key);
    const transition = pipelineTransitionFor(row, {
      action,
      issueVersion: plan.issueVersionHash,
      at,
    });
    if (transition.ignore !== undefined) {
      log.info({ repo, issue: plan.targetNumber, reason: transition.ignore }, '流水线状态机忽略本次事件');
      return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
    }
    if (row === null) {
      // §1.3 / §2 第 1 行：无行 → 建 `format/pending` 行
      await ensurePipeline(deps.db, key, {
        stage: transition.stage ?? 'format',
        state: transition.state ?? 'pending',
        issueVersion: plan.issueVersionHash,
      });
    }
    await applyTransition(deps.db, key, transition);
    // 正文快照（§4.2）：入队即定型，之后不再依赖 90 天保留期的投递原文
    plan = await withTargetSnapshot(deps.db, repo, plan);
  }

  return await submitPlanTask(deps, {
    plan,
    repo,
    deliveryId: input.deliveryId,
    dryRun,
    log,
    settings: policy.settings,
  });
}

/**
 * 第 6–9 步：建任务 → 入队 → eyes → 200（**唯一**的建任务通道）。
 *
 * 为什么从 `handleWebhook()` 里抽出来：门禁回执（`pipeline:notice`）必须在第 5.5 步 ⓒ
 * **立刻**走完这条通道并返回，绝不能落到 ⓓ 的状态机里（见 ⓓ 的注释）。抽成一个函数
 * 而不是复制一遍，是为了让「幂等 / dry-run / eyes」这三条行为只有一份实现。
 */
async function submitPlanTask(
  deps: WebhookDeps,
  input: {
    readonly plan: WebhookTaskPlan;
    readonly repo: string;
    readonly deliveryId: string;
    readonly dryRun: boolean;
    readonly log: Logger;
    /** 仓库配置（命令门禁用）；`null` = 配置不可用。流水线任务绕开门禁，传不传都不影响。 */
    readonly settings?: RepoConfig | null;
  },
): Promise<WebhookResult> {
  const { plan, repo, deliveryId, dryRun, log } = input;

  // 面板上传的技能也是「已知命令」：仓库配置 `commands.allowed` 只列了 git 里声明的命令，
  // 上传技能不该要求改仓库配置才能被调用（spec D0「上传即生效」）。
  const knownSkills =
    plan.source === 'command' && deps.listSkills !== undefined
      ? await deps.listSkills(repo)
      : [];
  // pipeline 任务**绕开**命令门禁：`source !== 'command'` 时 `checkCommandGate` 直接放行
  // （§16.1 第 3 条：`commands.enabled` / 白名单 / 关联白名单都管不到流水线）。
  const gate = checkCommandGate(plan, input.settings ?? null, knownSkills);
  if (!gate.allowed) {
    log.warn({ repo, command: plan.command, reason: gate.reason }, '命令门禁不通过');
    return { status: 200, body: accepted({ deliveryId, action: 'unauthorized', taskId: null, duplicate: false, ackComment: null }), elapsedMs: 0 };
  }

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
    deliveryId,
    plan.promptText ?? null,
    plan.targetTitle ?? null,
    truncateTargetBody(plan.targetBody),
    JSON.stringify(plan.supplements ?? []),
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
    return {
      status: 200,
      body: accepted({
        deliveryId,
        action: 'duplicate',
        taskId: typeof existingId === 'string' ? existingId : null,
        duplicate: true,
        ackComment: null,
      }),
      elapsedMs: 0,
    };
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
    return { status: 500, body: errorBodyOf('internal', '任务入队失败'), elapsedMs: 0 };
  }

  // ── 第 8 步：★ 10 秒应答就在 handler 内（不经过队列）──────────────────────
  if (dryRun) {
    taskLog.info('dry-run：跳过 reaction / 确认评论（不产生任何 GitHub 写动作）');
    return { status: 200, body: accepted({ deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment: null }), elapsedMs: 0 };
  }

  // 回执**只有 reaction**（§0.4）：命令 / 判定 / 自由问答一律 eyes 角标；
  // 「已收到 …，排队中……」的评论与 `ackStyle` 分支已经删除（自动通道零评论）
  try {
    await deps.ack.addEyesReaction({
      repo,
      issueNumber: plan.targetNumber,
      commentId: plan.commentId,
    });
    taskLog.info({ commentId: plan.commentId }, '已打 eyes reaction');
  } catch (error) {
    // 回应失败只记 warn：不该让 GitHub 因此重投一次（§5.3 七要点第三条）
    taskLog.warn({ err: describeError(error) }, '回应 GitHub 失败（不影响 200）');
  }

  // ── 第 9 步：200 ─────────────────────────────────────────────────────────
  return { status: 200, body: accepted({ deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment: null }), elapsedMs: 0 };
}

/* ── 流水线接入的帮手（第 5.5 步；导出便于单测逐条断言） ─────────────────── */

/**
 * 正文快照的截断（§4.2）。
 *
 * 截断处**显式标注**：提示词模板里写明了「正文可能被截断」，模型看到标注才知道
 * 「没看到全貌」而不是「就这么点内容」——否则格式检查会把一条长正文判成「缺信息」。
 */
export function truncateTargetBody(body: string | null | undefined): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (body.length <= PIPELINE_TARGET_BODY_MAX_CHARS) {
    return body;
  }
  return `${body.slice(0, PIPELINE_TARGET_BODY_MAX_CHARS)}\n\n…（正文已截断：原文 ${String(body.length)} 字符，任务只带前 ${String(PIPELINE_TARGET_BODY_MAX_CHARS)} 字符）`;
}

/** 一条补充评论 → `target_supplement` 的元素（每条截 1000 字符，§16.2 第 2 条）。 */
export function supplementOf(input: {
  readonly commentId: number | null;
  readonly author: string;
  readonly body: string;
  readonly at: string;
}): TaskSupplement {
  const body = input.body.trim();
  return {
    commentId: input.commentId,
    author: input.author,
    body:
      body.length <= PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS
        ? body
        : `${body.slice(0, PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS)}…`,
    at: input.at,
  };
}

/** 一条 issue 任务的正文快照（`tasks.target_*`）。 */
export type TargetSnapshot = {
  readonly title: string | null;
  readonly body: string | null;
  readonly supplements: readonly TaskSupplement[];
};

/** 读最近一条 issue 任务的快照；没有行 → 空快照（不是错误）。 */
export async function loadTargetSnapshot(
  db: SqlRunner,
  repo: string,
  issueNumber: number,
): Promise<TargetSnapshot> {
  const result = await db.query(WEBHOOK_SQL.latestTargetSnapshot, [repo, issueNumber]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return { title: null, body: null, supplements: [] };
  }
  const supplements: TaskSupplement[] = [];
  const raw = row['target_supplement'];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = asRecord(item);
      const body = readString(record, 'body');
      if (body === null) {
        continue;
      }
      supplements.push({
        commentId: readNumber(record, 'commentId'),
        author: readString(record, 'author') ?? 'unknown',
        body,
        at: readString(record, 'at') ?? '',
      });
    }
  }
  return {
    title: readString(row, 'target_title'),
    body: readString(row, 'target_body'),
    supplements,
  };
}

/**
 * 把正文快照挂到 plan 上。
 *
 * `supplement` 给定时**整体替换** `target_supplement`：新数组 = 历史（同 issue 上一条任务）
 * + 这一条，再取最近 3 条。历史来自「上一条任务」而不是「本次请求里累加」，
 * 所以同一份补充被重投两次也只会留下一条（幂等键另外再挡一次）。
 */
export async function withTargetSnapshot(
  db: SqlRunner,
  repo: string,
  plan: WebhookTaskPlan,
  supplement?: {
    readonly commentId: number | null;
    readonly author: string;
    readonly body: string;
    readonly at: string;
  },
): Promise<WebhookTaskPlan> {
  const snapshot = await loadTargetSnapshot(db, repo, plan.targetNumber);
  const supplements = [...snapshot.supplements];
  if (supplement !== undefined) {
    supplements.push(supplementOf(supplement));
  }
  return {
    ...plan,
    // 载荷里的正文比历史新（`issues.edited` 的时机就是「正文变了」），优先用它
    targetTitle: plan.targetTitle ?? snapshot.title,
    targetBody: plan.targetBody ?? snapshot.body,
    supplements: supplements.slice(-PIPELINE_SUPPLEMENT_MAX_ITEMS),
  };
}

/**
 * 补充评论触发的重跑任务（§16.2）。
 *
 * 锚 = `pipeline:<stage>:<issueVersion>:<commentId>`：同一条评论重投是空操作，
 * **换一条评论补同样的内容**要能重跑（只按版本锚会静默吞掉第二次补充）。
 *
 * 这里给的是锚的**原料**（裸 issueVersion + commentId），前缀由入队处拼一次（见 `idempotencyKeyFor`）。
 */
export function supplementPlanFor(
  decision: PipelineSupplementDecision,
  channel: 'format' | 'classify',
): WebhookTaskPlan {
  return {
    command: channel === 'format' ? 'pipeline:format' : 'pipeline:classify',
    kind: 'pipeline',
    source: 'pipeline',
    targetKind: 'issue',
    targetNumber: decision.targetNumber,
    headSha: null,
    issueVersionHash: `${decision.issueVersion}:${String(decision.commentId ?? 'none')}`,
    actorLogin: decision.actorLogin,
    association: decision.association,
    commentId: decision.commentId,
    idempotencyActor: 'pipeline',
    targetTitle: decision.title,
    targetBody: decision.issueBody,
    supplements: [],
  };
}

/** 补充评论要不要触发重跑（§16.2 第 1 条 / §1.8 Q6 修订）。 */
export type SupplementOutcome =
  | { readonly kind: 'rerun'; readonly channel: 'format' | 'classify'; readonly actor: SupplementActor }
  /** 正在跑：只打 eyes，不回复、不入队（§8 第一行） */
  | { readonly kind: 'silent'; readonly reason: string; readonly react: boolean }
  /** 不动：`ready` 之后由 Agent 自己处理（D7）/ 无行 / 已关闭 */
  | { readonly kind: 'ignore'; readonly reason: string };

/**
 * 一条普通评论该不该触发阶段重跑。
 *
 * 判定顺序（与 §16.2 / §1.8 一致，顺序本身是语义）：
 *  1. 无行 → 不动（存量 issue 等 `@` 再懒创建 `ready` 行）；
 *  2. `closed` → 不动；
 *  3. `pending` / `running` → 只打 eyes（正在跑）；
 *  4. `format/awaiting_info` + 作者或 managers → 重跑格式；
 *  5. `classify/awaiting_info` + **仅 managers** → 重跑分类（Q6 修订）；
 *  6. 其余（`ready` / `blocked`）→ 不动。
 */
export function decideSupplementOutcome(
  row: PipelineRow | null,
  decision: PipelineSupplementDecision,
  settings: RepoConfig | null,
): SupplementOutcome {
  if (row === null) {
    return { kind: 'ignore', reason: 'no-row' };
  }
  const actor: SupplementActor = isPipelineManager(settings, {
    login: decision.actorLogin,
    association: decision.association,
  })
    ? 'manager'
    : decision.issueAuthor !== null && decision.issueAuthor.toLowerCase() === decision.actorLogin.toLowerCase()
      ? 'author'
      : 'other';

  if (row.state === 'closed') {
    return { kind: 'ignore', reason: 'closed' };
  }
  if (row.state === 'pending' || row.state === 'running') {
    return { kind: 'silent', reason: `${row.stage}/running`, react: true };
  }
  if (row.stage === 'format' && row.state === 'awaiting_info') {
    // 作者与 managers 都能触发格式重跑；其他人只记录（§16.2 第 1 条）
    if (actor === 'other') {
      return { kind: 'ignore', reason: 'supplement-actor-not-allowed' };
    }
    return { kind: 'rerun', channel: 'format', actor };
  }
  if (row.stage === 'classify' && row.state === 'awaiting_info') {
    // 等管理员：只有 managers 的评论触发重分类（§1.8 Q6 修订）
    if (actor !== 'manager') {
      return { kind: 'ignore', reason: 'classify-awaiting-manager' };
    }
    return { kind: 'rerun', channel: 'classify', actor };
  }
  // `ready`（Agent 阶段自己响应 @）与 `blocked`（要 `/recheck --force`）
  return { kind: 'ignore', reason: `${row.stage}/${row.state}` };
}

/** 门禁处置（§8 表格逐行）。 */
export type GateOutcome =
  | { readonly kind: 'allow' }
  /** 只打 eyes，不回复（正在跑） */
  | { readonly kind: 'silent' }
  /** 入队 `pipeline:notice`（AI 撰写回执；限速内才有） */
  | { readonly kind: 'notice'; readonly gateState: string; readonly reason: string }
  | { readonly kind: 'ignore'; readonly reason: string };

/**
 * `@` 被闸门拦下时怎么处置（§8）：
 *
 * | 当前状态 | 行为 |
 * |---|---|
 * | `format/pending`、`classify/pending`、任一阶段的 `running` | 只打 `eyes` |
 * | `format/awaiting_info` | `pipeline:notice`（请先按上一条评论补充信息） |
 * | `classify/awaiting_info` | `pipeline:notice`（已转管理员分类，请等待） |
 * | `blocked` | `pipeline:notice`（用 `/recheck --force` 或 `/pipeline next`） |
 * | `closed` | 静默 |
 * | 无行 / `ready` | 正常建任务 |
 *
 * 限速：`gate_notice_at` 距今不足 `PIPELINE_GATE_NOTICE_INTERVAL_SECONDS`（1 小时）→
 * 降级成 `silent`（仍然打 eyes，避免用户以为机器人死了）。
 */
export function decideGateOutcome(row: PipelineRow | null, at: Date): GateOutcome {
  if (row === null) {
    return { kind: 'allow' };
  }
  if (row.state === 'closed') {
    return { kind: 'ignore', reason: 'closed' };
  }
  if (row.state === 'ready') {
    return { kind: 'allow' };
  }
  if (row.state === 'pending' || row.state === 'running') {
    return { kind: 'silent' };
  }
  const gateState = `${row.stage}/${row.state}`;
  const reason =
    row.state === 'blocked'
      ? 'blocked'
      : row.stage === 'classify'
        ? 'classify-awaiting-manager'
        : 'format-awaiting-info';
  if (!gateNoticeAllowed(row.gateNoticeAt, at, PIPELINE_GATE_NOTICE_INTERVAL_SECONDS)) {
    // 限速：一小时一条；被限速时只打 eyes（不是错误，§8 的限速就是这么定的）
    return { kind: 'silent' };
  }
  return { kind: 'notice', gateState, reason };
}

/**
 * 被拦下的 `@` → `pipeline:notice` 任务（Q8：回执由 AI 撰写，控制面只管限速/长度/`@`）。
 *
 * 命令本身**不执行**（不建命令任务），notice 只产评论；幂等锚按「小时桶」，
 * 同一小时内重复投递不会刷出多条回执。
 */
export function noticePlanFor(plan: WebhookTaskPlan, gateState: string, at: Date): WebhookTaskPlan {
  const hourBucket = Math.floor(at.getTime() / 3_600_000);
  return {
    command: 'pipeline:notice',
    kind: 'notice',
    source: 'pipeline',
    targetKind: 'issue',
    targetNumber: plan.targetNumber,
    headSha: null,
    issueVersionHash: `notice:${gateState}:${String(hourBucket)}`,
    actorLogin: plan.actorLogin,
    association: plan.association,
    commentId: plan.commentId,
    idempotencyActor: 'pipeline',
    // 回执要让模型知道「卡在哪一步、用户刚发了什么」：命令名只进 prompt_text，
    // **不进 command**（否则 `tasks.command` 会变成一条根本不存在的命令）
    promptText: `gate_state=${gateState}; blocked_command=${plan.command}`,
  };
}

/** 打 eyes，失败只 warn（回执失败不该让 GitHub 重投，§5.3 七要点第三条）。 */
export async function reactQuietly(
  deps: WebhookDeps,
  input: {
    readonly dryRun: boolean;
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId?: number | null;
    readonly log: Logger;
  },
): Promise<void> {
  if (input.dryRun) {
    return;
  }
  try {
    await deps.ack.addEyesReaction({
      repo: input.repo,
      issueNumber: input.issueNumber,
      commentId: input.commentId ?? null,
    });
  } catch (error) {
    input.log.warn({ err: describeError(error) }, '打 eyes reaction 失败（不影响 200）');
  }
}

/** `issues.*` 动作 → 状态机事件（§2 前三行 + D7 + §16.2 第 3 条的冷却让位）。 */
export function pipelineTransitionFor(
  row: PipelineRow | null,
  input: { readonly action: string | null; readonly issueVersion: string | null; readonly at: Date },
): PipelineTransition {
  const version = input.issueVersion;
  if (input.action === 'edited') {
    // 冷却让位：评论触发后的 120s 内，编辑不再单独触发重跑（评论优先）
    if (!recheckCooldownElapsed(row?.lastRecheckAt ?? null, input.at, PIPELINE_LIMITS.recheckCooldownSeconds)) {
      return { ignore: 'recheck-cooldown' };
    }
    return decideTransition(row, { kind: 'issue-edited', at: input.at, issueVersion: version });
  }
  // opened / reopened（重开的语义与「新 issue」一致：重新过格式检查）
  return decideTransition(row, { kind: 'issue-opened', at: input.at, issueVersion: version });
}

/** 管理员指令的执行结果（`null` = 这条评论不是指令）。 */
export type DirectiveOutcome =
  | { readonly kind: 'ignored'; readonly reason: string; readonly plan: WebhookTaskPlan }
  | { readonly kind: 'enqueued'; readonly taskId: string; readonly plan: WebhookTaskPlan }
  | { readonly kind: 'duplicate'; readonly taskId: string | null; readonly plan: WebhookTaskPlan };

/**
 * 处理管理员指令（`/recheck`、`/recheck --force`、`/pipeline next|prev`）。
 *
 * 三条纪律：
 *  1. **不进命令门禁**（§16.1 第 3 条）：权限只看 `pipeline.managers` / `OWNER`；
 *  2. **非 managers 只打 eyes**：不执行、不回复（§1.7 Q7）；
 *  3. **PR 不认指令**：PR 不受流水线影响（§8 末条）。
 *
 * 审计落在既有通道：`webhook_deliveries`（这条评论的投递行）+ `tasks`（指令触发的阶段任务）
 * + 一条带 `directive=…` 的日志；不新建审计表。
 */
export async function runDirective(args: {
  readonly db: SqlRunner;
  readonly repo: string;
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  readonly aliases: readonly string[];
  readonly settings: RepoConfig | null;
  readonly at: Date;
  readonly dryRun: boolean;
  readonly log: Logger;
}): Promise<DirectiveOutcome | null> {
  if (args.event !== 'issue_comment' || args.action !== 'created') {
    return null;
  }
  const payload = asRecord(args.payload);
  const issue = asRecord(payload?.['issue']);
  const comment = asRecord(payload?.['comment']);
  const number = readNumber(issue, 'number');
  if (number === null || asRecord(issue?.['pull_request']) !== null) {
    return null;
  }
  const directive = parsePipelineDirective(comment?.['body'], args.aliases);
  if (directive === null) {
    return null;
  }
  const actor =
    readString(asRecord(comment?.['user']), 'login') ??
    readString(asRecord(payload?.['sender']), 'login') ??
    'unknown';
  const association = readString(comment, 'author_association');
  const commentId = readNumber(comment, 'id');
  const base: WebhookTaskPlan = {
    command: 'pipeline:format',
    kind: 'pipeline',
    source: 'pipeline',
    targetKind: 'issue',
    targetNumber: number,
    headSha: null,
    issueVersionHash: null,
    actorLogin: actor,
    association,
    commentId,
    idempotencyActor: 'pipeline',
  };

  if (!isPipelineManager(args.settings, { login: actor, association })) {
    return { kind: 'ignored', reason: 'not-manager', plan: base };
  }

  const key = { repo: args.repo, issueNumber: number };
  const row = await loadPipeline(args.db, key);
  if (row === null) {
    // 没有状态行 = 这条 issue 还没进流水线；指令无从下手（§1.3 的放行只针对 `@`）
    return { kind: 'ignored', reason: 'no-row', plan: base };
  }

  const event: PipelineEvent =
    directive.kind === 'next'
      ? { kind: 'manual-next', fromManager: true, at: args.at }
      : directive.kind === 'prev'
        ? { kind: 'manual-prev', fromManager: true, at: args.at }
        : { kind: 'manual-recheck', force: directive.force, fromManager: true, at: args.at };
  const transition = decideTransition(row, event);
  if (transition.ignore !== undefined) {
    return { kind: 'ignored', reason: transition.ignore, plan: base };
  }
  await applyTransition(args.db, key, transition);
  args.log.info(
    {
      repo: args.repo,
      issue: number,
      directive: describeDirective(directive),
      stage: transition.stage,
      state: transition.state,
    },
    '管理员指令已执行（审计：投递行 + 任务行 + 本条日志）',
  );

  const enqueue = transition.effects?.enqueue;
  if (enqueue === undefined || enqueue === null) {
    // `next` 进到 `agent/ready` 时没有阶段任务要跑（阶段 2 由 @ 触发）
    return { kind: 'ignored', reason: 'no-stage-task', plan: base };
  }
  // 指令的锚带上「动作 + 指令落地的时刻」：同一条指令重复投递不重复跑，
  // 但「先进再退」这类连续指令不该被唯一键吃掉
  const plan: WebhookTaskPlan = {
    ...base,
    command: enqueue,
    // 锚 = 裸 issueVersion + 指令动作 + 指令落地时刻（列里只存裸版本，前缀在入队处拼）
    issueVersionHash: `${bareIssueVersion(row.issueVersion) ?? 'none'}:${describeDirective(directive)}:${String(args.at.getTime())}`,
  };
  return insertPipelineTask(args.db, { plan, repo: args.repo, deliveryId: null });
}

/**
 * 建任务 + 返回结论（**不入队、不打 reaction**）：指令路径用。
 *
 * 入队由调用方做（`deps.enqueue`），因为「建任务」与「送去队列」在 webhook 里是两个可分别失败的步骤。
 */
async function insertPipelineTask(
  db: SqlRunner,
  input: { readonly plan: WebhookTaskPlan; readonly repo: string; readonly deliveryId: string | null },
): Promise<DirectiveOutcome> {
  const plan = input.plan;
  const idempotencyKey = idempotencyKeyFor(plan, input.repo);
  const taskId = randomUUID();
  const inserted = await db.query(WEBHOOK_SQL.insertTask, [
    taskId,
    plan.source,
    input.repo,
    plan.targetKind,
    plan.targetNumber,
    plan.headSha,
    plan.command,
    plan.actorLogin,
    idempotencyKey,
    input.deliveryId,
    plan.promptText ?? null,
    plan.targetTitle ?? null,
    truncateTargetBody(plan.targetBody),
    JSON.stringify(plan.supplements ?? []),
  ]);
  if ((inserted.rowCount ?? 0) === 0) {
    const existing = await db.query(WEBHOOK_SQL.findTaskByIdempotencyKey, [idempotencyKey]);
    const existingId = (existing.rows[0] as Record<string, unknown> | undefined)?.['id'];
    return { kind: 'duplicate', taskId: typeof existingId === 'string' ? existingId : null, plan };
  }
  return { kind: 'enqueued', taskId, plan };
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

/** 真实 reaction 实现（走 `GithubClient.request`，不引入写执行器）。 */
export function createGithubWebhookAck(client: GithubClient): WebhookAck {
  /** 评论级优先、issue 级兜底的 reaction 通道（`eyes` 与 `confused` 共用）。 */
  const react = async (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId?: number | null;
    readonly content: ReactionContent;
  }): Promise<void> => {
    const { owner, repo } = splitRepo(input.repo);
    // 评论触发时打到**那条评论**上（用户看自己评论的角标就能确认「收到了」）；
    // issue/PR 事件没有评论可打，回落到 issue 级 reaction。
    if (input.commentId !== undefined && input.commentId !== null) {
      await client.request('POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions', {
        owner,
        repo,
        comment_id: input.commentId,
        content: input.content,
      });
      return;
    }
    await client.request('POST /repos/{owner}/{repo}/issues/{issue_number}/reactions', {
      owner,
      repo,
      issue_number: input.issueNumber,
      content: input.content,
    });
  };
  return {
    addEyesReaction: (input) => react({ ...input, content: 'eyes' }),
    addReaction: react,
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
