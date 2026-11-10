/**
 * 步骤 8：**写执行器**（tech-plan §4.3 第 8 步 / §5.4 / §5.6）。
 *
 * 分工与 `github/executor.ts` 严格一致：那层只做判定与分派，这里只做**接线与记账**。
 * worker 不重写任何幂等规则（标记、`bot_labels`、去重键、`bot/*` 分支），
 * 因为它一重写就会出现两份「同一句话是否重复」的真相。
 *
 * 三件必须在这里做对的事：
 *  1. **dry-run 不产生任何写副作用**：连 `actions` 行都不写（`actions.applied_at` 的含义是
 *     「这条写操作发生了什么」，dry-run 什么都没发生）。计划落在 `run_events` 的一条
 *     `writeback.dry-run` 上，面板看得到、GitHub 侧零副作用（M0 的验收口径）。
 *  2. **`push_branch` 只交计划不执行**：真实 push 必须先过 §5.6 的写回闸门（临时 index +
 *     `declared ∩ actual`），那段归 `git/` owner（W4-N）。这里落一条 `applied_at = null`
 *     的 `actions` 行，`audit` 里带上合规判定与「交给谁」，让它可被对账。
 *  3. **单个动作失败不拖垮整批**：每个动作单独 catch，失败转成信号继续下一个；
 *     否则第一个动作网络抖动会让后面的正确动作全部不执行（与 `filterActions` 的
 *     「逐个丢弃」同一取向）。
 */
import { dispatchWriteAction, planLabelDelta } from '../github/index.ts';
import type { BotLabelLedger, GithubWriteApi, WriteAction } from '../github/index.ts';
import type { FailureSignal } from '../queue/index.ts';
import type { EnvelopeAction } from './deps.ts';
import { DROP_REASON_TEXT } from './deps.ts';
import { signalFromGithub } from './failure.ts';
import type {
  ActionOutcome,
  ActionRecord,
  RunStore,
  WriteTargetContext,
} from './types.ts';

/** 跑一批已通过 `filterActions` 的动作。 */
export interface ExecuteActionsInput {
  readonly runId: string;
  readonly repo: string;
  readonly targetNumber: number;
  readonly actions: readonly EnvelopeAction[];
  readonly dryRun: boolean;
  readonly api: GithubWriteApi;
  readonly ledger?: BotLabelLedger | undefined;
  readonly target: WriteTargetContext;
  /** 提问者 login（`tasks.actor_login`）：回复会被加 `@login` 前缀。 */
  readonly mention?: string | null | undefined;
  readonly store: RunStore;
  readonly clock: () => number;
}

export interface ExecuteActionsResult {
  readonly outcomes: readonly ActionOutcome[];
  readonly signals: readonly FailureSignal[];
}

/** 动作指向的对象（`actions.target` 的格式，reconcile 靠它重查现状）。 */
export function actionTargetOf(repo: string, suffix: string | number): string {
  return `${repo}#${String(suffix)}`;
}

/**
 * 给最终回复加 `@提问者` 前缀。
 *
 * 为什么在写回时加、而不是让 agent 自己写：agent 看不到触发评论的作者（提示词里只有 issue 号与问题正文），
 * 而 `@login` 必须来自那一行 `tasks.actor_login`。已经是 `@…` 开头的不重复加。
 */
export function withMention(body: string, mention: string | null | undefined): string {
  if (mention === null || mention === undefined) {
    return body;
  }
  const trimmed = mention.trim();
  if (trimmed === '') {
    return body;
  }
  const handle = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  return body.trimStart().startsWith(handle) ? body : `${handle} ${body}`;
}

/**
 * 把信封动作翻译成写执行器的 `WriteAction`。
 *
 * `label` 的翻译值得单说：信封给的是 `add` / `remove` 两个增量集合，
 * 而 `planLabelDelta(current, botLabels, desired)` 要的是**期望集合**。
 * 所以 `desired = (current − remove) ∪ add`——这样「只删自己打过的」那条规则
 * 仍然由 `planLabelDelta` 一处负责，worker 不去判断「这个标签是谁打的」。
 */
