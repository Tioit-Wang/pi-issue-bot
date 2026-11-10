/**
 * 分类打标（plan §6.1；多仓库改造后见 `docs/impl-multi-repo.md` §4 W2-E）。
 *
 * 流程（每一步都对应一条验收）：
 *
 * 1. **渲染 prompt 交给 worker**：正文是不可信输入，围栏与截断在 `skills/prompt.ts`；
 *    这里只负责把上下文摆好（仓库 / 目标 / 标题 / 正文 / 当前标签 / 标签词表）。
 * 2. **归一化**：模型给的判定键 → `normalizeDesired()`（词表过滤 / `map` 1:N 展开 /
 *    互斥组 / `max_per_issue` / 人工否决）。**不在本文件里再写一遍规则**。
 * 3. **缺必填信息 → `needs-info` 标签 + `confused` reaction**（§0.3）：判定依据是
 *    `verdict.evidence` 里 `passed !== true` 的条目。**一个评论都不发**（§0.4）：
 *    明细写 `label_decisions.reason` 供面板展示。旧的 `compliance.ts` 连同
 *    `buildComplianceComment()` 一起删掉了。
 * 4. **只增删自己打过的标签**：`planLabelDelta(current, botLabels, desired)`；人打的 `bug`
 *    永远不会因为我们的重算被删掉（「关掉机器人后仓库长什么样」的唯一保证）。
 * 5. **失败不翻 run**：打标/打 reaction 出错只产出 `failure.fatal === false` 的信号 +
 *    `label_decisions` 一行，任务本身的结论仍然算数（判定是主产出，标签是附带动作）。
 *
 * 幂等锚（W2-E 第 6 条）：`judgement_hash` 用 **issue 版本 hash**（webhook 的
 * `issueVersionHash`），**不再用缺失项集合**——编辑正文但缺失项没变时前者会变、后者不会，
 * 拿后者当锚会把「用户补了信息」的那一轮误判成重复。
 */
import { randomUUID } from 'node:crypto';
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { Verdict } from '../../../../packages/envelope/src/index.ts';
import { executeLabelPlan, planLabelDelta } from '../github/executor.ts';
import type { BotLabelLedger, LabelDelta, LabelOutcome } from '../github/executor.ts';
import type { GithubWriteApi } from '../github/types.ts';
import { allowedIntentsOf, renderSkillPrompt } from '../skills/prompt.ts';
import type { SkillDefinition } from '../skills/types.ts';
import type { BotLabelAttribution } from './bot-labels.ts';
import { summarizeBlockedReason } from './label-decisions.ts';
import type { LabelDecisionRecorder } from './label-decisions.ts';
import { normalizeDesired } from './normalize.ts';
import type { BlockedLabel } from './normalize.ts';
import type { EnvelopeRunner, LabelCatalogPort, ReactionPort } from './ports.ts';

/** 判定键：缺必填信息（`labels.map` 里可以把它改名成仓库自己的标签）。 */
export const NEEDS_INFO_KEY = 'needs-info';

/** `labels.map` 里没有 `needs-info` 映射时用的字面量标签名。 */
export const NEEDS_INFO_FALLBACK_LABEL = 'needs-info';

/** `label_decisions.reason` 里引用原文片段的上限（长引用会让面板变成噪声）。 */
export const REASON_QUOTE_LIMIT = 80;

/**
 * 打标/打 reaction 失败的信号。
 *
 * **`fatal` 恒为 `false`**：判定（信封）才是任务的主产出，标签与 reaction 是附带动作。
 * 打标失败把整趟 run 判成失败，等于「因为 GitHub 抽风就丢掉一次正确的判定」。
 */
export type TriageFailureSignal = {
  readonly fatal: false;
  readonly failureClass: 'label' | 'reaction' | 'label-create';
  readonly message: string;
};

/** 记账器工厂：拿到本轮归因后造一个 `BotLabelLedger`（`run_id` / `source_key` 才能落进 `bot_labels`）。 */
export type BotLabelLedgerFactory = (attribution: BotLabelAttribution) => BotLabelLedger;

