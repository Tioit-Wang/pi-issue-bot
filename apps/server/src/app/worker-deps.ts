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
import { AppError } from '../../../../packages/shared/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { createGithubWriteApi, createGithubClient } from '../github/index.ts';
import type { GithubWriteApi } from '../github/index.ts';
import type { SqlExecutor } from '../db/index.ts';
import {
  createExecProxyPort,
  createLifecycleDisposer,
  createPgRunStore,
  createUnavailableWorktreePort,
} from '../worker/index.ts';
import type {
  ExecProxyPort,
  HostPort,
  LifecycleDisposer,
  RunStore,
  TaskRunnerDeps,
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
}

const READ_TASK_SQL = `select "id", "command", "repo", "target_kind", "target_number", "head_sha", "attempt", "prompt_text", "actor_login"
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
    attempt: typeof attempt === 'number' ? attempt : 0,
  };
}

/* ── 提示词 ───────────────────────────────────────────────────────────────── */

export interface TaskPromptInput {
  readonly command: string;
  readonly repo: string;
  readonly targetKind: 'issue' | 'pr';
  readonly targetNumber: number;
  readonly dryRun: boolean;
}

/**
 * 拼提示词的**骨架**。
 *
 * TODO(owner: W4-M `skills/`)：技能模板（`renderSkillPrompt`）+ 仓库配置 + 不可信正文的围栏
 * 都归 `skills/`，本切片只放一个能让端到端链路跑通的最小骨架 —— 关键是**必须显式要求
 * 输出 JSON 信封**，否则 `worker/envelope.ts` 的 `findEnvelopeText` 找不到东西，
 * 任务会被判成 `parse` 失败（那是「装配漏了」，不是「模型不听话」）。
 */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const target = `${input.targetKind} #${String(input.targetNumber)}`;
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
    '    "labels": ["bug"],',
    '    "evidence": [{ "rule": "repro-steps", "quote": "引用的原文片段", "passed": true }]',
    '  },',
    '  "actions": [{ "intent": "comment", "body": "与第一段一致的说明（可省略这条动作）" }],',
    '  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0 }',
    '}',
    '```',
    '- `verdict.kind` 只能是 "issue" 或 "pr"；',
    '- `verdict.labels` 只能填仓库 `labels.map` 里映射过的判定键（bug / feature / question / docs / needs-info / area/db），',
    '没有把握就留空数组；',
    '- `actions` 里只允许 `comment`（本命令的 outputs 只含 comment 与 label）。',
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
