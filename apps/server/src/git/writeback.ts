/**
 * 写回编排：闸门 → 临时索引组提交 → 推送（tech-plan §5.6 的完整流程）。
 *
 * 这是 `git/` 对外唯一的「写回」入口。之所以要有这一层而不是让调用方自己串三步：
 * 1. **顺序不可换**：先评估再组提交再推。任何一步被绕过（例如先 `git add -A`），
 *    闸门就从「唯一检查点」退化成「事后日志」。
 * 2. **索引不变式要被强制**：组提交前后各取一次 worktree 真索引的快照，
 *    内容不一致就直接失败——这条不变式是「推上去的字节由临时索引决定」的前提。
 * 3. 拒绝要变成**返回值**而不是异常：`writeback_rejected` 要带着四集合审计进
 *    `actions.audit` 与 `run_events`，抛异常会让调用方拿不到审计。
 *
 * 与 worker / github 的关系：`github/executor.ts` 的 `DelegatedPlan{kind:'push_branch'}`
 * 就是本函数的入参形状（`paths` 即 `declared`），worker 不重复任何判定。
 */
import { AppError } from './deps.ts';
import type { Logger } from './deps.ts';
import {
  createWritebackCommit,
  indexSnapshotsEqual,
  snapshotIndex,
  writebackCommitMessage,
} from './commit-tree.ts';
import { assertBotBranch, pushCommit } from './push.ts';
import type { RunGit } from './run-git.ts';
import type { WritebackAudit } from './types.ts';
import type { WritebackRejectionReason } from './paths.ts';
import { evaluateWriteback } from './writeback-gate.ts';

/** 闸门拒绝的错误码（与 tech-plan §5.6 的字面一致，面板按它检索）。 */
export const WRITEBACK_REJECTED = 'WRITEBACK_REJECTED';

export interface WritebackInput {
  readonly jobDir: string;
  readonly taskId: string;
  /** `bot/<task>-<slug>`。 */
  readonly branch: string;
  /** 信封 `push_branch.paths`。 */
  readonly declared: readonly string[];
  readonly runGit: RunGit;
  /** 提交说明里的意图（缺省 `push_branch`）。 */
  readonly intent?: string;
  readonly token?: string | undefined;
  readonly remote?: string;
  readonly logger?: Logger | undefined;
}

export interface WritebackPushed {
  readonly status: 'pushed';
  readonly branch: string;
  readonly commit: string;
  readonly parent: string;
  readonly refspec: string;
  /** push 的完整 argv（审计证据：其中不会出现 --force）。 */
  readonly pushArgv: readonly string[];
  readonly intersect: readonly string[];
  readonly dropped: readonly string[];
  readonly audit: WritebackAudit;
}

export interface WritebackRejected {
  readonly status: 'rejected';
  readonly code: typeof WRITEBACK_REJECTED;
  readonly reason: WritebackRejectionReason;
  readonly paths: readonly string[];
  readonly detail: string;
  readonly audit: WritebackAudit;
}

/** 交集为空：没有「被允许的变更」可推。这不是错误（agent 可能什么都没改成功）。 */
export interface WritebackEmpty {
  readonly status: 'empty';
  readonly audit: WritebackAudit;
}

export type WritebackResult = WritebackPushed | WritebackRejected | WritebackEmpty;

export async function runWriteback(input: WritebackInput): Promise<WritebackResult> {
  assertBotBranch(input.branch);

  const before = await snapshotIndex(input.jobDir, input.runGit);
  const gate = await evaluateWriteback({
    jobDir: input.jobDir,
    declared: input.declared,
    runGit: input.runGit,
  });

  if (!gate.ok) {
    // 记 warn 而不是 error：它是「有人在推边界」的**信号**，不是我们的 bug。
    input.logger?.warn(
      { taskId: input.taskId, reason: gate.reason, paths: gate.paths, audit: gate.audit },
      'writeback_rejected：写回被闸门拒绝',
    );
    return {
      status: 'rejected',
      code: WRITEBACK_REJECTED,
      reason: gate.reason,
      paths: gate.paths,
      detail: gate.detail,
      audit: gate.audit,
    };
  }

  if (gate.intersect.length === 0) {
    input.logger?.info({ taskId: input.taskId, actual: gate.actual }, '写回为空：声明与实际无交集，不推送');
    return { status: 'empty', audit: gate.audit };
  }

  const commit = await createWritebackCommit({
    jobDir: input.jobDir,
    paths: gate.intersect,
    message: writebackCommitMessage({ intent: input.intent ?? 'push_branch', taskId: input.taskId }),
    runGit: input.runGit,
  });

  const after = await snapshotIndex(input.jobDir, input.runGit);
  if (!indexSnapshotsEqual(before, after)) {
    throw new AppError('写回过程动了 worktree 的真索引（应当只用临时索引）', {
      code: 'WORKTREE_INDEX_TOUCHED',
      failureClass: 'sandbox',
      retriable: false,
      details: { before: before.sha256, after: after.sha256, index: before.path },
    });
  }

  const pushed = await pushCommit({
    jobDir: input.jobDir,
    commit: commit.commit,
    branch: input.branch,
    runGit: input.runGit,
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.remote === undefined ? {} : { remote: input.remote }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  return {
    status: 'pushed',
    branch: input.branch,
    commit: commit.commit,
    parent: commit.parent,
    refspec: pushed.refspec,
    pushArgv: pushed.argv,
    intersect: gate.intersect,
    dropped: gate.dropped,
    audit: gate.audit,
  };
}

/** 把写回结果压成 `actions.audit` 里的一个 JSON 对象（worker 直接塞库）。 */
export function toWritebackAuditRecord(result: WritebackResult): Record<string, unknown> {
  if (result.status === 'pushed') {
    return {
      status: 'pushed',
      branch: result.branch,
      commit: result.commit,
      parent: result.parent,
      refspec: result.refspec,
      declared: result.audit.declared,
      actual: result.audit.actual,
      intersect: result.audit.intersect,
      dropped: result.audit.dropped,
    };
  }
  if (result.status === 'rejected') {
    return {
      status: 'writeback_rejected',
      code: result.code,
      reason: result.reason,
      paths: result.paths,
      detail: result.detail,
      declared: result.audit.declared,
      actual: result.audit.actual,
      intersect: result.audit.intersect,
      dropped: result.audit.dropped,
    };
  }
  return {
    status: 'empty',
    declared: result.audit.declared,
    actual: result.audit.actual,
    intersect: result.audit.intersect,
    dropped: result.audit.dropped,
  };
}
