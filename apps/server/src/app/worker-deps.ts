/**
 * 装配层的 worker 侧零件：**端口装配 + 任务行读取 + 提示词骨架**。
 *
 * 三条边界（这里最容易放错东西，所以写在最前面）：
 *  1. **只做形状与装配**：worker 的九步链路在 `worker/run-task.ts`，本文件不复制任何一步；
 *  2. **缺件即明确失败**：没有 docker / 没有 host / 没有 GitHub 令牌时，注入的是**抛错的
 *     实现**而不是「看起来能跑的空实现」—— 后者会让任务「顺利跑完但什么也没留下」，
 *     比失败难查一个量级；
 *  3. **不读 env**：配置由 `app/config.ts` 装配好传进来（同 `config/env.ts` 的纪律）。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../../../../packages/shared/src/index.ts';
import type { RepoSettings } from '../../../../packages/contract/src/index.ts';
import { parseRepoSettings } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { createPgFeedbackLedger, createPgReactionsFlagStore } from '../feedback/index.ts';
import type { FeedbackDeps } from '../feedback/index.ts';
import { createGithubClient, createGithubReactionApi, createGithubWriteApi } from '../github/index.ts';
import type { BotLabelLedger, GithubClient, GithubReactionApi, GithubWriteApi } from '../github/index.ts';
import { splitRepo } from '../github/types.ts';
import type { SqlExecutor } from '../db/index.ts';
import type { SqlRunner } from '../config/repo-config.ts';
import { activePromptBody, recordAssembleStats } from '../prompt/store.ts';
import { collectAgentsMd } from '../skills/agents-md.ts';
import { assemblePrompt } from '../skills/assemble.ts';
import { renderLabelVocabulary, renderSkillPrompt } from '../skills/prompt.ts';
import type { SkillPromptContext } from '../skills/prompt.ts';
import { REPO_SKILLS_DIR, createSkillRegistry } from '../skills/registry.ts';
import type { SkillRepoConfig } from '../skills/registry.ts';
import type { SkillFile } from '../skills/types.ts';
import { createPgBotLabelLedger, loadHumanVetoed } from '../workflows/bot-labels.ts';
import { createPgLabelDecisionRecorder } from '../workflows/label-decisions.ts';
import { toSqlRunner } from '../workflows/ports.ts';
import type { LabelCatalogPort, ReactionPort } from '../workflows/ports.ts';
import {
  TASK_SOURCE_KINDS,
  createExecProxyPort,
  createLifecycleDisposer,
  createPgRunStore,
  createUnavailableWorktreePort,
} from '../worker/index.ts';
import type {
  ExecProxyPort,
  HostPort,
  LabelWritebackPolicy,
  LifecycleDisposer,
  RunStore,
  TaskRunnerDeps,
  TaskSourceKind,
  WorktreePort,
} from '../worker/index.ts';
import { ExecProxy, createLifecycleExecutor, createSandboxDocker } from '../sandbox/index.ts';
import type { SandboxDocker, SandboxLogger } from '../sandbox/index.ts';
import type { AppConfig } from './config.ts';

/** worker 侧装配的错误码。 */
export const WORKER_ASSEMBLY_ERROR_CODES = {
  hostUnavailable: 'HOST_UNAVAILABLE',
  githubUnavailable: 'GITHUB_UNAVAILABLE',
  taskNotFound: 'TASK_NOT_FOUND',
  taskRepoUnusable: 'TASK_REPO_UNUSABLE',
} as const;

/* ── 缺件时的「明确失败」实现 ──────────────────────────────────────────────── */

/**
 * 没有 pi-host bundle 时的 `HostPort`。
 *
 * 为什么不做成「返回一个假 port」：worker 的 `host.ready()` 之后紧跟 `driveTurn`，
 * 假 port 会把失败推到 WS 连接超时（30s 后一条难懂的 `NOT_CONNECTED`）。
 * 这里直接抛，`signalFromError` 归成可读的失败分类，任务体面地失败并落库。
 */
