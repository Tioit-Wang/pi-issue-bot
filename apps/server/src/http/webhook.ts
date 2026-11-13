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
  type WebhookAcceptedResponse,
} from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import type { FastifyRequest } from 'fastify';
/* ── 任务快照的截断口径（原 `config/pipeline-constants.ts`，随流水线退役搬到这里）────── */

/** `tasks.target_body` 入队时的截断长度（§4.2）：比进提示词的 4000 大一倍，后续分析才有余地。 */
export const TARGET_BODY_MAX_CHARS = 8_000;

/** `tasks.target_supplement` 只保留最近几条补充评论（§16.2 第 2 条）。 */
export const SUPPLEMENT_MAX_ITEMS = 3;

/** 每条补充评论截断到多少字符（§16.2 第 2 条）。 */
export const SUPPLEMENT_ITEM_MAX_CHARS = 1_000;

import { readRepoPolicy, upsertRepo } from '../config/repo-config.ts';
import type { RepoPolicy, SqlRunner } from '../config/repo-config.ts';
import { splitRepo } from '../github/index.ts';
import type { GithubClient, GithubReactionApi } from '../github/index.ts';
import {
  RUNTIME_FLAG_SQL,
  buildIdempotencyKey,
  enqueueTask,
  installationPauseKey,
  isPauseFlagActive,
} from '../queue/index.ts';
import type { QueueBoss, RunTaskJobData } from '../queue/index.ts';
import { REVIEW_PR_COMMAND } from '../queue/definitions.ts';
import {
  AGENT_DENIAL_REPLY,
  ackReceived,
  agentTaskIdempotencyKey,
  composeAgentMessage,
  eventTemplateSkillOf,
  findTaskIdByKey,
  insertMessage,
  isManager,
  recordDenial,
} from '../agent/index.ts';
import type { AgentMessageSettings, AgentSkillCatalogEntry, AgentTemplateId } from '../agent/index.ts';
import { errorBodyOf } from './errors.ts';
import {
  V21_DECISION_SQL,
  applyV21SessionOnEvent,
  decideV21Delivery,
  handleV21Webhook,
  v21EventKeyOf,
  writeV21Decision,
} from './webhook-v21.ts';
import type { V21Trace, V21WebhookDeps } from './webhook-v21.ts';
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
   * v2.1 判定留痕（FR-2.1 / BR-6）：`decision` = `triggered|ignored`，`decision_reason` = §2 的 reason。
   *
   * 为什么是独立 UPDATE 而不是给 `insertDelivery` 加两列：判定要等第 4.5 步读出
   * `repos.settings` 才有结论，而 INSERT 在第 3 步就发生了；且 replay / 验签失败重投时
   * INSERT 会命中 `ON CONFLICT DO NOTHING`，补列根本写不进去。UPDATE 保证**每一条投递行
   * 最终都有值**（包括未触发与 PR 的 `pr-ignored`）。语句本体放在 `webhook-v21.ts`，
   * 这里只把它登记进管线的 SQL 目录，避免同一条 SQL 抄两份。
   */
  markDecision: V21_DECISION_SQL.write,
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
 * v0.3：`/名字` 归技能（`skill-mentions.ts`，S1），所以以 `/` 开头的正文**不算**自由问答。
 * 返回 `null` 表示这条评论不是自由提问（交给 `/命令` 通道或直接忽略）。
 */
