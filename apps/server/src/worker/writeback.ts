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
import type { LabelsConfig } from '../../../../packages/contract/src/index.ts';
import { dispatchWriteAction, planLabelDelta } from '../github/index.ts';
import type { BotLabelLedger, GithubReactionApi, GithubWriteApi, WriteAction } from '../github/index.ts';
import type { FailureSignal } from '../queue/index.ts';
import { summarizeBlockedReason } from '../workflows/label-decisions.ts';
import type { LabelDecisionRecorder } from '../workflows/label-decisions.ts';
import { normalizeDesired } from '../workflows/normalize.ts';
import type { BlockedLabel } from '../workflows/normalize.ts';
import type { LabelCatalogPort, ReactionPort } from '../workflows/ports.ts';
import type { EnvelopeAction } from './deps.ts';
import { DROP_REASON_TEXT } from './deps.ts';
import { signalFromGithub } from './failure.ts';
import type {
  ActionOutcome,
  ActionRecord,
  RunStore,
  TaskSourceKind,
  WriteTargetContext,
} from './types.ts';

/**
 * 写回路径认的 `tasks.source`。
 *
 * 就是 `worker/types.ts` 的 `TaskSourceKind`（含 `pipeline`）—— 这里**不再做局部放宽**：
 * S2-b 那时的 `WritebackTaskSource = TaskSourceKind | 'pipeline'` 临时别名已经删除，
 * 因为执行层的枚举补齐了 `pipeline`（§4.6）。
 */
export type WritebackTaskSource = TaskSourceKind;