export function createUnavailableHostPort(reason: string): HostPort {
  const fail = async (): Promise<never> => {
    throw new AppError(`pi-host 不可用：${reason}`, {
      code: WORKER_ASSEMBLY_ERROR_CODES.hostUnavailable,
      failureClass: 'sandbox',
      retriable: false,
    });
  };
  return { ready: fail, stop: async () => undefined };
}
/** 没有 GitHub 令牌时的写面：任何调用都抛（dry-run 下它一次都不会被调用）。 */
export function createUnavailableGithubWriteApi(reason: string): GithubWriteApi {
  const fail = async (): Promise<never> => {
    throw new AppError(`GitHub 写面不可用：${reason}`, {
      code: WORKER_ASSEMBLY_ERROR_CODES.githubUnavailable,
      failureClass: 'unknown',
      retriable: false,
    });
  };
  return {
    listIssueComments: fail,
    createIssueComment: fail,
    addLabels: fail,
    removeLabel: fail,
    createIssue: fail,
    closeIssue: fail,
  };
}

/* ── 任务行 ───────────────────────────────────────────────────────────────── */

/** `tasks` 行里 worker 需要的列（不含 jsonb，F9：入队时就写死）。 */
export interface TaskJobRow {
  readonly id: string;
  readonly command: string;
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly headSha: string | null;
  readonly attempt: number;
  /** 自由问答的问题正文（`tasks.prompt_text`）；其它命令为 `null`。 */
  readonly promptText: string | null;
  /** 触发者 login：最终回复要以 `@login` 开头（`tasks.actor_login`）。 */
  readonly actorLogin: string | null;
  /**
   * 无感反馈的幂等锚（`tasks.idempotency_key`）。
   *
   * 为什么必须读它、不能让 worker 拿 taskId 代：重投 / `/retry` / 超时重跑都会产生
   * 新 taskId，用它当锚点等于没有幂等（同一阶段被反复记账、反复打 reaction）。
   */
  readonly idempotencyKey: string | null;
  /**
   * `tasks.source`（`webhook` / `command` / `cron`）：决定这一轮能不能写回评论。
   * 认不出的值给 `null`，由 `writeback.ts::taskSourceOf()` 按命令名兜底推断。
   */
  readonly source: TaskSourceKind | null;
}

const READ_TASK_SQL = `select "id", "command", "repo", "target_kind", "target_number", "head_sha", "attempt",
  "prompt_text", "actor_login", "idempotency_key", "source"
from "tasks" where "id" = $1`;

/**
 * 读任务行。找不到 → 抛 `TASK_NOT_FOUND`。
 *
 * 为什么 worker 不自己查库：`worker/` 只吃注入的 `RunStore`（写）与输入对象（读），
 * 「任务从哪来」是装配层的知识。这样 worker 的单测完全不需要库。
 */
