/**
 * dispatcher（S1 的串行调度，`docs/dev-plan-issue-agent.md` §2.1「同 issue 串行（v2 修正机制）」）。
 *
 * 为什么不用 pg-boss 的 `singletonKey` 排队：本仓 `queue/boss.ts` 的注释写明「同 key 已在队列
 * 就不再入队，`send()` 返回 null」——那样同一 issue 的第二条消息会被**丢掉**而不是排队（X-14）。
 *
 * 所以排队语义落在 `agent_messages` 上：
 *
 * ```
 * agent-dispatch（每 10s，concurrency=1）
 *   → 列出「有 queued 且没有 running」的 issue（最老的先）
 *   → 每个 issue 领一条：UPDATE … FOR UPDATE SKIP LOCKED → status='running'
 *   → 建 tasks（source='agent'，幂等键按消息算）+ 投 run-task（singletonKey 按消息唯一）
 *   → 任务结束（`app/compose.ts`）→ 该行 done/failed → **立刻**再领这个 issue 的下一条
 * ```
 *
 * 「立刻取下一条」由装配层在任务结束后调用 `finishMessageAndContinue()`；cron 那条只是兜底
 * （进程重启、上一轮投递失败等）。
 *
 * 已知窗口：两个 dispatcher 真同时进 `claimOldest` 时仍可能各领到同一 issue 的不同消息
 * （`NOT EXISTS (running)` 是快照判定）。`queue.agentDispatch` 的 concurrency=1 把窗口压到
 * 一次语句的时间；要彻底消灭需要一条部分唯一索引（`(repo, issue_number) WHERE status='running'`），
 * 见 S1 报告的「没做完」一节。
 */
import { randomUUID } from 'node:crypto';
import { AGENT_DISPATCH_MAX_ISSUES } from './constants.ts';
import {
  agentTaskCommand,
  claimNextForIssue,
  insertAgentTask,
  listQueuedIssueKeys,
  markMessage,
} from './store.ts';
import type { AgentMessageRow } from './store.ts';
import type { SqlRunner } from '../config/repo-config.ts';

/** 入队一个任务（装配层接线到 `queue/boss.ts` 的 `enqueueTask`）。 */
export type AgentDispatchEnqueue = (input: {
  readonly taskId: string;
  readonly repo: string;
  readonly command: string;
  readonly message: AgentMessageRow;
}) => Promise<string | null>;

export type AgentDispatchLogger = {
  info(detail: Readonly<Record<string, unknown>>, message: string): void;
  warn(detail: Readonly<Record<string, unknown>>, message: string): void;
};

export type AgentDispatchDeps = {
  readonly db: SqlRunner;
  readonly enqueue: AgentDispatchEnqueue;
  readonly logger?: AgentDispatchLogger | undefined;
  /** 一轮最多处理多少个 issue（缺省 `AGENT_DISPATCH_MAX_ISSUES`）。 */
  readonly maxIssues?: number | undefined;
  /** 任务 id 生成器（测试注入固定值）。 */
  readonly newTaskId?: (() => string) | undefined;
};

export type AgentDispatchResult = {
  /** 领到（= 置成 running）的消息数 */
  readonly claimed: number;
  /** 真的投进 `run-task` 的消息数 */
  readonly enqueued: number;
  /** 投递失败（已置 failed，等下一轮/人工重试） */
  readonly failed: number;
};

/** 一次「领下一条」的结果。 */
export type AgentDispatchOutcome = {
  /** 领到的消息（没有可领的 → `null`） */
  readonly message: AgentMessageRow | null;
  /** 是否真的投进了 `run-task` */
  readonly enqueued: boolean;
  /** 投递失败（已置 failed） */
  readonly failed: boolean;
};

/**
 * 领这个 issue 的**下一条**消息并投递（任务结束时的「立刻取下一条」也走这里）。
 *
 * 没有可领的 → `{message:null}`。投递失败时消息会被置 `failed`（不留在 running 里卡住整条
 * issue 队列 —— 需求 D6「不影响这个 issue 的下一条消息」）。
 */
