/**
 * 分类打标（plan §6.1）——M1 的第二个核心能力。
 *
 * 流程与每一步的取舍：
 *
 * 1. **渲染 prompt 交给 worker**：正文是不可信输入，围栏与截断在 `skills/prompt.ts`；
 *    这里只负责把上下文摆好（仓库 / 目标 / 标题 / 正文 / 当前标签）。
 * 2. **只认 `verdict.labels` 里的内部判定键**，再用 `.github/pi-bot.yml` 的 `labels.map`
 *    换成仓库里**实际存在**的标签。映射缺失 → 降级为「只评论不打标」并记 warn（R4）。
 * 3. **只增删自己打过的标签**：`planLabelDelta(current, botLabels, desired)`。
 *    人打的 `bug` 永远不会因为我们的重算被删掉——这是 plan §6.1 的第二条，也是
 *    「关掉机器人后仓库长什么样」的唯一保证。
 * 4. **编辑后重算幂等**：重算走同一条路径，diff 为空就没有任何写调用（不是「写了再撤」）。
 *
 * 不做什么：不设置信心阈值（plan §6.1 明确「一律打标」）；不执行信封里的其它 intent
 * （`comment`/`create_issue` 由 worker 的写执行器按 `outputs` 过滤后执行）；
 * 不自己决定谁可以触发（那是 `command-gate.ts`）。
 */