export async function readTaskRow(db: SqlExecutor, taskId: string): Promise<TaskJobRow> {
  const result = await db.query(READ_TASK_SQL, [taskId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new AppError(`任务不存在：${taskId}`, {
      code: WORKER_ASSEMBLY_ERROR_CODES.taskNotFound,
      failureClass: 'unknown',
      retriable: false,
      details: { taskId },
    });
  }
  const targetKind = row['target_kind'];
  if (targetKind !== 'issue' && targetKind !== 'pr') {
    throw new AppError(`任务 ${taskId} 的 target_kind 非法：${String(targetKind)}`, {
      code: WORKER_ASSEMBLY_ERROR_CODES.taskRepoUnusable,
      failureClass: 'parse',
      retriable: false,
    });
  }
  const attempt = row['attempt'];
  return {
    id: String(row['id']),
    command: String(row['command']),
    repo: String(row['repo']),
    targetKind,
    targetNumber: Number(row['target_number']),
    headSha: typeof row['head_sha'] === 'string' ? row['head_sha'] : null,
    promptText: typeof row['prompt_text'] === 'string' ? row['prompt_text'] : null,
    actorLogin: typeof row['actor_login'] === 'string' ? row['actor_login'] : null,
    idempotencyKey: typeof row['idempotency_key'] === 'string' ? row['idempotency_key'] : null,
    source: toTaskSource(row['source']),
    attempt: typeof attempt === 'number' ? attempt : 0,
  };
}

/** `tasks.source` → `TaskSourceKind`；认不出（老行 / NULL）就给 `null`（交给兜底推断）。 */
function toTaskSource(value: unknown): TaskSourceKind | null {
  return typeof value === 'string' && (TASK_SOURCE_KINDS as readonly string[]).includes(value)
    ? (value as TaskSourceKind)
    : null;
}


/* ── 提示词 ───────────────────────────────────────────────────────────────── */

export interface TaskPromptInput {
  readonly command: string;
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly dryRun: boolean;
  /**
   * 仓库配置快照（`repos.settings`）。目前只用来渲染**项目标签词表**；
   * 缺省时退回「只打仓库已有标签」的说明（不猜标签名）。
   */
  readonly settings?: RepoSettings | null;
}

/**
 * 拼提示词的**骨架**。
 *
 * 三件事：身份与命令 → 两段式输出要求（人话 + 唯一 json 信封）→ **项目标签词表**。
 *
 * 标签这一段的由来（W2-E）：旧版在提示词里写死了一串示范标签
 * （`bug / feature / question / docs / needs-info / area/db`），于是每个仓库都被教成
 * 同一套「平台词汇」，和面板里配的 `labels.vocabulary` 毫无关系、还诱导模型发明标签。
 * 现在改为按 `settings.labels.vocabulary` 渲染；没有词表时明说「只能用已有标签」。
 */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const target = `${input.targetKind} #${String(input.targetNumber)}`;
  const vocabulary = input.settings?.labels.vocabulary ?? [];
  const exampleLabel = vocabulary[0]?.name;
  return [
    `你是 pi-bot，正在处理 ${input.repo} 的 ${target}。`,
    `命令：${input.command}`,
    input.dryRun ? '本轮是 dry-run：只做判断，不要做任何写操作。' : '本轮可以做写操作（受输出白名单约束）。',
    '',
    '输出分两段，顺序不能反，也不要再加别的段落：',
    '',
    '【第一段】给人看的回复：中文，不超过 8 行，先给结论再给依据；',
    '信息不足就直接说缺哪几项，不要编造。不要写 JSON、不要加代码围栏。',
    '这一段会原样贴到 issue 上（它自己就能成立，别指望第二段替它说话）。',
    '',
    '【第二段】**唯一**一个 ```json 代码块，机器用它打标与写回。硬要求：',
    '- 它是整条消息的**最后一个**代码块，块内是能直接 `JSON.parse` 的裸 JSON',
    '  （不要注释、不要 trailing comma、不要 ```jsonc）；',
    '- 顶层只允许 verdict / actions / usage 三个键，多一个键即不合规；',
    '- `usage` 三个字段都必须给数字（不知道就写 0），缺一个即不合规；',
    '- `verdict.evidence` 的每一项都必须同时有非空的 `rule` 与 `quote`（没有证据就给空数组）；',
    '',
    '```json',
    '{',
    '  "verdict": {',
    '    "kind": "issue",',
    `    "labels": [${exampleLabel === undefined ? '' : JSON.stringify(exampleLabel)}],`,
    '    "evidence": [{ "rule": "repro-steps", "quote": "引用的原文片段", "passed": true }]',
    '  },',
    '  "actions": [{ "intent": "comment", "body": "与第一段一致的说明（可省略这条动作）" }],',
    '  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 }',
    '}',
    '```',
    '- `verdict.kind` 只能是 "issue" 或 "pr"；',
    '- `verdict.labels` 只能填「**项目标签**」一节里列出的标签名，没有把握就留空数组；',
    '- `actions` 里只允许 `comment`（本命令的 outputs 只含 comment 与 label）。',
    '',
    renderLabelVocabulary(vocabulary),
  ].join('\n');
}

/**
 * 自由问答（`@bot 你的问题`）的提示词：**只允许产出 comment**。
 *
 * 与 `buildTaskPrompt` 的区别：没有「打标签」这个诉求，所以 `verdict.labels` 恒为空，
 * 问题正文来自触发评论（编码在 `tasks.command` 里，见 `http/webhook.ts::decodeFreeQuestion`）。
 */