export type TriageDeps = {
  /** 跑一趟任务拿信封（`createTaskRunner()` 的产物结构上满足）。 */
  readonly runner: EnvelopeRunner;
  /** 写执行器；dry-run 或单测里只判定时可不给。 */
  readonly github?: GithubWriteApi;
  /**
   * 记账器本体，或「按本轮归因造一个」的工厂。
   * 只有工厂形态能写出 `source_key` / `judgement_hash` / `run_id`（归因是每轮才有的）。
   */
  readonly ledger?: BotLabelLedger | BotLabelLedgerFactory;
  /** `label_decisions` 的写入面（每轮一行）；不给我只记日志。 */
  readonly decisions?: LabelDecisionRecorder;
  /** `confused` reaction 的端口（缺信息时打）；不给我只记 warn。 */
  readonly reaction?: ReactionPort;
  /** 标签目录端口（`labels.missing: 'create'` 需要它建标签）。 */
  readonly catalog?: LabelCatalogPort;
  readonly logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    info(fields: Record<string, unknown>, message: string): void;
  };
  readonly now?: () => Date;
  /** 任务/run id 生成器（单测注入固定值；生产用 uuid）。 */
  readonly ids?: () => { readonly taskId: string; readonly runId: string };
};

export type TriageInput = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string | null;
  /** issue 当前标签（人打的 + 我们打的）。 */
  readonly currentLabels: readonly string[];
  /** 我们在该 issue 上持有的标签（`bot_labels`）。 */
  readonly botLabels: readonly string[];
  /** `bot_labels` 里被人工撤下的标签（`loadHumanVetoed()` 的产物）；缺省 = 不知道。 */
  readonly humanVetoed?: readonly string[];
  /** 仓库里当前存在的标签；缺省时尝试 `catalog.list`（两者都没有就不判 missing）。 */
  readonly repoLabels?: readonly string[];
  readonly config: RepoConfig;
  /** 要执行的技能（通常是 `/issue-triage`；从注册表取，禁用态取不到）。 */
  readonly skill: SkillDefinition;
  /** 命令参数（webhook 触发时为空）。 */
  readonly inputs?: Readonly<Record<string, string>>;
  readonly headSha?: string | null;
  /**
   * issue 版本 hash（webhook 的 `issueVersionHash`）：本轮的幂等锚。
   * 不给时 `label_decisions.judgement_hash` 为 `NULL`（不是「用缺失项集合代替」）。
   */
  readonly issueVersionHash?: string | null;
  readonly dryRun?: boolean;
  /** 触发者（审计用；webhook 判定类记 `github`）。 */
  readonly triggerActor?: string;
};

export type TriageOutcome =
  /** 标签已按计划增删（或计划为空、无事可做）。 */
  | 'applied'
  /** 没有需要打的标签 / 该打的都被拦了：什么都没写。 */
  | 'nothing'
  /** 没拿到可用信封：一律不动标签。 */
  | 'no-envelope'
  /** 只算不写（dry-run，或没注入写执行器）。 */
  | 'dry-run';

/** 缺的一项必填信息（来自 `verdict.evidence` 的 `passed !== true`）。 */
export type MissingEvidence = {
  readonly rule: string;
  /** 命中的原文片段（已截断）；`null` = 模型没给证据。 */
  readonly quote: string | null;
};

export type TriageResult = {
  readonly outcome: TriageOutcome;
  readonly verdict: Verdict | null;
  /** 归一化之后真正要打的标签（按仓库实际标签名）。 */
  readonly desiredLabels: readonly string[];
  /** `labels.map` 没映射上的判定键（R4 降级的原因，保留给审计）。 */
  readonly unmappedLabels: readonly string[];
  /** 全部被拦的标签 + 原因（词表外 / 互斥组 / 上限 / 人工否决 / 仓库里没有）。 */
  readonly blockedLabels: readonly BlockedLabel[];
  readonly delta: LabelDelta | null;
  readonly label: LabelOutcome | null;
  readonly warnings: readonly string[];
  /** 实际交给 worker 的 prompt（审计与 `run_events` 用它，不参与判定）。 */
  readonly prompt: string;
  /** 本轮幂等锚（issue 版本 hash）。 */
  readonly judgementHash: string | null;
  /** 缺哪几项必填信息（空数组 = 不缺）。 */
  readonly missingEvidence: readonly MissingEvidence[];
  /** `needs-info` 在该仓库里的实际标签名。 */
  readonly needsInfoLabel: string;
  /** 本轮给 issue 打的 reaction；没打为 `null`。 */
  readonly reaction: 'confused' | null;
  /** 打标 / 打 reaction 的失败信号（**永远 `fatal: false`**）。 */
  readonly failure: TriageFailureSignal | null;
};