import { randomUUID } from 'node:crypto';
import type { RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { Verdict } from '../../../../packages/envelope/src/index.ts';
import { executeComment, executeLabelPlan, planLabelDelta } from '../github/executor.ts';
import type { BotLabelLedger, CommentOutcome, LabelDelta, LabelOutcome } from '../github/executor.ts';
import type { GithubWriteApi } from '../github/types.ts';
import { allowedIntentsOf, renderSkillPrompt } from '../skills/prompt.ts';
import type { SkillDefinition } from '../skills/types.ts';
import type { EnvelopeRunner } from './ports.ts';

export type TriageDeps = {
  /** 跑一趟任务拿信封（`createTaskRunner()` 的产物结构上满足）。 */
  readonly runner: EnvelopeRunner;
  /** 写执行器；dry-run 或单测里只判定时可不给。 */
  readonly github?: GithubWriteApi;
  readonly ledger?: BotLabelLedger;
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
  readonly config: RepoConfig;
  /** 要执行的技能（通常是 `/issue-triage`；从注册表取，禁用态取不到）。 */
  readonly skill: SkillDefinition;
  /** 命令参数（webhook 触发时为空）。 */
  readonly inputs?: Readonly<Record<string, string>>;
  readonly headSha?: string | null;
  readonly dryRun?: boolean;
  /** 触发者（审计用；webhook 判定类记 `github`）。 */
  readonly triggerActor?: string;
};

export type TriageOutcome =
  /** 标签已按计划增删（或计划为空、无事可做）。 */
  | 'applied'
  /** 没有需要打的标签也没有要发的评论。 */
  | 'nothing'
  /** 映射缺失 / 技能不允许打标：只发评论说明。 */
  | 'comment-only'
  /** 没拿到可用信封：一律不动标签。 */
  | 'no-envelope'
  /** 只算不写。 */
  | 'dry-run';

export type TriageResult = {
  readonly outcome: TriageOutcome;
  readonly verdict: Verdict | null;
  /** 映射之后真正要打的标签（按仓库实际标签名）。 */
  readonly desiredLabels: readonly string[];
  /** 判定键里有、但 `labels.map` 没有映射的键（R4 降级的原因）。 */
  readonly unmappedLabels: readonly string[];
  readonly delta: LabelDelta | null;
  readonly label: LabelOutcome | null;
  readonly comment: CommentOutcome | null;
  readonly warnings: readonly string[];
  /** 实际交给 worker 的 prompt（审计与 `run_events` 用它，不参与判定）。 */
  readonly prompt: string;
};

/** 默认 id 生成器：`task-<uuid>` / `run-<uuid>`（与 worker 的 id 口径一致）。 */
const defaultIds = (): { taskId: string; runId: string } => {
  const uuid = randomUUID();
  return { taskId: `task-${uuid}`, runId: `run-${uuid}` };
};

/**
 * 判定键 → 仓库标签名。返回 `{ mapped, unmapped }`，不抛错。
 *
 * 与 `compliance.ts::resolveLabel` 的差别：这里要一次处理整批标签（打标是批量的），
 * 所以缺失只记录、不改变「其余标签照打」的行为——**只有当整批都没映射上**时才降级为只评论。
 */
export function mapVerdictLabels(
  config: RepoConfig,
  keys: readonly string[],
): { readonly mapped: readonly string[]; readonly unmapped: readonly string[]; readonly rejected: readonly string[] } {
  const mapped: string[] = [];
  const unmapped: string[] = [];
  const rejected: string[] = [];
  for (const key of keys) {
    const label = config.labels.map[key];
    if (label === undefined) {
      unmapped.push(key);
      continue;
    }
    if (config.labels.allow !== undefined && !config.labels.allow.includes(label)) {
      rejected.push(key);
      continue;
    }
    if (!mapped.includes(label)) {
      mapped.push(label);
    }
  }
  return { mapped, unmapped, rejected };
}

/**
 * 跑一次分类打标。
 *
 * 顺序：渲染 → 跑 worker → 读 verdict → 映射 → diff → 写。
 * 任何一步拿不到可信结果都**停在原地**（不打标），而不是猜一个默认标签。
 */
export async function runTriage(deps: TriageDeps, input: TriageInput): Promise<TriageResult> {
  const warnings: string[] = [];
  const ids = (deps.ids ?? defaultIds)();

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
      config: input.config,
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
    return {
      outcome: 'no-envelope',
      verdict: null,
      desiredLabels: [],
      unmappedLabels: [],
      delta: null,
      label: null,
      comment: null,
      warnings: [...warnings, reason],
      prompt: rendered.prompt,
    };
  }
  if (report.outcome !== 'succeeded') {
    warnings.push(`run 终态为 ${report.outcome}：判定结果仍可用，但已记入审计`);
  }

  const verdict = prepared.envelope.verdict;
  const mapping = mapVerdictLabels(input.config, verdict.labels);
  for (const key of mapping.unmapped) {
    warnings.push(`判定键 \`${key}\` 在 labels.map 里没有映射：按 R4 不打这个标签`);
  }
  for (const key of mapping.rejected) {
    warnings.push(`判定键 \`${key}\` 映射到的标签不在 labels.allow 白名单里：不打`);
  }

  const canLabel = allowedIntentsOf(input.skill.effective.outputs).includes('label');
  if (!canLabel) {
    warnings.push(`技能 ${input.skill.name} 的 outputs 不含 labels：本命令不允许打标`);
  }

  const commentBody = pickCommentBody(prepared.envelope.actions);

  /* ── 整批都没映射上：降级为「只评论不打标」 ──────────────────────────────── */
  if (mapping.mapped.length === 0) {
    const body =
      commentBody ??
      [
        `判定结果里没有任何可打的标签（${verdict.labels.length === 0 ? 'labels 为空' : `未在 labels.map 里映射：${verdict.labels.join(', ')}`}）。`,
        '',
        '请检查 `.github/pi-bot.yml` 的 `labels.map`：本机器人不会发明标签名。',
      ].join('\n');
    if (input.dryRun === true || deps.github === undefined) {
      return {
        outcome: 'dry-run',
        verdict,
        desiredLabels: [],
        unmappedLabels: mapping.unmapped,
        delta: null,
        label: null,
        comment: null,
        warnings,
        prompt: rendered.prompt,
      };
    }
    const comment = await executeComment(deps.github, {
      repo: input.repo,
      target: input.issueNumber,
      intent: 'triage',
      body,
    });
    return {
      outcome: 'comment-only',
      verdict,
      desiredLabels: [],
      unmappedLabels: mapping.unmapped,
      delta: null,
      label: null,
      comment,
      warnings,
      prompt: rendered.prompt,
    };
  }

  /* ── 有映射：算 diff ─────────────────────────────────────────────────────── */
  const desired = canLabel ? mapping.mapped : [];
  const delta = planLabelDelta(input.currentLabels, input.botLabels, desired);

  if (input.dryRun === true || deps.github === undefined) {
    if (input.dryRun !== true) {
      warnings.push('未注入 GitHub 写执行器：按 dry-run 处理（只算 diff 不写）');
    }
    return {
      outcome: 'dry-run',
      verdict,
      desiredLabels: desired,
      unmappedLabels: mapping.unmapped,
      delta,
      label: null,
      comment: null,
      warnings,
      prompt: rendered.prompt,
    };
  }

  if (delta.add.length === 0 && delta.remove.length === 0) {
    return {
      outcome: 'nothing',
      verdict,
      desiredLabels: desired,
      unmappedLabels: mapping.unmapped,
      delta,
      label: { delta, added: [], removed: [] },
      comment: null,
      warnings,
      prompt: rendered.prompt,
    };
  }

  const label = await executeLabelPlan(
    deps.github,
    {
      repo: input.repo,
      issueNumber: input.issueNumber,
      current: input.currentLabels,
      botLabels: input.botLabels,
      desired,
    },
    deps.ledger,
  );

  deps.logger?.info(
    {
      repo: input.repo,
      issue: input.issueNumber,
      added: label.added,
      removed: label.removed,
      retainedHumanOwned: label.delta.retainHumanOwned,
    },
    '分类打标完成',
  );

  return {
    outcome: 'applied',
    verdict,
    desiredLabels: desired,
    unmappedLabels: mapping.unmapped,
    delta,
    label,
    comment: null,
    warnings,
    prompt: rendered.prompt,
  };
}

/** 从信封动作里取第一条 `comment` 的正文（降级路径复用它，避免自己编一段话）。 */
function pickCommentBody(actions: readonly { readonly intent: string; readonly body?: string }[]): string | null {
  for (const action of actions) {
    if (action.intent === 'comment' && typeof action.body === 'string' && action.body.trim() !== '') {
      return action.body;
    }
  }
  return null;
}