export function buildAnswerPrompt(input: {
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly question: string;
}): string {
  return [
    `你是 pi-bot，正在 ${input.repo} 的 ${input.targetKind} #${String(input.targetNumber)} 上回答提问。`,
    '',
    '提问原文（用户 @ 你时写的）：',
    '```text',
    input.question.slice(0, 4000),
    '```',
    '',
    '要求：',
    '1. 直接回答提问：先结论，再依据；引用代码/日志时给出文件路径与行号。',
    '2. 需要看代码就去读仓库里的文件（工作目录就是该仓库的检出），不要凭空猜测。',
    '3. 中文，不超过 12 行；不确定就说不确定，并说明还缺什么信息。',
    '4. **不要**提问、不要要求用户粘贴更多内容除非确实必要；不要自称 AI。',
    '输出分两段，顺序不能反，也不要再加别的段落：',
    '',
    '【第一段】给人看的回答（就是上面 1–4 那几条的要求）。它会被**原样**贴到 issue 上，所以：',
    '- 这一段自己就要能独立读懂：不要提「信封 / verdict / actions」，不要写 JSON，不要加任何代码围栏；',
    '- 机器解析不了第二段时，我们只发这一段 —— 不要指望第二段替你说话。',
    '',
    '【第二段】**唯一**一个 ```json 代码块，必须是整条消息的**最后一段**。硬要求：',
    '- 它是最后一个代码块，块内是能直接 `JSON.parse` 的裸 JSON（不要注释、不要 trailing comma、不要 ```jsonc）；',
    '- 顶层只允许 verdict / actions / usage 三个键，多一个键即不合规；',
    '- `usage` 三个字段都必须给数字（不知道就写 0），缺一个即不合规；',
    '- `verdict.evidence` 每项都必须同时有非空的 `rule` 与 `quote`（本命令没有证据就给空数组）；',
    '',
    '下面这份就是字段全集与形状（照抄结构，值按实际填）：',
    '```json',
    '{',
    `  "verdict": { "kind": "${input.targetKind}", "labels": [], "evidence": [] },`,
    '  "actions": [{ "intent": "comment", "body": "把第一段的回答原样放这里（同样不要再嵌 JSON）" }],',
    '  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 }',
    '}',
    '```',
    `- \`verdict.kind\` 只能是 "${input.targetKind}"（按目标类型填 "issue" 或 "pr"）；`,
    '- `verdict.labels` 恒为空数组（本命令不打标）；',
    '- `actions` 只允许一条 `{ "intent": "comment", "body": "…" }`（本命令的 outputs 只含 comment）。',
  ].join('\n');
}

/* ── 端口集合 ─────────────────────────────────────────────────────────────── */

/** worker 需要的全部端口（`ops` / `events` 由每一次 run 的 RACP 通道提供）。 */
export interface WorkerPorts {
  readonly worktree: WorktreePort;
  readonly docker: SandboxDocker;
  readonly proxy: ExecProxyPort;
  readonly host: HostPort;
  readonly lifecycle: LifecycleDisposer;
  readonly store: RunStore;
  readonly github: GithubWriteApi;
}

/** 除 `ops` / `events` 之外的 worker 依赖（每次 run 把这两项补上）。 */
export type WorkerBaseDeps = Omit<TaskRunnerDeps, 'ops' | 'events'>;

export interface CreateWorkerPortsOptions {
  readonly config: AppConfig;
  readonly pool: SqlExecutor;
  readonly logger: Logger;
  /** 注入点：不给就真起 docker / 真建 exec 代理 */
  readonly docker?: SandboxDocker;
  readonly worktree?: WorktreePort;
  readonly host?: HostPort;
  readonly github?: GithubWriteApi;
}

/**
 * 默认装配：docker → exec 代理 → 生命周期执行器 → 端口。
 *
 * `lifecycle` 必须拿得到**同一个** exec 代理实例（销毁容器时要清端点，§6.3 的 (b)），
 * 所以这里把 `ExecProxy` 实例保留在局部变量里，同时把它包成 worker 的窄端口。
 */