/** 默认 id 生成器：`task-<uuid>` / `run-<uuid>`（与 worker 的 id 口径一致）。 */
const defaultIds = (): { taskId: string; runId: string } => {
  const uuid = randomUUID();
  return { taskId: `task-${uuid}`, runId: `run-${uuid}` };
};

/**
 * 把 `needs-info` 的缺省映射补进配置副本。
 *
 * 为什么在这里补而不是要求每个仓库都写 `labels.map['needs-info']`：
 * 缺信息打标是**平台级行为**（§0.3），不该因为一个新仓库没配映射就静默失效；
 * 配了映射的按映射走（`labels.map['needs-info'] = '缺少信息'` 之类），没配就用字面量。
 */
function withNeedsInfoFallback(config: RepoConfig): RepoConfig {
  if (config.labels.map[NEEDS_INFO_KEY] !== undefined) {
    return config;
  }
  return {
    ...config,
    labels: { ...config.labels, map: { ...config.labels.map, [NEEDS_INFO_KEY]: NEEDS_INFO_FALLBACK_LABEL } },
  };
}

/** `needs-info` 在该仓库里的实际标签名（映射的第一项；1:N 时取第一个）。 */
export function needsInfoLabelOf(config: RepoConfig): string {
  const mapped = config.labels.map[NEEDS_INFO_KEY];
  if (mapped === undefined) {
    return NEEDS_INFO_FALLBACK_LABEL;
  }
  const first = typeof mapped === 'string' ? mapped : mapped[0];
  return first === undefined || first === '' ? NEEDS_INFO_FALLBACK_LABEL : first;
}

/** 从 verdict 里看出「缺哪些必填信息」：`passed !== true` 的都算缺（「没证据」≠「通过了」）。 */
export function missingEvidenceOf(verdict: Verdict | null): readonly MissingEvidence[] {
  const evidence = verdict?.evidence ?? [];
  return evidence
    .filter((item) => item.passed !== true)
    .map((item) => {
      const quote = (item.quote ?? '').trim();
      return {
        rule: item.rule,
        quote: quote === '' ? null : quote.slice(0, REASON_QUOTE_LIMIT),
      };
    });
}

/** 把缺项写成人读的一句话（`label_decisions.reason`，面板直接展示）。 */
export function describeMissing(evidence: readonly MissingEvidence[]): string | null {
  if (evidence.length === 0) {
    return null;
  }
  const items = evidence.map((item) =>
    item.quote === null ? `${item.rule}（当前正文里找不到依据）` : `${item.rule}（引用：「${item.quote}」）`,
  );
  return `缺 ${String(evidence.length)} 项必填信息：${items.join('；')}`;
}

/**
 * `labels.missing` 的三个策略。
 *
 * 只有**知道仓库里有哪些标签**时才判 missing（`repoLabels` 或 `catalog.list`）：
 * 不知道就当作「都存在」——凭猜删/建标签的代价比少打一个标签大得多。
 */
