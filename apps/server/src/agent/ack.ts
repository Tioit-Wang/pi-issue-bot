/**
 * 回执（需求 §1.2 的第 2 步与最后一步：**加 reaction → 处理完移除**）。
 *
 * 复用 `feedback/` 的 reaction 写面：`addReaction`（POST）与 `removeOwnReaction`（列一遍、
 * 只删自己打的）。为什么不自造一套：终态反馈（`-eyes +rocket`）已经在用同一个写面，
 * 两套实现必然有一处会打歪（评论级 vs 主贴）。
 *
 * **没有写面时静默**：本机没装 App / 单测没注入时 `reactions` 是 `undefined`，
 * 这里返回 `{applied:false}` 而不是抛错——回执失败不该让一条消息处理不了。
 */
import { removeOwnReaction } from '../feedback/index.ts';
import type { GithubReactionApi } from '../github/index.ts';

/** 回执依赖：只缺 `reactions` 就静默。 */
export type AgentAckDeps = {
  readonly reactions?: GithubReactionApi | undefined;
  /** App 的 slug（`user.login` 为 `<slug>[bot]`）；不传就只按 `[bot]` 后缀判归属。 */
  readonly appSlug?: string | null | undefined;
  readonly logger?:
    | {
        warn(detail: Readonly<Record<string, unknown>>, message: string): void;
      }
    | undefined;
};

/** 回执打到哪儿（`commentId` 给了就是评论级，否则主贴）。 */
export type AgentAckTarget = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly commentId?: number | null;
};

export type AgentAckResult = {
  /** 是否真的打了 GitHub 调用 */
  readonly applied: boolean;
  /** `applied=false` 时说明为什么（没写面 / 抛错） */
  readonly reason: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 收到消息：打 `eyes`（「已收到，排队中」）。失败只记 warn（GitHub 抖动不该拖死入队）。
 */
export async function ackReceived(deps: AgentAckDeps, target: AgentAckTarget): Promise<AgentAckResult> {
  if (deps.reactions === undefined) {
    return { applied: false, reason: '没有可用的 reaction 写面（未配置 GitHub App / 未注入）' };
  }
  try {
    await deps.reactions.addReaction({
      repo: target.repo,
      issueNumber: target.issueNumber,
      ...(target.commentId === undefined ? {} : { commentId: target.commentId }),
      content: 'eyes',
    });
    return { applied: true, reason: 'ok' };
  } catch (error) {
    deps.logger?.warn(
      { repo: target.repo, issue: target.issueNumber, commentId: target.commentId ?? null },
      `agent 回执（eyes）失败：${errorText(error)}`,
    );
    return { applied: false, reason: errorText(error) };
  }
}

/**
 * 处理完：删掉自己打的 `eyes`。失败同样只记 warn（下一轮清理会带走）。
 */
export async function ackDone(deps: AgentAckDeps, target: AgentAckTarget): Promise<AgentAckResult> {
  if (deps.reactions === undefined) {
    return { applied: false, reason: '没有可用的 reaction 写面（未配置 GitHub App / 未注入）' };
  }
  try {
    await removeOwnReaction(
      {
        reactions: deps.reactions,
        ...(deps.appSlug === undefined ? {} : { appSlug: deps.appSlug }),
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      },
      {
        repo: target.repo,
        targetKind: 'issue',
        targetNumber: target.issueNumber,
        ...(target.commentId === undefined ? {} : { commentId: target.commentId }),
        content: 'eyes',
      },
    );
    return { applied: true, reason: 'ok' };
  } catch (error) {
    deps.logger?.warn(
      { repo: target.repo, issue: target.issueNumber, commentId: target.commentId ?? null },
      `agent 回执（移除 eyes）失败：${errorText(error)}`,
    );
    return { applied: false, reason: errorText(error) };
  }
}