export function createWorkerPorts(options: CreateWorkerPortsOptions): WorkerPorts {
  const docker = options.docker ?? createSandboxDocker();
  const execProxy = new ExecProxy({
    docker,
    logger: toSandboxLogger(options.logger),
  });
  const proxy = createExecProxyPort(execProxy);
  const lifecycle = createLifecycleDisposer(
    createLifecycleExecutor({
      docker,
      // `EndpointReaper` 与 `ExecProxyPort` 的 `destroy({jobId})` 是同一形状
      proxy,
      logger: toSandboxLogger(options.logger),
    }),
  );

  const github =
    options.github ??
    (options.config.github.token === null
      ? createUnavailableGithubWriteApi('未配置 PI_BOT_GITHUB_TOKEN')
      : createGithubWriteApi(createGithubClient({ authToken: options.config.github.token })));

  return {
    // worktree 的真实实现归 `git/`（`createRepoWorktreePort`），由 `compose.ts` 决定要不要接；
    // 没接上时用 worker 的默认「明确失败」端口（`WORKTREE_UNAVAILABLE`）
    worktree: options.worktree ?? createUnavailableWorktreePort(),
    docker,
    proxy,
    host: options.host ?? createUnavailableHostPort('未配置 pi-host bundle（PI_BOT_HOST_BUNDLE_DIR）'),
    lifecycle,
    // `RunStore` 的 PG 实现只在装配层出现：worker 拿不到池
    store: createPgRunStore({ pool: options.pool }),
    github,
  };
}

/** `sandbox/` 的日志面：只要 `info/warn/error/debug`，与 shared 的 `Logger` 天然兼容。 */
function toSandboxLogger(logger: Logger): {
  info: (fields: Record<string, unknown> | string, message?: string) => void;
  warn: (fields: Record<string, unknown> | string, message?: string) => void;
  error: (fields: Record<string, unknown> | string, message?: string) => void;
  debug: (fields: Record<string, unknown> | string, message?: string) => void;
  child: (fields: Record<string, unknown>) => SandboxLogger;
} {
  return {
    info: (fields, message) => {
      logger.info(fields, message);
    },
    warn: (fields, message) => {
      logger.warn(fields, message);
    },
    error: (fields, message) => {
      logger.error(fields, message);
    },
    debug: (fields, message) => {
      logger.debug(fields, message);
    },
    // `sandbox/` 的 logger 面要求 `child`（exec 代理会按 jobId 派生）：转调 shared 的 `child`
    child: (fields) => toSandboxLogger(logger.child(fields)),
  };
}

/** 把端口 + 配置拼成 worker 的「静态依赖」（每次 run 再补 `ops` / `events`）。 */
export function createWorkerBaseDeps(
  ports: WorkerPorts,
  options: {
    readonly config: AppConfig;
    readonly logger: Logger;
    readonly onStep?: TaskRunnerDeps['onStep'];
  },
): WorkerBaseDeps {
  return {
    worktree: ports.worktree,
    docker: ports.docker,
    proxy: ports.proxy,
    host: ports.host,
    lifecycle: ports.lifecycle,
    store: ports.store,
    github: ports.github,
    image: options.config.worker.image,
    networkMode: options.config.worker.network,
    allowPushBranch: options.config.worker.allowPushBranch,
    logger: options.logger,
    ...(options.onStep === undefined ? {} : { onStep: options.onStep }),
  };
}

/* ── 无感反馈 / 打标策略（W2-D + W2-E 的装配点）──────────────────────────────── */

/**
 * 无感反馈的装配（W2-D）：`issue_feedback` 台账 + reaction 写面 + 降级开关。
 *
 * 为什么必须有这个函数：`FeedbackDeps` 的三件东西分别住在 `feedback/`（台账）、
 * `github/`（REST）与 `runtime_flags`（降级开关）里，**只有装配层同时认识它们**。
 * 之前 compose 直接把 `feedback` 忘掉了 → 生产环境一个 reaction 都不会打。
 *
 * 返回 `null` 表示「这个部署没有可用的 reaction 写面」（没装 App / 没令牌）：
 * `worker` 那边缺端口就是不打 reaction，而不是每轮记一条失败。
 */
export function createWorkerFeedbackDeps(options: {
  readonly pool: SqlExecutor;
  /** 现成的 reaction 写面（测试注入）；缺省由 `client` 造。 */
  readonly reactions?: GithubReactionApi;
  /** App 认证的客户端（`resolveGithubAuth()` 的产物）；没有它就返回 `null`。 */
  readonly client?: GithubClient | null;
  /** 本 App 的 slug（`user.login` 是 `<slug>[bot]`）；不传就只按 `[bot]` 后缀判。 */
  readonly appSlug?: string | null;
}): FeedbackDeps | null {
  const reactions =
    options.reactions ??
    (options.client === undefined || options.client === null
      ? null
      : createGithubReactionApi(options.client));
  if (reactions === null) {
    return null;
  }
  return {
    ledger: createPgFeedbackLedger({ pool: options.pool }),
    reactions,
    flags: createPgReactionsFlagStore({ pool: options.pool }),
    ...(options.appSlug === undefined || options.appSlug === null || options.appSlug === ''
      ? {}
      : { appSlug: options.appSlug }),
  };
}