export function toWriteActions(
  action: EnvelopeAction,
  context: {
    readonly repo: string;
    readonly targetNumber: number;
    readonly target: WriteTargetContext;
    /** 提问者 login；给了就让回复以 `@login` 开头（人不传就不加）。 */
    readonly mention?: string | null | undefined;
  },
): WriteAction[] {
  switch (action.intent) {
    case 'comment':
      return [
        {
          kind: 'comment',
          repo: context.repo,
          target: context.targetNumber,
          intent: 'comment',
          body: withMention(action.body, context.mention),
        },
      ];
    case 'label': {
      const current = context.target.currentLabels ?? [];
      const remove = action.remove ?? [];
      const add = action.add ?? [];
      const desired = [...new Set([...current.filter((label) => !remove.includes(label)), ...add])];
      return [
        {
          kind: 'label',
          repo: context.repo,
          target: context.targetNumber,
          current,
          botLabels: context.target.botLabels ?? [],
          desired,
        },
      ];
    }
    case 'create_issue':
      return [
        {
          kind: 'create_issue',
          repo: context.repo,
          fingerprint: action.fingerprint,
          fingerprintKnown: context.target.fingerprintKnown ?? false,
          createdToday: context.target.createdToday ?? 0,
          ...(context.target.dailyQuota === undefined ? {} : { dailyQuota: context.target.dailyQuota }),
          title: action.title,
          body: action.body ?? '',
          ...(context.target.existingIssueNumber === undefined
            ? {}
            : { existingIssueNumber: context.target.existingIssueNumber }),
        },
      ];
    case 'push_branch':
      return [
        {
          kind: 'push_branch',
          repo: context.repo,
          branch: action.branch,
          paths: action.paths,
        },
      ];
  }
}

export async function executeActions(input: ExecuteActionsInput): Promise<ExecuteActionsResult> {
  const outcomes: ActionOutcome[] = [];
  const signals: FailureSignal[] = [];

  for (const action of input.actions) {
    const target = actionTargetOf(
      input.repo,
      action.intent === 'push_branch' ? action.branch : input.targetNumber,
    );

    if (input.dryRun) {
      // dry-run：只记「本来要做什么」，不写 actions 行、不打 GitHub。
      outcomes.push({
        intent: action.intent,
        status: 'dry-run',
        target,
        externalRef: null,
        reason: 'dry-run：只记录计划，不执行任何写操作（plan §11 M1 观察期）',
      });
      continue;
    }

    let writeActions: WriteAction[];
    try {
      writeActions = toWriteActions(action, {
        repo: input.repo,
        targetNumber: input.targetNumber,
        target: input.target,
        mention: input.mention,
      });
    } catch (error) {
      const signal = signalFromGithub(error);
      signals.push(signal);
      outcomes.push({
        intent: action.intent,
        status: 'failed',
        target,
        externalRef: null,
        reason: signal.detail ?? '动作翻译失败',
      });
      continue;
    }

    for (const writeAction of writeActions) {
      try {
        const result = await dispatchWriteAction(writeAction, {
          api: input.api,
          ...(input.ledger === undefined ? {} : { ledger: input.ledger }),
        });
        outcomes.push(toOutcome(action, target, result));
        const record = toRecord(input, action, target, result);
        await input.store.recordAction(record);
      } catch (error) {
        const signal = signalFromGithub(error);
        signals.push(signal);
        const failed: ActionOutcome = {
          intent: action.intent,
          status: 'failed',
          target,
          externalRef: null,
          reason: signal.detail ?? '写操作失败',
        };
        outcomes.push(failed);
        // 失败也要留痕：`applied_at = null` + audit.reason（面板的「未落地」一栏）
        await input.store.recordAction({
          runId: input.runId,
          intent: action.intent,
          target,
          externalRef: null,
          appliedAt: null,
          audit: {
            status: 'failed',
            reason: failed.reason,
            failureClass: signal.failureClass,
            httpStatus: signal.httpStatus ?? null,
          },
        });
      }
    }
  }

  return { outcomes, signals };
}

type DispatchResult = Awaited<ReturnType<typeof dispatchWriteAction>>;

/**
 * 分派结果 → 报告里的一行。
 *
 * `target` 由调用方算好传进来（`actions.target` 是 reconcile 的重查键，
 * 必须与 `toRecord()` 写进库的那一列**完全一致**，所以只算一次）。
 */