/** 跑一批已通过 `filterActions` 的动作。 */
export interface ExecuteActionsInput {
  readonly runId: string;
  readonly repo: string;
  readonly targetNumber: number;
  readonly actions: readonly EnvelopeAction[];
  readonly dryRun: boolean;
  /** `tasks.source`：`command`（人工通道）与 `agent`（v0.3 issue agent）允许写回评论。 */
  readonly source: WritebackTaskSource;
  /**
  /**
   * `tasks.command`（保留字段：判定的形状稳定，缺省时由 `taskSourceOf()` 反推来源）。
   */
  readonly command?: string | undefined;
  readonly api: GithubWriteApi;
  /** reaction 写面（W2-D）：没注入时 `reaction.*` 动作明确失败并留痕。 */
  readonly reactions?: GithubReactionApi | undefined;
  readonly ledger?: BotLabelLedger | undefined;
  readonly target: WriteTargetContext;
  /**
   * 项目打标策略（装配层注入）：给了就先归一化 desired 再写，并落 `label_decisions`。
   * 不给 = 照信封给的 `add` / `remove` 直接写（接线前的行为）。
   */
  readonly labelPolicy?: LabelWritebackPolicy | undefined;
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

/* ── 打标写回策略（W2-E 的接线点）────────────────────────────────────────────── */

/**
 * 缺必填信息时的判定键 / 字面标签名。
 *
 * 与 `workflows/labels.ts::NEEDS_INFO_KEY` 同值（`workflows/index.ts` 也转出那一份）：
 * 那一份是「agent / 打标」用的，这一份是「写回路径」用的。两处都说 `needs-info` 是刻意的
 * （同一个平台级行为），但不互相 import —— `worker/` 不该为了一个字面量依赖整个 workflows 层。
 */
export const NEEDS_INFO_KEY = 'needs-info';

/**
 * 写回一个 `label` 动作之前需要的全部「项目打标策略」。
 *
 * 为什么由装配层注入、而不是 worker 自己读库：`worker/` 不认识配置与数据库
 * （`worker/types.ts` 的纪律），而这里的每一项（词表、map、上限、人工否决、
 * 仓库已有标签、`label_decisions`）都是装配层的知识。
 *
 * 不注入 = 行为与接线前一致（照信封给的 `add` / `remove` 直接写）。
 */
export type LabelWritebackPolicy = {
  /** `repos.settings.labels`：词表 / 1:N 映射 / 白名单 / `missing` 策略 / 上限。 */
  readonly labels: LabelsConfig;
  /**
   * 人工否决集合（`bot_labels` 历史里被撤下且之后没再打回来的名字）。
   * 省略 = 不知道（不做人工否决那一条规则）。
   */
  readonly humanVetoed?:
    | ((input: { readonly repo: string; readonly targetNumber: number }) => Promise<readonly string[]>)
    | undefined;
  /** 仓库已有标签 + 建标签（`labels.missing` 的判据）。省略 = 不判 missing。 */
  readonly catalog?: LabelCatalogPort | undefined;
  /** `label_decisions` 写入面。省略 = 只算不记。 */
  readonly decisions?: LabelDecisionRecorder | undefined;
  /** 判定快照哈希（issue 版本 hash）→ `label_decisions.judgement_hash`。 */
  readonly judgementHash?: string | null;
  /**
   * `confused` reaction 的端口（§0.3：缺必填信息 = `needs-info` 标签 + `confused`，
   * 仍然零评论）。省略 = 只打标签、不打 reaction。
   */
  readonly reactions?: ReactionPort | undefined;
};

/** 归一化的结果（写回路径要的四样东西）。 */
export type LabelWritePlan = {
  /** 归一化后真正想打的标签（有序、去重）。 */
  readonly desired: readonly string[];
  /** 被拦下的标签 + 原因（→ `label_decisions.blocked_reason`）。 */
  readonly blocked: readonly BlockedLabel[];
  /** 人读提示（进 `label_decisions.reason`，不参与判定）。 */
  readonly warnings: readonly string[];
  /** 本轮是否表达「缺必填信息」（`needs-info` 在最终 desired 里）→ 决定打不打 `confused`。 */
  readonly needsInfo: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把「模型想打的标签」按项目策略归一化（`docs/impl-multi-repo.md` §4 W2-E 第 1 条）。
 *
 * 规则本身一条都不在这里重写：`normalizeDesired()` 是唯一真相
 * （`workflows/normalize.ts`，逐条钉死在单测里）。这里只做三件装配层的事：
 *
 *  1. **把「标签名」也当成合法判定键**：提示词让模型只填「项目标签」一节里的标签名
 *     （`buildTaskPrompt`），而 `labels.map` 的键是内部短名 —— 两者都可能出现在
 *     `verdict.labels` 里。所以补一层「名字 → 名字」的恒等映射（显式 `labels.map` 优先，
 *     它仍然承担改名与 1:N 展开）。不补的话，词表里明明有的标签会被判成 `unmapped`
 *     —— 那正是「生产一个标签都不打」的黑洞。
 *  2. **丢掉 `labels.missing` 不允许的标签**：仓库里没有的标签写上去只会 422，
 *     不如记进 `label_decisions` 让面板说人话；`create` 策略按词表的 color/description 建
 *     （缺这两项或没注入目录端口就降级成 `not-creatable`）。
 *  3. **dry-run 不查仓库标签**：dry-run 的口径是「GitHub 零副作用」，一次 GET 也不该发生。
 */
export async function planLabelWriteback(input: {
  /** 信封 `label` 动作的 `add`（模型想打的标签名 / 判定键）。 */
  readonly proposed: readonly string[];
  readonly policy: LabelWritebackPolicy;
  readonly repo: string;
  readonly targetNumber: number;
  readonly dryRun: boolean;
}): Promise<LabelWritePlan> {
  const keys = [
    ...new Set(
      input.proposed
        .map((label) => label.trim())
        .filter((label) => label !== ''),
    ),
  ];
  const identity: Record<string, string> = {};
  for (const key of keys) {
    identity[key] = key;
  }
  const labels: LabelsConfig = {
    ...input.policy.labels,
    map: { ...identity, ...input.policy.labels.map },
  };

  const warnings: string[] = [];
  const blocked: BlockedLabel[] = [];

  let vetoed: readonly string[] = [];
  if (input.policy.humanVetoed !== undefined) {
    try {
      vetoed = await input.policy.humanVetoed({ repo: input.repo, targetNumber: input.targetNumber });
    } catch (error) {
      warnings.push(`读人工否决集合失败（本次不考虑否决）：${errorText(error)}`);
    }
  }

  const normalized = normalizeDesired({ keys, labels, humanVetoed: vetoed });
  warnings.push(...normalized.warnings);
  blocked.push(...normalized.blocked);

  const known = input.dryRun ? null : await knownLabelsOf(input.policy.catalog, input.repo, warnings);
  const missing = await applyMissingPolicy({
    policy: labels.missing,
    catalog: input.policy.catalog,
    repo: input.repo,
    desired: normalized.desired,
    vocabulary: normalized.vocabulary,
    knownLabels: known,
    warnings,
  });
  blocked.push(...missing.blocked);

  const desired = [...missing.kept];
  return {
    desired,
    blocked,
    warnings,
    needsInfo: desired.includes(NEEDS_INFO_KEY) || keys.includes(NEEDS_INFO_KEY),
  };
}

/** 仓库里有哪些标签：没端口 / 读失败 → `null`（= 不判 missing，凭猜删建比漏打更贵）。 */
async function knownLabelsOf(
  catalog: LabelCatalogPort | undefined,
  repo: string,
  warnings: string[],
): Promise<readonly string[] | null> {
  const list = catalog?.list;
  if (list === undefined) {
    return null;
  }
  try {
    return await list.call(catalog, { repo });
  } catch (error) {
    warnings.push(`读仓库标签列表失败（本次不判 labels.missing）：${errorText(error)}`);
    return null;
  }
}

/**
 * `labels.missing` 的三个策略（`warn` / `create` / `ignore`）。
 *
 * 为什么这份逻辑在这里：旧 `triage.ts` 里的那一份随 S5 删死代码一起删掉了（它只服务于
 * 无调用者的判定通道），**这里是唯一实现**。两边共用的是 `normalizeDesired()` 与词表，
 * 策略本身只有十来行。
 */
async function applyMissingPolicy(input: {
  readonly policy: 'warn' | 'create' | 'ignore';
  readonly catalog: LabelCatalogPort | undefined;
  readonly repo: string;
  readonly desired: readonly string[];
  readonly vocabulary: Readonly<Record<string, { readonly color?: string; readonly description?: string }>>;
  readonly knownLabels: readonly string[] | null;
  readonly warnings: string[];
}): Promise<{ readonly kept: readonly string[]; readonly blocked: readonly BlockedLabel[] }> {
  const known = input.knownLabels;
  if (known === null) {
    return { kept: input.desired, blocked: [] };
  }
  const knownSet = new Set(known);
  const kept: string[] = [];
  const blocked: BlockedLabel[] = [];

  for (const label of input.desired) {
    if (knownSet.has(label)) {
      kept.push(label);
      continue;
    }
    if (input.policy === 'ignore') {
      blocked.push({
        label,
        reason: 'missing-label',
        detail: `仓库里没有 \`${label}\` 这个标签；按 labels.missing=ignore 静默跳过`,
        sourceKey: null,
      });
      continue;
    }
    if (input.policy === 'create') {
      const entry = input.vocabulary[label];
      const create = input.catalog?.create;
      if (entry !== undefined && create !== undefined) {
        try {
          await create.call(input.catalog, {
            repo: input.repo,
            name: label,
            ...(entry.color === undefined ? {} : { color: entry.color }),
            ...(entry.description === undefined ? {} : { description: entry.description }),
          });
          kept.push(label);
          input.warnings.push(`仓库里没有 \`${label}\`：已按词表（labels.missing=create）新建标签`);
          continue;
        } catch (error) {
          blocked.push({
            label,
            reason: 'not-creatable',
            detail: `\`${label}\` 建标签失败：${errorText(error)}`,
            sourceKey: null,
          });
          input.warnings.push(`建标签 \`${label}\` 失败：${errorText(error)}`);
          continue;
        }
      }
      blocked.push({
        label,
        reason: 'not-creatable',
        detail:
          entry === undefined
            ? `仓库里没有 \`${label}\`，且它不在 labels.vocabulary 里：labels.missing=create 也只建词表内的标签`
            : `仓库里没有 \`${label}\`，词表里有它但没有 color/description（或未注入标签目录端口）：无法新建`,
        sourceKey: null,
      });
      input.warnings.push(`仓库里没有 \`${label}\` 且无法新建：本轮不打`);
      continue;
    }
    blocked.push({
      label,
      reason: 'missing-label',
      detail: `仓库里没有 \`${label}\` 这个标签；labels.missing=warn（只记台账，需要建标签请把策略改成 create）`,
      sourceKey: null,
    });
    input.warnings.push(`仓库里没有 \`${label}\` 这个标签：按 labels.missing=warn 只记台账`);
  }

  return { kept, blocked };
}

/** `label_decisions.reason`：被拦了什么（面板一句话能读完）。 */
export function describeLabelPlan(plan: LabelWritePlan, dryRun: boolean): string | null {
  const parts: string[] = [];
  if (dryRun) {
    parts.push('dry-run：只算不写');
  }
  const blocked = summarizeBlockedReason(plan.blocked);
  if (blocked !== null) {
    parts.push(`未打：${blocked}`);
  }
  return parts.length === 0 ? null : parts.join('；');
}

/**
 * 模型自拟的占位称呼：v0.3 早期 `tasks.actor_login` 恒为 `'agent'`，回复于是以 `@agent` 开头
 * （一个不存在的账号）。写回时把它换成真实提问人，而不是再叠加一个 `@`。
 */
const PLACEHOLDER_MENTIONS = ['@agent'] as const;

/**
 * 给最终回复加 `@提问者` 前缀。
 *
 * 为什么在写回时加、而不是让 agent 自己写：agent 看不到触发评论的作者（提示词里只有 issue 号与问题正文），
 * 而 `@login` 必须来自那一行 `tasks.actor_login`。
 *
 * 三条规则：
 *  1. 已经以 `@提问者` 开头 → 原样返回（不重复加）；
 *  2. 以占位称呼（`@agent`）开头 → 换成真实提问人（保留后面的正文）；
 *  3. 其它 → 前缀 `@提问者 `。
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
  const head = body.trimStart();
  if (head.toLowerCase().startsWith(handle.toLowerCase())) {
    return body;
  }
  for (const placeholder of PLACEHOLDER_MENTIONS) {
    if (!head.toLowerCase().startsWith(placeholder)) {
      continue;
    }
    // `@agentX` 这种别的账号不能被当成占位称呼
    const next = head.charAt(placeholder.length);
    if (next !== '' && /[A-Za-z0-9_-]/u.test(next)) {
      continue;
    }
    return `${handle}${head.slice(placeholder.length)}`;
  }
  return `${handle} ${body}`;
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
    /**
     * 归一化之后的期望标签集合（`planLabelWriteback()` 的产物）。
     * 省略 = 用信封的增量集合算（`(current − remove) ∪ add`）。
     */
    readonly desiredLabels?: readonly string[] | undefined;
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
      // 归一化给了 desired 就用它（词表 / 上限 / 人工否决已经生效）；否则退回
      // 「当前 − remove ∪ add」的原始口径（没人接线时的行为与以前逐字一致）。
      const add = context.desiredLabels ?? action.add ?? [];
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

/**
 * 这一轮是人工通道还是自动通道。
 *
 * 为什么不直接读 `input.source` 了事：装配层（`app/compose.ts`）会把 `tasks.source` 传进
 * `TaskRunInput`，但老任务行 / 单测 / 内存调用都没有它。缺省时按命令名推（`db/schema.ts` 的约定）：
 *  - 以 `auto:` 开头的判定类命令 → `webhook`（自动通道，零评论）；
 *  - 其余（`/review-pr`、`@answer` 这类）→ `command`（人工通道）。
 * 这样「不传也安全」：自动通道默认不写评论，而人工命令的回答不会被误吞。
 */
export function taskSourceOf(input: {
  readonly source?: WritebackTaskSource | undefined;
  readonly command: string;
}): WritebackTaskSource {
  if (input.source !== undefined) {
    return input.source;
  }
  const command = input.command.trim().toLowerCase();
  return command.startsWith('auto:') ? 'webhook' : 'command';
}

/**
 * 这个动作允不允许写回（plan §5 的两条通道）。
 *
 * **只有 `comment` 受 `source` 约束**：自动通道（判定 / 闸门）只有 reaction + 标签、零评论；
 * `label` / `create_issue` / `push_branch` / `reaction.*` 在两条通道里都一样执行。
 *
 * 两条通道的口径：
 *  - `command`（人工 `/…`、`@answer`）→ 允许评论；
 *  - `agent`（v0.3 的 issue agent，事件与 `@别名` 提及）→ 允许评论
 *    （`docs/req-issue-agent.md` §5「默认只产出评论」）；
 *  - `webhook` / `cron`（自动通道）→ 零评论（§0.4 的不变量）。
 */
export function isWriteBackAllowed(input: {
  readonly intent: string;
  readonly source: WritebackTaskSource;
  /** `tasks.command`；保留字段是为了调用方形状稳定（判定不再读它）。 */
  readonly command?: string | undefined;
}): boolean {
  if (input.intent !== 'comment') {
    return true;
  }
  return input.source === 'command' || input.source === 'agent';
}

export async function executeActions(input: ExecuteActionsInput): Promise<ExecuteActionsResult> {
  const outcomes: ActionOutcome[] = [];
  const signals: FailureSignal[] = [];

  for (const action of input.actions) {
    const target = actionTargetOf(
      input.repo,
      action.intent === 'push_branch' ? action.branch : input.targetNumber,
    );

    // 打标归一化（`docs/impl-multi-repo.md` §4 W2-E 第 1 条）：真正写标签的是这里，
    // 所以词表 / 1:N / 互斥组 / 上限 / 人工否决 / `labels.missing` 必须在**写之前**生效。
    // dry-run 也跑一遍（只算不写）：面板与 `label_decisions` 才能解释「本来会打什么」。
    const labelPlan =
      action.intent === 'label' && input.labelPolicy !== undefined
        ? await planLabelWriteback({
            proposed: action.add ?? [],
            policy: input.labelPolicy,
            repo: input.repo,
            targetNumber: input.targetNumber,
            dryRun: input.dryRun,
          })
        : null;

    if (input.dryRun) {
      // dry-run：只记「本来要做什么」，不写 actions 行、不打 GitHub。
      if (labelPlan !== null) {
        await recordLabelDecision(input, labelPlan, [], true);
      }
      outcomes.push({
        intent: action.intent,
        status: 'dry-run',
        target,
        externalRef: null,
        reason:
          labelPlan === null
            ? 'dry-run：只记录计划，不执行任何写操作（plan §11 M1 观察期）'
            : `dry-run：归一化后要打 [${labelPlan.desired.join(', ')}]（被拦 ${String(labelPlan.blocked.length)} 个）`,
      });
      continue;
    }
    // 写回闸门：`command`（人工）与 `agent`（v0.3 事件 / 提及通道）能写回评论；
    // 其余自动通道（webhook / cron）仍然零评论（§0.4 的不变量没变）。
    // 这里**不**记 `actions` 行：什么都没发生（与 dry-run 同一取向），但要在报告里留一行，
    // 面板才能解释「为什么这一轮没有评论」。
    if (!isWriteBackAllowed({ intent: action.intent, source: input.source, command: input.command })) {
      outcomes.push({
        intent: action.intent,
        status: 'skipped',
        target,
        externalRef: null,
        reason: `自动通道零评论（tasks.source=${input.source}）：只有人工触发（command）与流水线阶段任务（pipeline:*）才写回评论`,
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
        ...(labelPlan === null ? {} : { desiredLabels: labelPlan.desired }),
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
          ...(input.reactions === undefined ? {} : { reactions: input.reactions }),
        });
        outcomes.push(toOutcome(action, target, result));
        const record = toRecord(input, action, target, result);
        await input.store.recordAction(record);
        if (labelPlan !== null && result.kind === 'label') {
          // `label_decisions` 每轮一行：`applied` 用执行器的真实结果，`blocked` 是归一化拦下的那些
          await recordLabelDecision(input, labelPlan, result.outcome.added, false);
        }
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
        if (labelPlan !== null) {
          await recordLabelDecision(input, labelPlan, [], false);
        }
      }
    }

    // 缺必填信息 → `confused`（§0.3）：标签打上了、评论一条都不发。
    if (labelPlan !== null && labelPlan.needsInfo) {
      await applyConfusedReaction(input);
    }
  }

  return { outcomes, signals };
}

/**
 * 落一行 `label_decisions`（每轮打标一次）。
 *
 * 为什么失败只吞掉：这张表是**审计**，判定与标签都已经发生；为了让面板多一行解释
 * 而把整轮任务判成失败，方向反了（与 `workflows/label-decisions.ts::recordLabelDecision()` 同一取向）。
 * 注释里写明「静默」是刻意的，避免下一个人以为是漏了 try/catch。
 */
async function recordLabelDecision(
  input: ExecuteActionsInput,
  plan: LabelWritePlan,
  applied: readonly string[],
  dryRun: boolean,
): Promise<void> {
  const decisions = input.labelPolicy?.decisions;
  if (decisions === undefined) {
    return;
  }
  try {
    await decisions.record({
      repo: input.repo,
      targetNumber: input.targetNumber,
      judgementHash: input.labelPolicy?.judgementHash ?? null,
      desired: plan.desired,
      applied,
      blocked: plan.blocked,
      reason: describeLabelPlan(plan, dryRun),
      runId: input.runId,
    });
  } catch {
    // 静默：见函数头注释
  }
}

/**
 * 缺必填信息 → `confused` reaction（§0.3）。
 *
 * 自动通道零评论，所以「我卡住了」只能用 reaction 表达。打不上（403 / 没注入端口）
 * 也不该翻 run：标签已经打上了，reaction 只是装饰。
 */
async function applyConfusedReaction(input: ExecuteActionsInput): Promise<void> {
  const reactions = input.labelPolicy?.reactions;
  if (reactions === undefined) {
    return;
  }
  try {
    await reactions.add({
      repo: input.repo,
      targetKind: 'issue',
      targetNumber: input.targetNumber,
      content: 'confused',
    });
  } catch {
    // 同 `recordLabelDecision()`：装饰性动作失败不影响 run 结论
    // 装饰性动作失败不影响 run 结论（与上一条同一取向）
  }
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
    case 'comment': {
      const dedupe = result.outcome.dedupe;
      return {
        intent: action.intent,
        status: result.outcome.action === 'posted' ? 'applied' : 'skipped',
        target,
        externalRef: result.outcome.commentId === null ? null : String(result.outcome.commentId),
        reason:
          result.outcome.action === 'posted'
            ? dedupe === 'marker'
              ? `发了评论（标记 ${result.outcome.marker}）`
              : '发了评论（人工通道不带隐藏标记：打标/反馈类评论已退役）'
            : `命中隐藏标记，跳过重复评论（commentId=${String(result.outcome.commentId)}）`,
      };
    }
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
    case 'reaction':
      return {
        intent: action.intent,
        status: result.outcome.action === 'skipped' ? 'skipped' : 'applied',
        target,
        externalRef:
          result.outcome.reactionId === null ? null : String(result.outcome.reactionId),
        reason: result.outcome.reason,
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
    case 'reaction':
      return {
        runId: base.runId,
        intent: base.intent,
        target: base.target,
        externalRef:
          result.outcome.reactionId === null ? null : String(result.outcome.reactionId),
        appliedAt: result.outcome.action === 'skipped' ? null : new Date(base.createdAtMs),
        audit: {
          status: result.outcome.action,
          content: result.outcome.content,
          reactionId: result.outcome.reactionId,
          removed: result.outcome.removed,
          reason: result.outcome.reason,
        },
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