export async function dispatchNextForIssue(
  deps: AgentDispatchDeps,
  key: { readonly repo: string; readonly issueNumber: number },
): Promise<AgentDispatchOutcome> {
  const message = await claimNextForIssue(deps.db, key);
  if (message === null) {
    return { message: null, enqueued: false, failed: false };
  }
  const newTaskId = deps.newTaskId ?? ((): string => randomUUID());
  const inserted = await insertAgentTask(deps.db, {
    taskId: newTaskId(),
    key: {
      repo: message.repo,
      issueNumber: message.issueNumber,
      fingerprint: message.fingerprint,
    },
    kind: message.kind,
    body: message.body ?? '',
    // 真实提问人：写回时靠它加 `@login`（不传就回落成 `agent`，即旧行为）
    actorLogin: message.actorLogin,
    // 点名的技能 id（见 `tasks.agent_skill_ids`）：正文里的 `/name` 已被摘掉，只能靠它传递。
    skillIds: message.skillIds,
  });
  const taskId = inserted.taskId;
  if (taskId === null) {
    // 幂等键命中（这条消息此前已经建过任务）：当作已投递，终态留给上层写
    deps.logger?.warn(
      { repo: message.repo, issue: message.issueNumber, fingerprint: message.fingerprint },
      'agent 消息的幂等键已存在（此前建过任务），不再重复入队',
    );
    return { message, enqueued: true, failed: false };
  }
  try {
    const jobId = await deps.enqueue({
      taskId,
      repo: message.repo,
      command: agentTaskCommand(message.kind),
      message,
    });
    deps.logger?.info(
      {
        repo: message.repo,
        issue: message.issueNumber,
        fingerprint: message.fingerprint,
        taskId,
        jobId,
      },
      jobId === null ? 'agent 消息已在队列中（singletonKey 命中）' : 'agent 消息已投递',
    );
    return { message, enqueued: true, failed: false };
  } catch (error) {
    await markMessage(
      deps.db,
      { repo: message.repo, issueNumber: message.issueNumber, fingerprint: message.fingerprint },
      'failed',
    );
    deps.logger?.warn(
      {
        repo: message.repo,
        issue: message.issueNumber,
        fingerprint: message.fingerprint,
        taskId,
        err: error instanceof Error ? error.message : String(error),
      },
      'agent 消息投递失败：置 failed（下一轮/人工重试）',
    );
    return { message, enqueued: false, failed: true };
  }
}

/**
 * 一轮扫描：把「每个 issue 最老的一条 queued」各投一次。
 *
 * 一个 issue 只会领一条（已有一条 running 的 issue 直接跳过），所以 3 条消息不会在 10 秒内
 * 变成 3 个并行任务（X-14）。
 */
export async function dispatchAgentMessages(deps: AgentDispatchDeps): Promise<AgentDispatchResult> {
  const limit = deps.maxIssues ?? AGENT_DISPATCH_MAX_ISSUES;
  const issues = await listQueuedIssueKeys(deps.db, limit);
  let claimed = 0;
  let enqueued = 0;
  let failed = 0;
  for (const issue of issues) {
    const outcome = await dispatchNextForIssue(deps, issue);
    if (outcome.message === null) {
      continue;
    }
    claimed += 1;
    if (outcome.enqueued) {
      enqueued += 1;
    }
    if (outcome.failed) {
      failed += 1;
    }
  }
  if (claimed > 0) {
    deps.logger?.info({ issues: issues.length, claimed, enqueued, failed }, 'agent dispatcher 一轮结束');
  }
  return { claimed, enqueued, failed };
}

/**
 * 任务结束后的收尾：把这条消息置 `done` / `failed`，然后**立刻**领这个 issue 的下一条。
 *
 * 为什么不把它塞进 `dispatchAgentMessages`：任务结束时消息是 `running` 的，而
 * `listQueuedIssueKeys` 会排除有 `running` 的 issue —— 只有先写终态，下一条才看得见。
 */
export async function finishMessageAndContinue(
  deps: AgentDispatchDeps,
  input: {
    readonly repo: string;
    readonly issueNumber: number;
    readonly fingerprint: string;
    readonly status: 'done' | 'failed';
  },
): Promise<AgentDispatchOutcome> {
  await markMessage(
    deps.db,
    { repo: input.repo, issueNumber: input.issueNumber, fingerprint: input.fingerprint },
    input.status,
  );
  return dispatchNextForIssue(deps, { repo: input.repo, issueNumber: input.issueNumber });
}