/**
 * 打标策略的装配（W2-E）：`settings.labels` + 人工否决（`bot_labels`）+ `label_decisions`。
 *
 * 每轮任务建一次（不是进程启动时）：`settings` 是**仓库级**的，人工否决与
 * `judgement_hash` 是**目标/轮次级**的，缓存在进程里只会读到上一个仓库的配置。
 */
export function createLabelWritebackPolicy(options: {
  readonly pool: SqlExecutor;
  /** `readRepoPolicy().settings`（可能是 last-known-good / `null`）。 */
  readonly settings: RepoSettings | null;
  /** 判定快照哈希（webhook 的 issue 版本 hash）→ `label_decisions.judgement_hash`。 */
  readonly judgementHash?: string | null;
  readonly catalog?: LabelCatalogPort | undefined;
  readonly reactions?: ReactionPort | undefined;
}): LabelWritebackPolicy {
  const runner = toSqlRunner(options.pool);
  return {
    // settings 读不出来时用契约默认值：宁可只按「上限 + 人工否决」打标，
    // 也不要因为一份坏 jsonb 让「所有仓库都不打标签」。
    labels: (options.settings ?? parseRepoSettings({})).labels,
    humanVetoed: ({ repo, targetNumber }) => loadHumanVetoed(runner, { repo, issueNumber: targetNumber }),
    decisions: createPgLabelDecisionRecorder(runner),
    ...(options.judgementHash === undefined || options.judgementHash === null
      ? {}
      : { judgementHash: options.judgementHash }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.reactions === undefined ? {} : { reactions: options.reactions }),
  };
}

/**
 * `bot_labels` 的记账器（W2-E 的归因表）。
 *
 * 为什么它必须被注入：`github/executor.ts` 的「只增删自己打过的标签」与
 * `normalizeDesired()` 的「人工否决」**都**以 `bot_labels` 为事实源。不注入 = 这张表
 * 永远是空的：重算时删不掉自己打过的标签，人撕掉的标签下一轮又会被贴回去。
 */
export function createBotLabelLedger(pool: SqlExecutor): BotLabelLedger {
  return createPgBotLabelLedger(toSqlRunner(pool));
}

/**
 * 标签目录端口（`labels.missing` 的判据）：`GET/POST /repos/:o/:r/labels`。
 *
 * 为什么放在装配层而不是 `github/`：`GithubWriteApi` 刻意只含「写 issue」那几个动作，
 * 标签目录是**仓库元数据**，只有 `labels.missing` 需要它。放在这里也不给
 * `github/` 添第 7 个方法（那会让所有假实现一起改签名）。
 */
export function createGithubLabelCatalog(client: GithubClient): LabelCatalogPort {
  return {
    async list(input) {
      const ref = splitRepo(input.repo);
      const response = await client.request<readonly { readonly name?: unknown }[]>(
        'GET /repos/{owner}/{repo}/labels',
        { owner: ref.owner, repo: ref.repo, per_page: 100 },
      );
      const rows = Array.isArray(response.data) ? response.data : [];
      return rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string' && name !== '');
    },
    async create(input) {
      const ref = splitRepo(input.repo);
      await client.request('POST /repos/{owner}/{repo}/labels', {
        owner: ref.owner,
        repo: ref.repo,
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.description === undefined ? {} : { description: input.description }),
      });
    },
  };
}

/** `workflows/` 的 reaction 端口 → `feedback/` 的 reaction 写面（同一个 REST 通道）。 */
export function createWorkflowReactionPort(reactions: GithubReactionApi): ReactionPort {
  return {
    async add(input) {
      await reactions.addReaction({
        repo: input.repo,
        issueNumber: input.targetNumber,
        content: input.content,
      });
    },
  };
}