async function applyMissingPolicy(input: {
  readonly deps: TriageDeps;
  readonly repo: string;
  readonly desired: readonly string[];
  readonly vocabulary: Readonly<Record<string, { readonly color?: string; readonly description?: string }>>;
  readonly policy: 'warn' | 'create' | 'ignore';
  readonly knownLabels: readonly string[] | null;
  readonly warnings: string[];
}): Promise<{ desired: readonly string[]; blocked: readonly BlockedLabel[] }> {
  const known = input.knownLabels;
  if (known === null) {
    return { desired: input.desired, blocked: [] };
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
      const create = input.deps.catalog?.create;
      if (entry !== undefined && create !== undefined) {
        try {
          await create.call(input.deps.catalog, {
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
            detail: `\`${label}\` 建标签失败：${String(error)}`,
            sourceKey: null,
          });
          input.warnings.push(`建标签 \`${label}\` 失败：${String(error)}`);
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
    // warn（默认）：只记下来，面板可见，不写 GitHub。
    blocked.push({
      label,
      reason: 'missing-label',
      detail: `仓库里没有 \`${label}\` 这个标签；labels.missing=warn（只记台账，需要建标签请把策略改成 create）`,
      sourceKey: null,
    });
    input.warnings.push(`仓库里没有 \`${label}\` 这个标签：按 labels.missing=warn 只记台账`);
  }

  return { desired: kept, blocked };
}

/**
 * 跑一次分类打标。
 *
 * 顺序：渲染 → 跑 worker → 读 verdict → 归一化 → 缺信息补 `needs-info` → diff → 写。
 * 任何一步拿不到可信结果都**停在原地**（不打标），而不是猜一个默认标签。
 */
export async function runTriage(deps: TriageDeps, input: TriageInput): Promise<TriageResult> {
  const warnings: string[] = [];
  const ids = (deps.ids ?? defaultIds)();
  const judgementHash = input.issueVersionHash ?? null;
  const needsInfoLabel = needsInfoLabelOf(input.config);
  const labelsConfig = withNeedsInfoFallback(input.config);
  const at = (deps.now ?? (() => new Date()))();
  const runUuid = toRunUuid(ids.runId);

  /** 记录器（每轮一行）；dry-run 也记——那是「本来会怎么做」的唯一凭据。 */
  const record = async (fields: {
    desired: readonly string[];
    applied: readonly string[];
    blocked: readonly BlockedLabel[];
    reason: string | null;
    dryRun: boolean;
  }): Promise<void> => {
    if (deps.decisions === undefined) {
      return;
    }
    try {
      await deps.decisions.record({
        repo: input.repo,
        targetNumber: input.issueNumber,
        judgementHash,
        desired: fields.desired,
        applied: fields.applied,
        blocked: fields.blocked,
        reason: fields.dryRun ? `dry-run：${fields.reason ?? '只算不写'}` : fields.reason,
        runId: runUuid,
      });
    } catch (error) {
      // 台账写失败不翻 run：它只是审计，判定与标签都已经发生。
      deps.logger?.warn({ repo: input.repo, issue: input.issueNumber, err: String(error) }, 'label_decisions 落库失败');
    }
  };

  const rendered = renderSkillPrompt({
    skill: input.skill,
    inputs: input.inputs ?? {},
    context: {
      repo: input.repo,
      targetKind: 'issue',
      targetNumber: input.issueNumber,
      title: input.title,
      body: input.body,
      labels: input.currentLabels,
      headSha: input.headSha ?? null,
      // 标签词表注入提示词（替掉 `worker-deps.ts` / `builtin.ts` 里的硬编码标签集）
      config: labelsConfig,
    },
  });
  if (rendered.stats.truncated) {
    warnings.push('issue 正文超过长度上限已截断；判定只基于前 4000 字符');
  }
  if (rendered.stats.unknownPlaceholders.length > 0) {
    warnings.push(`技能正文里有未识别的占位符：${rendered.stats.unknownPlaceholders.join(', ')}`);
  }

  const report = await deps.runner.runTask({
    taskId: ids.taskId,
    runId: ids.runId,
    command: input.skill.name,
    repo: input.repo,
    targetKind: 'issue',
    targetNumber: input.issueNumber,
    ...(input.headSha === undefined || input.headSha === null ? {} : { headSha: input.headSha }),
    prompt: rendered.prompt,
    dryRun: input.dryRun ?? false,
  });

  const prepared = report.envelope;
  if (prepared === null || !prepared.valid || prepared.envelope === null) {
    const reason = prepared === null ? '没找到信封' : `信封不合规：${prepared.errors.map((e) => e.path).join(', ')}`;
    deps.logger?.warn({ repo: input.repo, issue: input.issueNumber, reason }, '分类打标拿不到可用信封，本次不动标签');
    await record({ desired: [], applied: [], blocked: [], reason, dryRun: input.dryRun === true });
    return {
      outcome: 'no-envelope',
      verdict: null,
      desiredLabels: [],
      unmappedLabels: [],
      blockedLabels: [],
      delta: null,
      label: null,
      warnings: [...warnings, reason],
      prompt: rendered.prompt,
      judgementHash,
      missingEvidence: [],
      needsInfoLabel,
      reaction: null,
      failure: null,
    };
  }
  if (report.outcome !== 'succeeded') {
    warnings.push(`run 终态为 ${report.outcome}：判定结果仍可用，但已记入审计`);
  }

  const verdict = prepared.envelope.verdict;
  const missingEvidence = missingEvidenceOf(verdict);

  /* ── 判定键：verdict.labels + 缺必填信息时的 `needs-info` ─────────────────── */
  const keys = [...verdict.labels];
  if (missingEvidence.length > 0 && !keys.includes(NEEDS_INFO_KEY)) {
    keys.push(NEEDS_INFO_KEY);
  }

  const normalized = normalizeDesired({
    keys,
    labels: labelsConfig.labels,
    ...(input.humanVetoed === undefined ? {} : { humanVetoed: input.humanVetoed }),
  });
  warnings.push(...normalized.warnings);

  /* ── 仓库里有没有这些标签（`labels.missing` 策略） ─────────────────────────── */
  const knownLabels = await resolveKnownLabels(deps, input, warnings);
  const missingPolicy = await applyMissingPolicy({
    deps,
    repo: input.repo,
    desired: normalized.desired,
    vocabulary: normalized.vocabulary,
    policy: labelsConfig.labels.missing,
    knownLabels,
    warnings,
  });
  const blocked = [...normalized.blocked, ...missingPolicy.blocked];
  const desired = [...missingPolicy.desired];

  const canLabel = allowedIntentsOf(input.skill.effective.outputs).includes('label');
  if (!canLabel) {
    warnings.push(`技能 ${input.skill.name} 的 outputs 不含 labels：本命令不允许打标`);
  }
  const finalDesired = canLabel ? desired : [];

  const unmappedLabels = blocked.filter((item) => item.reason === 'unmapped').map((item) => item.label);
  const reason = buildReason({
    missingEvidence,
    blocked,
    needsInfoLabel,
    hasNeedsInfo: finalDesired.includes(needsInfoLabel),
  });

  const dryRun = input.dryRun === true || deps.github === undefined;
  if (dryRun) {
    if (input.dryRun !== true) {
      warnings.push('未注入 GitHub 写执行器：按 dry-run 处理（只算 diff 不写）');
    }
    const delta = planLabelDelta(input.currentLabels, input.botLabels, finalDesired);
    await record({ desired: finalDesired, applied: [], blocked, reason, dryRun: true });
    return {
      outcome: 'dry-run',
      verdict,
      desiredLabels: finalDesired,
      unmappedLabels,
      blockedLabels: blocked,
      delta,
      label: null,
      warnings,
      prompt: rendered.prompt,
      judgementHash,
      missingEvidence,
      needsInfoLabel,
      reaction: null,
      failure: null,
    };
  }

  /* ── 落标（沿用 planLabelDelta + executeLabelPlan，不重写执行器） ───────────── */
  const attribution: BotLabelAttribution = {
    runId: runUuid,
    judgementHash,
    byLabel: Object.fromEntries(
      finalDesired.map((label) => [
        label,
        {
          ...(normalized.sourceKeys[label] === undefined ? {} : { sourceKey: normalized.sourceKeys[label] }),
          ...(label === needsInfoLabel && reason !== null ? { reason } : {}),
        },
      ]),
    ),
  };
  const ledger = typeof deps.ledger === 'function' ? deps.ledger(attribution) : deps.ledger;

  let label: LabelOutcome | null = null;
  let failure: TriageFailureSignal | null = null;
  const delta = planLabelDelta(input.currentLabels, input.botLabels, finalDesired);

  if (delta.add.length > 0 || delta.remove.length > 0) {
    try {
      label = await executeLabelPlan(
        deps.github,
        {
          repo: input.repo,
          issueNumber: input.issueNumber,
          current: input.currentLabels,
          botLabels: input.botLabels,
          desired: finalDesired,
        },
        ledger,
      );
    } catch (error) {
      failure = { fatal: false, failureClass: 'label', message: `打标失败：${String(error)}` };
      warnings.push(failure.message);
      deps.logger?.warn(
        { repo: input.repo, issue: input.issueNumber, err: String(error) },
        '打标失败（fatal=false，不翻 run）',
      );
    }
  }

  /* ── 缺必填信息 → `confused` reaction（不评论，§0.4） ─────────────────────── */
  let reaction: 'confused' | null = null;
  if (missingEvidence.length > 0) {
    if (deps.reaction === undefined) {
      warnings.push('未注入 reaction 端口：缺信息时打不了 confused reaction');
    } else {
      try {
        await deps.reaction.add({
          repo: input.repo,
          targetKind: 'issue',
          targetNumber: input.issueNumber,
          content: 'confused',
        });
        reaction = 'confused';
      } catch (error) {
        failure = failure ?? {
          fatal: false,
          failureClass: 'reaction',
          message: `打 confused reaction 失败：${String(error)}`,
        };
        warnings.push(`打 confused reaction 失败：${String(error)}`);
      }
    }
  }

  await record({
    desired: finalDesired,
    applied: label?.added ?? [],
    blocked,
    reason,
    dryRun: false,
  });

  const touched = (label?.added.length ?? 0) + (label?.removed.length ?? 0) > 0;
  if (touched) {
    deps.logger?.info(
      {
        repo: input.repo,
        issue: input.issueNumber,
        added: label?.added ?? [],
        removed: label?.removed ?? [],
        retainedHumanOwned: label?.delta.retainHumanOwned ?? [],
        missing: missingEvidence.map((item) => item.rule),
        at: at.toISOString(),
      },
      '分类打标完成',
    );
  }

  return {
    outcome: touched ? 'applied' : 'nothing',
    verdict,
    desiredLabels: finalDesired,
    unmappedLabels,
    blockedLabels: blocked,
    delta,
    label,
    warnings,
    prompt: rendered.prompt,
    judgementHash,
    missingEvidence,
    needsInfoLabel,
    reaction,
    failure,
  };
}

/** 仓库里有哪些标签：`input.repoLabels` 优先，其次 `catalog.list`，都没有 → `null`（不判 missing）。 */
async function resolveKnownLabels(
  deps: TriageDeps,
  input: TriageInput,
  warnings: string[],
): Promise<readonly string[] | null> {
  if (input.repoLabels !== undefined) {
    return input.repoLabels;
  }
  const list = deps.catalog?.list;
  if (list === undefined) {
    return null;
  }
  try {
    return await list.call(deps.catalog, { repo: input.repo });
  } catch (error) {
    warnings.push(`读仓库标签列表失败（本次不判 labels.missing）：${String(error)}`);
    return null;
  }
}

/** `label_decisions.reason`：缺哪几项 + 被拦了什么（面板一句话能读完）。 */
function buildReason(input: {
  readonly missingEvidence: readonly MissingEvidence[];
  readonly blocked: readonly BlockedLabel[];
  readonly needsInfoLabel: string;
  readonly hasNeedsInfo: boolean;
}): string | null {
  const parts: string[] = [];
  const missing = describeMissing(input.missingEvidence);
  if (missing !== null) {
    parts.push(input.hasNeedsInfo ? `${missing}；已打 \`${input.needsInfoLabel}\`` : missing);
  }
  const blockedSummary = summarizeBlockedReason(input.blocked);
  if (blockedSummary !== null) {
    parts.push(`未打：${blockedSummary}`);
  }
  return parts.length === 0 ? null : parts.join('；');
}

/** `run_id` 列是 uuid：`run-<uuid>` 去掉前缀再判定，非法则写 `NULL`（不让 insert 整条失败）。 */
function toRunUuid(value: string): string | null {
  const candidate = value.replace(/^run-/iu, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(candidate) ? candidate : null;
}