export function extractFreeQuestion(
  body: unknown,
  aliases: string | readonly string[] = DEFAULT_BOT_MENTION,
): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const parsed = parseTriggerBody(body, triggerAliasList(aliases));
  if (parsed.kind !== 'mention' || parsed.text === null) {
    return null;
  }
  return parsed.text.startsWith('/') ? null : parsed.text;
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
 * 句柄**必须**可配：slug 由 App 名字决定（本仓库实际部署的 App 是 `pi-issue-bot-tioit`）
 * ——写死 `pi-bot` 会让真实用户 @ 了机器人却没反应。
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
  /**
   * 非管理员的「无权限」回复（需求 C-10 / §5 规则 1：同 issue 同 actor **只回一次**）。
   *
   * 不注入 = 只记 `agent_denials` 不回话（本机没装 App 的部署）。dry-run 时**不调用**。
   */
  readonly replyDenied?: (input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId: number | null;
    readonly actorLogin: string;
    readonly text: string;
  }) => Promise<void>;
  /**
   * agent 消息落库后**立刻**为这个 issue 领一条（dispatcher 的即时版，见 `agent/dispatcher.ts`）。
   *
   * 不注入 = 只靠 `agent-dispatch` 的每分钟兜底（延迟最多 1 分钟）。失败只记 warn：
   * 消息已经落库，兜底那轮会再试一次。
   */
  readonly dispatchAgent?: (key: {
    readonly repo: string;
    readonly issueNumber: number;
  }) => Promise<unknown>;
  /**
   * reaction 写面（`feedback/` 的 `GithubReactionApi`）：给了就走 `agent/ack.ts`，
   * 没给就回落到 `ack.addEyesReaction`（老装配与单测）。
   */
  readonly reactions?: GithubReactionApi;
  /** App slug（删自己的 reaction 时判归属）。 */
  readonly appSlug?: string | null;
  /**
   * v2.1 接线（BR-6 判定留痕 + FR-2.3 模板渲染）。
   *
   * **不注入 = 旧路径逐字节不变**：判定 UPDATE、模板渲染、issue 索引请求都只在这一段启用时发生，
   * 所以既有的 webhook 单测（它们只构造旧 deps）不会被多出来的 SQL 或异步调用打乱。
   */
  readonly v21?: V21WebhookDeps | undefined;
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

/** `issues.*` 里需要判定的事件（opened / edited）。`reopened` 在 v0.3 不再产生任务。 */
export const ISSUE_ACTIONS: readonly string[] = Object.freeze(['opened', 'edited']);

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
   *  - 人工通道：`/review-pr`（PR 审查，保留既有命令通道）；`@answer` 只为兼容历史任务行；
   *  - v0.3 issue agent：`agent:opened` / `agent:edited` / `agent:mention`（真正落库的
   *    任务由 dispatcher 建，命令收敛为 `agent:event` / `agent:mention`，见 `agent/store.ts`）。
   */
  readonly command: string;
  /** 幂等键的 kind：`command:/review-pr` / `answer:<hash>` / `agent:<template>`。 */
  readonly kind: string;
  /** `tasks.source`：`command`（人工）与 `agent`（v0.3 issue agent）能写回评论。 */
  readonly source: 'webhook' | 'command' | 'agent';
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha: string | null;
  /**
   * 任务级幂等锚（进 `buildIdempotencyKey` 的 `anchor`）：
   *  - agent 事件消息：`<issueVersionHash>[:edit]`（仅为兼容旧断言保留；agent 通道真正的
   *    幂等由 `agent_messages.fingerprint` 承担）；
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
   * 幂等键里的触发者。agent 任务固定写 `'agent'`：同一份内容被不同的人触发
   * 也必须落到同一个键上（`trigger_actor` 是给人工 `/retry` 与 webhook 重投区分用的）。
   */
  readonly idempotencyActor?: string;
  /** 入队时快照的标题 / 正文（§4.2；agent 事件消息才有）。 */
  readonly targetTitle?: string | null;
  readonly targetBody?: string | null;
  /** 补充评论段（最近 3 条、每条 ≤1000 字符）；评论补充重跑时**整体替换**这个数组。 */
  readonly supplements?: readonly TaskSupplement[];
  /**
   * agent 消息计划（v0.3，S1）：给了它就走 `submitAgentMessage()`，
   * 落 `agent_messages` 而不是直接建 `tasks` —— 建任务与串行由 dispatcher 负责。
   */
  readonly agent?: AgentMessagePlan;
};