/* ── 提示词装配（M1：AGENTS.md + 技能正文真正进入提示词）─────────────────────── */

/**
 * 单个仓库技能文件的字节上限。
 *
 * 技能目录（`.github/pi-bot/skills/`）是**仓库内容**，随时可能被改成巨型文件或垃圾；
 * 装配路径上不值得为它读 10 MB。超限只跳过该文件并 warn，不影响其它技能。
 */
export const REPO_SKILL_MAX_BYTES = 262_144;

/** `TaskRunnerDeps.promptEnricher` 的具体形状（避免每处再抄一遍长签名）。 */
export type PromptEnricher = NonNullable<TaskRunnerDeps['promptEnricher']>;

export interface PromptEnricherOptions {
  readonly logger?: Logger;
  /** 技能的仓库配置快照（`readRepoPolicy().config`）；只用于 `requires-repo-config` 的判定。 */
  readonly config?: SkillRepoConfig | null;
  /**
   * 技能渲染上下文（`{{repo}}` / `{{target}}` / `{{title}}` …）。
   *
   * 为什么由调用方给：这些值来自**任务行**（`tasks` 表），是装配层的知识；
   * 而 enricher 的入参只有 worktree/basePrompt/command（`worker/types.ts` 的约定）。
   */
  readonly context: SkillPromptContext;
  /**
   * 额外技能文件：M2 面板上传的技能（zip → store）解出来之后塞这里，
   * 与本轮仓库技能走**同一条**装配（`createSkillRegistry` 的 `repoSkills`）。
   * 优先级同 spec §7：面板-仓库 > 面板全局 > 仓库文件 > 内置。
   */
  readonly extraSkillFiles?: readonly SkillFile[];
  /**
   * P1「项目人格层」与装配统计的落库端口（`prompt_versions` / `runtime_flags`）。
   *
   * 为什么是「给库、不给正文」：每轮任务都要读一次**当前启用**的版本正文
   * （`activePromptBody()`），在进程启动时缓存住就等于「面板改了要重启才生效」。
   * 不给 = 装配结果与「没有 P1」逐字节一致（老装配 / 单测）。
   */
  readonly db?: SqlRunner | undefined;
}

/**
 * 读 worktree 里的仓库技能文件。
 *
 * 目录不存在是**常态**（绝大多数仓库没有仓库技能），不是错误、也不记日志；
 * 只读普通 `.md` 文件（`Dirent.isFile()` 对软链为 false，所以顺手挡住了软链逃逸）。
 */
async function readRepoSkillFiles(worktreeDir: string, logger?: Logger): Promise<readonly SkillFile[]> {
  const dir = path.join(worktreeDir, REPO_SKILLS_DIR);
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const files: SkillFile[] = [];
  for (const name of names) {
    const relPath = `${REPO_SKILLS_DIR}/${name}`;
    try {
      const buffer = await readFile(path.join(dir, name));
      if (buffer.length > REPO_SKILL_MAX_BYTES) {
        logger?.warn({ path: relPath, bytes: buffer.length }, '仓库技能文件超过 256 KB，已跳过');
        continue;
      }
      files.push({ path: relPath, text: buffer.toString('utf8') });
    } catch (error) {
      logger?.warn({ path: relPath, err: String(error) }, '仓库技能文件读取失败，已跳过');
    }
  }
  return files;
}

/**
 * 默认的提示词 enricher（装配层实现，worker 只认 `TaskRunnerDeps.promptEnricher` 这个钩子）。
 *
 * 三步（spec §7 的装配顺序里属于「层」的那两步 + 交给 `assemblePrompt` 合成）：
 *  1. `collectAgentsMd()`：根 AGENTS.md 总是进，就近窗按 hintPaths（本轮只给根，见下）；
 *  2. 仓库技能 `<worktree>/.github/pi-bot/skills/*.md` → `createSkillRegistry`（内置技能也在里面，
 *     所以即使仓库一个技能文件都没有，`/issue-triage` 这类内置技能照样能装配）；
 *  3. `command` 命中技能 → `renderSkillPrompt()` → `assemblePrompt({ basePrompt, agentsMd, skill })`。
 *
 * **不抛异常**是调用方（`worker/run-task.ts`）的责任，但这里也尽量把「读不到」变成「少一段」：
 * 唯一的抛错来源是 `assemblePrompt`（纯函数，实际不会抛）。
 */