function toOutcome(action: EnvelopeAction, target: string, result: DispatchResult): ActionOutcome {

  switch (result.kind) {
    case 'comment':
      return {
        intent: action.intent,
        status: result.outcome.action === 'posted' ? 'applied' : 'skipped',
        target,
        externalRef: result.outcome.commentId === null ? null : String(result.outcome.commentId),
        reason:
          result.outcome.action === 'posted'
            ? `发了评论（标记 ${result.outcome.marker}）`
            : `命中隐藏标记，跳过重复评论（commentId=${String(result.outcome.commentId)}）`,
      };
    case 'label': {
      const { added, removed, delta } = result.outcome;
      return {
        intent: action.intent,
        status: added.length === 0 && removed.length === 0 ? 'skipped' : 'applied',
        target,
        externalRef: null,
        reason:
          added.length === 0 && removed.length === 0
            ? `标签已是期望状态（人打的保留：${delta.retainHumanOwned.join(', ')}）`
            : `标签 +[${added.join(', ')}] -[${removed.join(', ')}]`,
      };
    }
    case 'create_issue':
      return {
        intent: action.intent,
        status:
          result.outcome.issueNumber === null && result.outcome.commentedOn === null ? 'skipped' : 'applied',
        target,
        externalRef:
          result.outcome.issueNumber === null ? null : String(result.outcome.issueNumber),
        reason: result.outcome.decision.reason,
      };
    case 'close_issue':
      return {
        intent: action.intent,
        status: result.decision.action === 'close' ? 'applied' : 'skipped',
        target,
        externalRef: null,
        reason: result.decision.reason,
      };
    case 'delegated':
      return {
        intent: action.intent,
        status: 'delegated',
        target,
        externalRef: null,
        reason: result.plan.compliance.compliant
          ? `交给 git/ 写回闸门执行（§5.6）：${result.plan.kind}`
          : `交给 git/ 但判定不合规：${result.plan.compliance.reasons.join('; ')}`,
      };
  }
}

/** 分派结果 → `actions` 行。 */
function toRecord(
  input: ExecuteActionsInput,
  action: EnvelopeAction,
  target: string,
  result: DispatchResult,
): ActionRecord {
  const base = {
    runId: input.runId,
    intent: action.intent,
    target,
    createdAtMs: input.clock(),
  };


  switch (result.kind) {
    case 'comment':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef: result.outcome.commentId === null ? null : String(result.outcome.commentId),
        appliedAt: new Date(base.createdAtMs),
        audit: {
          status: result.outcome.action,
          dedupeAction: result.outcome.action,
          marker: result.outcome.marker,
        },
      };
    case 'label':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef: null,
        appliedAt: new Date(base.createdAtMs),
        audit: {
          status: 'applied',
          added: result.outcome.added,
          removed: result.outcome.removed,
          retainHumanOwned: result.outcome.delta.retainHumanOwned,
        },
      };
    case 'create_issue':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef: result.outcome.issueNumber === null ? null : String(result.outcome.issueNumber),
        appliedAt: new Date(base.createdAtMs),
        audit: {
          status: result.outcome.decision.action,
          reason: result.outcome.decision.reason,
          commentedOn: result.outcome.commentedOn,
        },
      };
    case 'close_issue':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef: null,
        appliedAt: result.decision.action === 'close' ? new Date(base.createdAtMs) : null,
        audit: { status: result.decision.action, reason: result.decision.reason },
      };
    case 'delegated':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef: null,
        // 交给 git/ 执行 → 这条动作**尚未落地**（§5.6 的闸门通过后才会有 commit sha）
        appliedAt: null,
        audit: {
          status: 'delegated',
          owner: result.plan.owner,
          kind: result.plan.kind,
          compliance: result.plan.compliance,
          delegatedAt: new Date(base.createdAtMs).toISOString(),
        },
      };
  }
}

/** 动作被丢弃时的人读原因（`run_events` 的 `writeback.dropped` 用它）。 */
export function describeDropped(reason: string): string {
  return DROP_REASON_TEXT[reason as keyof typeof DROP_REASON_TEXT] ?? reason;
}

/**
 * 预演标签差集（dry-run 的审计用：让面板能看到「如果执行，会加什么删什么」）。
 *
 * 纯函数，不写库、不打 GitHub；`label` 之外的动作返回 `null`。
 */
export function previewLabelDelta(
  action: EnvelopeAction,
  target: WriteTargetContext,
): { readonly add: readonly string[]; readonly remove: readonly string[] } | null {
  if (action.intent !== 'label') {
    return null;
  }
  const current = target.currentLabels ?? [];
  const add = action.add ?? [];
  const remove = action.remove ?? [];
  const desired = [...new Set([...current.filter((label) => !remove.includes(label)), ...add])];
  const delta = planLabelDelta(current, target.botLabels ?? [], desired);
  return { add: delta.add, remove: delta.remove };
}