/** 一条 agent 消息的计划（`kind` 决定模板与幂等口径）。 */
export type AgentMessagePlan = {
  readonly kind: 'mention' | 'event';
  /** `kind='event'` 时是哪条模板（`opened` / `edited`） */
  readonly templateId: AgentTemplateId | null;
  /** 人消息是原话（后面由 `composeAgentMessage` 摘别名 + 扫技能） */
  readonly rawText: string;
  /** `issue.updated_at`（事件消息 fingerprint 的一部分；人消息不用） */
  readonly issueUpdatedAt: string;
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

/** 从评论正文里取 `/命令`（`@ibot /review-pr`）；没有则 `null`。 */
export function extractCommand(
  body: unknown,
  aliases: string | readonly string[] = DEFAULT_BOT_MENTION,
): string | null {
  if (typeof body !== 'string') {
    return null;
  }
  const parsed = parseTriggerBody(body, triggerAliasList(aliases));
  const matched = parsed.text === null ? null : /^(\/[a-z][a-z0-9-]{1,30})(?=\s|$)/iu.exec(parsed.text);
  return matched === null ? null : (matched[1] ?? '').toLowerCase();
}

/** 机器人账号（`type: 'Bot'`）无论 association 一律忽略（plan §6.4）。 */
function isBotActor(user: Record<string, unknown> | null): boolean {
  return readString(user, 'type') === 'Bot';
}

/**
 * 机器人**登录名**（E-09）：`dependabot[bot]` / `renovate[bot]` 这类账号的载荷有时 `type` 不是
 * `Bot`（GitHub 的 webhook 里两种都出现过），只判 `type` 会让依赖升级 PR 触发 AI 自我循环。
 * 纯函数、无白名单硬编码列表里只看 `[bot]` 后缀与三个众所周知的机器人名。
 */
export function isBotLogin(login: string): boolean {
  const normalized = login.trim().toLowerCase();
  if (normalized === '') {
    return false;
  }
  return normalized.endsWith('[bot]') || BOT_LOGINS.includes(normalized);
}

/** 已知的机器人 login（`[bot]` 后缀已覆盖绝大多数；这三个在历史载荷里不带后缀也出现过）。 */
const BOT_LOGINS: readonly string[] = Object.freeze(['dependabot', 'renovate', 'github-actions']);

/**
 * 事件/action 白名单 → 要不要建任务、建什么任务。
 *
 * 覆盖范围有意收窄（其余事件一律 `ignored`，但仍落 `webhook_deliveries` 供审计）：
 *  - `issue_comment.created` 且正文里有 `@别名 /review-pr` → 命令任务（PR 审查，保留既有通道）；
 *  - `issue_comment.created` 且正文 @ 了别名 → **agent 消息**（`kind='mention'`，永久幂等）；
 *    权限（`settings.agent.managers`）在接线层判，这里只产出计划；
 *  - `issue_comment.created` 但**没有 @ 到别名** → 不建任何东西（v0.3 没有「补充评论」通道）；
 *  - `issues.opened` / `issues.edited`（仅标题/正文变更）→ **agent 消息**（`kind='event'`）；
 *  - 其余（含 `issues.reopened`、`labeled` / `assigned` / `closed`、`pull_request.*`、`push`）→ 不投递。
 *
 * 机器人（`type=Bot` 与 `dependabot[bot]` / `renovate[bot]` 这类 login）在任何事件里都被忽略，
 * 避免 AI 自己打标 / 自己编辑后触发自己（D8 / E-08 / E-09）。
 */
export function decideWebhookTask(input: {
  readonly event: string;
  readonly action: string | null;
  readonly payload: unknown;
  /** 触发别名（裸名，大小写不敏感）；缺省用部署默认 `pi-bot`。 */
  readonly aliases?: readonly string[];
  /** 兼容旧签名：单个句柄。与 `aliases` 同时给时以 `aliases` 为准。 */
  readonly mention?: string;
  /** 是否把「纯 @ 提及」（不带 `/命令`）也当成一条 agent 消息（`PI_BOT_FREE_MENTION`，默认开）。 */
  readonly freeMention?: boolean;
}): WebhookDecision {
  const payload = asRecord(input.payload);
  const actorUser = asRecord(payload?.['sender']);
  if (isBotActor(actorUser)) {
    return { action: 'ignore', reason: '触发者是机器人账号' };
  }
  if (isBotLogin(readString(actorUser, 'login') ?? '')) {
    return { action: 'ignore', reason: '触发者是机器人账号（login 判定：dependabot / renovate / *[bot]）' };
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

    const base = {
      targetKind: isPullRequest ? ('pr' as const) : ('issue' as const),
      targetNumber: number,
      // 评论载荷里没有 PR 的 head sha（要额外打一次 API）；锚缺省走 `none`。
      headSha: null,
      issueVersionHash: null,
      actorLogin: login,
      association: readString(comment, 'author_association'),
      commentId: readNumber(comment, 'id'),
    };

    // `/review-pr` 仍是命令通道（PR 审查不在 v0.3 的 agent 范围内，OQ-3）；除此之外
    // v0.3 的 `/名字` 全部归技能，所以这里只认这一条命令。
    const command = extractCommand(comment?.['body'], aliases);
    if (command === REVIEW_PR_COMMAND) {
      return {
        action: 'task',
        plan: {
          ...base,
          source: 'command',
          command,
          kind: `command:${command}`,
        },
      };
    }

    // `@别名` → agent 消息（人消息，永久幂等）。权限在接线层判（`submitAgentMessage`）。
    const parsed = parseTriggerBody(typeof comment?.['body'] === 'string' ? (comment['body'] as string) : '', aliases);
    if (parsed.kind !== 'mention' || parsed.text === null) {
      // 没有 @ 到别名：不是给我的消息，零任务（不再有「补充评论」那条隐式通道）
      return { action: 'ignore', reason: '评论没有 @ 到触发别名' };
    }
    if (input.freeMention === false) {
      return { action: 'ignore', reason: '纯 @ 提问已关闭（PI_BOT_FREE_MENTION=false）' };
    }
    return {
      action: 'task',
      plan: {
        ...base,
        source: 'agent',
        command: 'agent:mention',
        kind: 'mention',
        agent: {
          kind: 'mention',
          templateId: null,
          rawText: parsed.text,
          issueUpdatedAt: readString(issue, 'updated_at') ?? '',
        },
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
    if (asRecord(issue?.['pull_request']) !== null) {
      return { action: 'ignore', reason: 'issues 事件来自 PR，不在 agent 范围' };
    }
    // `edited` 只认「标题/正文」变更（E-03）：改标签 / 改指派人也在 `changes` 里，不能投
    if (input.action === 'edited') {
      const changes = asRecord(payload?.['changes']);
      const touched = changes !== null && ('title' in changes || 'body' in changes);
      if (!touched) {
        return { action: 'ignore', reason: 'issues.edited 只改了标题/正文以外的字段' };
      }
    }
    const actorLogin = readString(actorUser, 'login') ?? 'unknown';
    const updatedAt = readString(issue, 'updated_at') ?? '';
    const templateId: AgentTemplateId = input.action === 'opened' ? 'opened' : 'edited';
    return {
      action: 'task',
      plan: {
        command: `agent:${templateId}`,
        kind: `agent:${templateId}`,
        source: 'agent',
        targetKind: 'issue',
        targetNumber: number,
        headSha: null,
        // `issues.edited` 追加编辑标识：同一版本重复投递必须幂等，编辑之后必须产生新消息
        issueVersionHash: input.action === 'edited' ? `${issueVersionHash(issue?.['updated_at'])}:edit` : issueVersionHash(issue?.['updated_at']),
        actorLogin,
        association: readString(issue, 'author_association'),
        commentId: null,
        // 同一份内容被不同人触发也落到同一个键（`trigger_actor` 进键会破坏「同版本只跑一次」）
        idempotencyActor: 'agent',
        targetTitle: readString(issue, 'title'),
        targetBody: readString(issue, 'body'),
        supplements: [],
        agent: { kind: 'event', templateId, rawText: '', issueUpdatedAt: updatedAt },
      },
    };
  }

  return { action: 'ignore', reason: `事件 ${input.event}.${input.action ?? '未知'} 不在白名单` };
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
/**
 * 跑一次投递（九步）+ v2.1 的判定留痕（BR-6）。
 *
 * 为什么做成「外层包装 + 内层 `runWebhookPipeline()`」：判定要写进**每一条**投递行，
 * 包括验签失败、暂停、未知仓库、开关关闭这些早早 return 的分支。逐个 return 点补一句
 * `UPDATE` 会漏，也会把旧路径改得面目全非；包一层之后，内层一个字都不用改语义，
 * 外层统一在返回前落一次 `decision / decision_reason`。
 */
export async function handleWebhook(deps: WebhookDeps, input: WebhookInput): Promise<WebhookResult> {
  const trace: V21Trace = { decision: null, payload: null, action: null, skipDecision: false };
  const result = await runWebhookPipeline(deps, input, trace);
  if (deps.v21 === undefined || trace.skipDecision) {
    // 投递级重复：原投递行已有判定，不覆盖（BR-6 的判定属于「第一次收到这条事件」）。
    return result;
  }

  let decision = trace.decision;
  if (decision === null && trace.payload !== null) {
    /*
      内层在读到 `repos.settings` 之前就返回了（暂停 / 未知仓库 / 安装事件 / 验签失败…）。
      这些投递仍然要留痕，但**病因必须分开记**：
       - 验签失败是「secret 对不上」，与仓库开不开无关；
       - 其余是「仓库不可用」（禁用 / 未登记 / 配置非法）。
      实测教训（issue #30）：401 被记成 `repo-disabled`，而 `repos.enabled = true`，
      排查时先去查仓库开关，白绕一圈。这里按 401 单独记 `signature-invalid`。
    */
    decision = decideV21Delivery({
      event: input.event,
      action: trace.action,
      payload: trace.payload,
      settings: null,
      repoDisabled: true,
      ...(result.status === 401 ? { signatureInvalid: true } : {}),
    });
  }
  if (decision !== null) {
    try {
      // 不触发也写：BR-6 的「每次判定写 decision + decision_reason」是审计要求，不是成功路径的装饰。
      await writeV21Decision(deps.v21.db, input.deliveryId, decision);
    } catch (error) {
      // 留痕失败不该让 GitHub 重投一次（幂等行已经写好了），只记 warn。
      deps.logger.child({ deliveryId: input.deliveryId }).warn(
        { err: describeError(error) },
        'v2.1 判定留痕失败（不影响应答）',
      );
    }
  }
  return result;
}

/**
 * 九步管线本体（v0.3 行为）。`trace` 只被 v2 包装读取，不注入 v21 时没人看它。
 */
async function runWebhookPipeline(
  deps: WebhookDeps,
  input: WebhookInput,
  trace: V21Trace,
): Promise<WebhookResult> {
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
  trace.payload = payload;
  trace.action = action;

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
        // 别让外层包装把这行的原判定覆写成 repo-disabled（见 V21Trace.skipDecision 注释）
        trace.skipDecision = true;
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

  if (deps.v21 !== undefined) {
    // 判定发生在「仓库可用性 → 事件开关」这一层：仓库禁用/配置非法时直接给 repo-disabled，
    // 其余交给 decideEvent() 按 §2 的固定顺序判（开关 → 条件 → 闸门 → 去重 → 配额）。
    trace.decision = decideV21Delivery({
      event: input.event,
      action,
      payload,
      settings: policy.settings,
      repoDisabled: !policy.enabled || !policy.settingsValid,
    });

    // 会话状态（FR-3.4 / AC-23）：事件与 issue 状态的**权威来源**就在这一份载荷里，
    // 所以迁移在这里做，而不是等 worker 跑起来再猜「这条任务属于哪个事件」。
    // 只 UPDATE / INSERT，永不 DELETE 会话行。
    const sessionEvent = v21EventKeyOf(input.event, action);
    const issue = asRecord(asRecord(payload)?.['issue']);
    const issueNumber = readNumber(issue, 'number');
    const issueState = readString(issue, 'state');
    if (sessionEvent !== null && sessionEvent !== 'pull_request.*' && issueNumber !== null) {
      try {
        await applyV21SessionOnEvent(deps.v21.db, {
          repo,
          issueNumber,
          event: sessionEvent,
          issueState: issueState === 'closed' ? 'closed' : 'open',
        });
      } catch (error) {
        // 会话是唯一有状态的资产，但状态迁移失败不该让投递 500（下一轮事件会再修）
        log.warn({ err: describeError(error) }, 'v2.1 会话状态迁移失败（不影响应答）');
      }
    }
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

  const decision = decideWebhookTask({
    event: input.event,
    action,
    payload,
    aliases,
    ...(deps.freeMention === undefined ? {} : { freeMention: deps.freeMention }),
  });
  // ── v2.1 独立分支（只有注入 `WebhookDeps.v21` 时才启用）──────────────────────
  // 判定留痕由外层 `handleWebhook()` 在返回前统一写（含未触发与 PR 的 `pr-ignored`）；
  // 这里只负责「五个 EventKey + PR」的最终处置：触发 → 选模板 → 渲染 → 落 `agent_messages`
  // 的 `comment_body`；未触发 → 200 ignored 且不入队。
  // 旧命令通道（`source='command'`）与 v2 范围外的事件一律不接管，行为逐字节不变。
  const v21Decision =
    deps.v21 === undefined
      ? null
      : (trace.decision ??
        decideV21Delivery({ event: input.event, action, payload, settings: policy.settings }));
  if (deps.v21 !== undefined && v21Decision !== null) {
    const legacyCommand = decision.action === 'task' && decision.plan.source === 'command';
    const outcome = await handleV21Webhook({
      deps: deps.v21,
      logger: log,
      deliveryId: input.deliveryId,
      event: input.event,
      action,
      payload,
      repo,
      settings: policy.settings,
      dryRun,
      decision: v21Decision,
      legacyCommand,
      ...(deps.dispatchAgent === undefined ? {} : { dispatchAgent: deps.dispatchAgent }),
      addEyesReaction: async (call): Promise<void> => {
        await deps.ack.addEyesReaction({
          repo: call.repo,
          issueNumber: call.issueNumber,
          commentId: call.commentId,
        });
      },
    });
    if (outcome !== null) {
      return finish(outcome.status, outcome.body);
    }
  }

  if (decision.action === 'ignore') {
    log.info({ repo, reason: decision.reason }, '事件不在白名单，不建任务');
    return finish(200, accepted({ deliveryId: input.deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }));
  }

  // ── agent 通道（v0.3）：落 `agent_messages`，建任务与串行交给 dispatcher ──────────
  // 注入 v21 时上面那条独立分支已经接管，这里只会由「未注入 v21 的旧装配」走到。
  if (decision.plan.agent !== undefined) {
    const result = await submitAgentMessage(deps, {
      plan: decision.plan,
      repo,
      deliveryId: input.deliveryId,
      dryRun,
      settings: policy.settings?.agent ?? null,
      aliases,
      log,
    });
    return finish(result.status, result.body);
  }

  // 正文快照（§4.2）：入队即定型，之后不再依赖 90 天保留期的投递原文。
  const plan = await withTargetSnapshot(deps.db, repo, decision.plan);
  log.info(
    { repo, issue: plan.targetNumber, command: plan.command, at: at.toISOString() },
    '已判定要建任务',
  );

  return await submitPlanTask(deps, {
    plan,
    repo,
    deliveryId: input.deliveryId,
    dryRun,
    log,
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
  },
): Promise<WebhookResult> {
  const { plan, repo, deliveryId, dryRun, log } = input;

  // v0.3 没有「命令门禁」：`/名字` 归技能、`@别名` 的权限由 `settings.agent.managers` 判
  // （`agent/permission.ts`，S3）。这里只保留建任务 → 入队 → eyes → 200 那条通道。

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

/* ── agent 通道（v0.3）：落消息 + 立刻投递 ─────────────────────────────────── */

/** 仓库可用技能的目录（`listSkills` 给的是 `/名字`；这里收成 id 列表，失败 = 空目录）。 */
export async function skillCatalogOf(
  deps: WebhookDeps,
  repo: string,
): Promise<readonly AgentSkillCatalogEntry[]> {
  if (deps.listSkills === undefined) {
    return [];
  }
  let names: readonly string[];
  try {
    names = await deps.listSkills(repo);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const entries: AgentSkillCatalogEntry[] = [];
  for (const name of names) {
    const id = name.trim().replace(/^\//u, '');
    if (id === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    entries.push({ id });
  }
  return entries;
}

/** 「已收到」回执：有 `reactions` 走 `agent/ack.ts`，否则回落到 `ack.addEyesReaction`。 */
async function reactToAgentMessage(
  deps: WebhookDeps,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly commentId: number | null;
    readonly log: Logger;
  },
): Promise<void> {
  if (deps.reactions !== undefined) {
    await ackReceived(
      {
        reactions: deps.reactions,
        ...(deps.appSlug === undefined ? {} : { appSlug: deps.appSlug }),
        logger: input.log,
      },
      { repo: input.repo, issueNumber: input.issueNumber, commentId: input.commentId },
    );
    return;
  }
  try {
    await deps.ack.addEyesReaction({
      repo: input.repo,
      issueNumber: input.issueNumber,
      commentId: input.commentId,
    });
  } catch (error) {
    input.log.warn({ err: describeError(error) }, 'agent 回执打 eyes 失败（不影响 200）');
  }
}

/**
 * agent 消息的**唯一**入口（需求 §1.2 / §5）：
 *
 * ```
 * 事件模板没配技能（on_opened/on_edited 置空） → 不投递
 * 非管理员（mention）                        → 记 agent_denials + 只回一次
 * 落 agent_messages（幂等）                  → 命中即 duplicate（不建任务、不调模型）
 * 立刻 dispatch 这个 issue                   → 建 tasks + 投 run-task
 * 打 eyes                                   → dry-run 一个都不打
 * ```
 */
async function submitAgentMessage(
  deps: WebhookDeps,
  input: {
    readonly plan: WebhookTaskPlan;
    readonly repo: string;
    readonly deliveryId: string;
    readonly dryRun: boolean;
    readonly settings: AgentMessageSettings;
    readonly aliases: readonly string[];
    readonly log: Logger;
  },
): Promise<{ readonly status: number; readonly body: WebhookAcceptedResponse | ErrorBody }> {
  const { plan, repo, deliveryId, dryRun, log } = input;
  const agent = plan.agent;
  if (agent === undefined) {
    // 调用点保证有；这里只是把「不可能」写死，避免以后误用
    return {
      status: 500,
      body: errorBodyOf('internal', 'agent 消息计划缺失（内部错误）'),
    };
  }
  const issueNumber = plan.targetNumber;
  const ignored = (): { status: number; body: WebhookAcceptedResponse } => ({
    status: 200,
    body: accepted({ deliveryId, action: 'ignored', taskId: null, duplicate: false, ackComment: null }),
  });

  // ── 1) 事件模板没点名技能 = 该事件不投递（CF-02 / CF-03）─────────────────────
  if (agent.kind === 'event') {
    const skillId = agent.templateId === null ? null : eventTemplateSkillOf(input.settings, agent.templateId);
    if (skillId === null) {
      log.info(
        { repo, issue: issueNumber, template: agent.templateId },
        '事件模板未配置技能（on_opened / on_edited 置空 = 不投递）',
      );
      return ignored();
    }
  }

  // ── 2) 权限：@ 仅管理员（拒绝独立记账，同 issue 同 actor 只回一次）────────────
  if (
    agent.kind === 'mention' &&
    !isManager({ agent: { managers: input.settings?.managers ?? [] } }, plan.actorLogin)
  ) {
    const denial = await recordDenial(
      deps.db,
      { repo, issueNumber, actorLogin: plan.actorLogin },
      plan.actorLogin,
    );
    log.warn(
      { repo, issue: issueNumber, actor: plan.actorLogin, alreadyReplied: denial.alreadyReplied },
      '非管理员的 @：记 agent_denials（不参与幂等）',
    );
    if (!denial.alreadyReplied && !dryRun && deps.replyDenied !== undefined) {
      try {
        await deps.replyDenied({
          repo,
          issueNumber,
          commentId: plan.commentId,
          actorLogin: plan.actorLogin,
          text: AGENT_DENIAL_REPLY,
        });
      } catch (error) {
        log.warn({ err: describeError(error) }, '无权限回复发送失败（只回一次的机会就此用掉）');
      }
    }
    return ignored();
  }

  // ── 3) 组装 + 幂等落库（永久幂等只约束人消息，事件消息 key 含 updated_at）───────
  const catalog = await skillCatalogOf(deps, repo);
  const composed = composeAgentMessage({
    kind: agent.kind,
    ...(agent.templateId === null ? {} : { templateId: agent.templateId }),
    rawText: agent.rawText,
    aliases: input.aliases,
    catalog,
    issue: {
      repo,
      number: issueNumber,
      title: plan.targetTitle ?? null,
      body: plan.targetBody ?? null,
      updatedAt: agent.issueUpdatedAt,
    },
    settings: input.settings,
  });
  const key = { repo, issueNumber, fingerprint: composed.fingerprint };
  const saved = await insertMessage(deps.db, {
    key,
    kind: agent.kind,
    commentId: plan.commentId,
    // v0.3 组装产物就是消息正文；v2.1 走 `webhook-v21.ts` 的独立分支，不共用这条组装链。
    body: composed.text,
    // 触发人：mention = 评论作者，opened/edited = issue 作者。写回时靠它加 `@login`。
    actorLogin: plan.actorLogin,
    // 点名的技能 id：正文里的 `/name` 已被摘掉，只有这一份结构化信息能传给装配层。
    skillIds: composed.skillIds,
  });
  if (!saved.inserted) {
    const existingTaskId = await findTaskIdByKey(deps.db, agentTaskIdempotencyKey(key)).catch(() => null);
    log.info(
      { repo, issue: issueNumber, fingerprint: key.fingerprint },
      'agent 消息幂等命中：不建任务、不调模型',
    );
    return {
      status: 200,
      body: accepted({
        deliveryId,
        action: 'duplicate',
        taskId: existingTaskId,
        duplicate: true,
        ackComment: null,
      }),
    };
  }

  // ── 4) 立刻为这个 issue 领一条（cron 兜底；失败不影响 200）───────────────────
  if (deps.dispatchAgent !== undefined) {
    try {
      await deps.dispatchAgent({ repo, issueNumber });
    } catch (error) {
      log.warn({ err: describeError(error) }, 'agent 即时投递失败（留给 agent-dispatch 兜底）');
    }
  }
  const taskId = await findTaskIdByKey(deps.db, agentTaskIdempotencyKey(key)).catch(() => null);

  // ── 5) 回执：dry-run 一个 GitHub 写动作都不发 ───────────────────────────────
  if (dryRun) {
    log.info({ repo, issue: issueNumber }, 'dry-run：跳过 reaction（不产生任何 GitHub 写动作）');
    return {
      status: 200,
      body: accepted({ deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment: null }),
    };
  }
  await reactToAgentMessage(deps, {
    repo,
    issueNumber,
    commentId: plan.commentId,
    log,
  });
  return {
    status: 200,
    body: accepted({ deliveryId, action: 'enqueued', taskId, duplicate: false, ackComment: null }),
  };
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
  if (body.length <= TARGET_BODY_MAX_CHARS) {
    return body;
  }
  return `${body.slice(0, TARGET_BODY_MAX_CHARS)}\n\n…（正文已截断：原文 ${String(body.length)} 字符，任务只带前 ${String(TARGET_BODY_MAX_CHARS)} 字符）`;
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
      body.length <= SUPPLEMENT_ITEM_MAX_CHARS
        ? body
        : `${body.slice(0, SUPPLEMENT_ITEM_MAX_CHARS)}…`,
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
    supplements: supplements.slice(-SUPPLEMENT_MAX_ITEMS),
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