export function createPromptEnricher(options: PromptEnricherOptions): PromptEnricher {
  const logger = options.logger;
  const extraSkillFiles = options.extraSkillFiles ?? [];

  return async (input) => {
    const repoSkillFiles = await readRepoSkillFiles(input.worktreeDir, logger);
    const repoSkills = [...repoSkillFiles, ...extraSkillFiles];
    const registry = createSkillRegistry({
      ...(repoSkills.length === 0 ? {} : { repoSkills }),
      config: options.config ?? null,
      ...(logger === undefined ? {} : { logger }),
    });
    const skill = input.command === null ? undefined : registry.resolve(input.command);

    const agentsMd = await collectAgentsMd({
      worktreeDir: input.worktreeDir,
      // 任务涉及路径：本轮拿不到「issue 正文里提到的文件/报错路径」（要读正文，见 M3），
      // 所以先只进根 AGENTS.md；`hintPaths` 一有值，就近层就自动生效（逻辑已在 agents-md 里）。
      hintPaths: [],
    });

    // ── P1「项目人格层」（W3-G）：插在 head 之后、AGENTS.md 之前 ────────────────
    // 读库失败 / 没有版本 / 开关关掉 一律给空串 —— 装配结果与「没有 P1」逐字节一致，
    // 所以这里不需要区分「没有 P1」与「P1 读不到」（后者多记一条 warn）。
    const repo = options.context.repo;
    let projectPrompt = '';
    if (options.db !== undefined) {
      try {
        projectPrompt = await activePromptBody(options.db, repo);
      } catch (error) {
        logger?.warn(
          { repo, err: error instanceof Error ? error.message : String(error) },
          '读项目提示词（P1）失败，本轮按「没有 P1」装配',
        );
      }
    }

    const assembled = assemblePrompt({
      basePrompt: input.basePrompt,
      projectPrompt,
      agentsMd,
      skill:
        skill === undefined
          ? null
          : {
              name: skill.name,
              promptText: renderSkillPrompt({
                skill,
                // 标签词表来自仓库配置（`options.config` 是注册表需要的切片，含 `labels`）：
                // 装配层唯一知道 settings 的地方就是这里，所以在这一层把它补进渲染上下文。
                context:
                  options.config === undefined || options.config === null
                    ? options.context
                    : { ...options.context, config: options.config },
                // 输出契约由 `basePrompt` 的尾部负责，且必须是**最后**一段；
                // 这里再塞一份会让模型看到两个互相冲突的信封格式（`renderSkillPrompt` 自带的那份
                // 用的是技能自己的 outputs，与 `buildTaskPrompt` 的命令级契约不是一回事）。
                includeEnvelopeInstruction: false,
              }).prompt,
            },
    });

    // 整段丢弃（超预算）必须出声：静默丢层会让「技能/AGENTS.md 明明写了却不生效」难以归因。
    if (assembled.stats.truncated.length > 0) {
      logger?.warn(
        { repo, truncated: assembled.stats.truncated, totalChars: assembled.stats.totalChars },
        '提示词超出总预算：已按层整段丢弃（面板「最终装配预览」看得到丢弃标记）',
      );
    }

    // 装配统计落库（`runtime_flags{key:'assemble:prompt:stats'}`）：面板保存 P1 时的预算预演要读它。
    // 写失败只 warn：统计不是判定，缺一次不该让任务或装配失败。
    if (options.db !== undefined) {
      try {
        await recordAssembleStats(options.db, repo, assembled.stats);
      } catch (error) {
        logger?.warn(
          { repo, err: error instanceof Error ? error.message : String(error) },
          '装配统计写库失败（已忽略）',
        );
      }
    }

    logger?.debug(
      {
        command: input.command,
        skill: skill?.name ?? null,
        repoSkills: repoSkillFiles.length,
        agentsMdRoot: agentsMd.root !== null,
        agentsMdNearby: agentsMd.nearby.map((section) => section.path),
        agentsMdSkipped: agentsMd.skipped,
        ...assembled.stats,
      },
      '提示词装配完成（AGENTS.md + 技能）',
    );

    return assembled.prompt;
  };
}
