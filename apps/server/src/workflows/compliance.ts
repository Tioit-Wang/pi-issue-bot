/**
 * 标准合规检查（plan §6.2 / tech-plan §7.2 的 F4）——M1 的核心能力之一。
 *
 * 三件必须同时成立，少一件就会变成「骚扰机器人」或「该关的关不掉」：
 *
 * 1. **判定结构化**：每条配置规则出一行 pass/fail，附 issue 原文证据。
 *    配置里有、信封里没证据的规则算 **fail**（「没证据」不等于「通过了」）。
 * 2. **`missing_set_hash = sha256(sorted(失败的规则 id))`**，集合为空时为 `NULL`：
 *    这个哈希既是「要不要再回复」的判据（`plan §6.2` 同一句话不催第二次），
 *    也是 issue 判定类任务的幂等锚（`queue/idempotency.ts` 的 `missingSetHash`）。
 * 3. **回复条件只读 `issue_states`**：新 hash ≠ 旧 hash **或** `last_nudge_at IS NULL`。
 *    发完立刻记 `last_nudge_at`；集合变空则 `first_seen_at` 置 `NULL` 并按
 *    「只动自己打过的」撤掉 `needs-info`（`plan §6.1`）。
 *
 * 一条刻意的次序：**先落库再发评论**。反过来的话，评论成功但落库失败会让下一条 webhook
 * 重新催一遍（刷屏）；而落库成功但评论失败，下一轮 hash 未变且 `last_nudge_at` 还是 NULL，
 * 会补发一次——后者是**可自愈**的故障，前者不是。
 */
import { createHash } from 'node:crypto';
import type { ComplianceRule, RepoConfig } from '../../../../packages/contract/src/index.ts';
import type { Verdict, VerdictEvidence } from '../../../../packages/envelope/src/index.ts';
import { executeComment, executeLabelPlan, planLabelDelta } from '../github/executor.ts';
import type { BotLabelLedger, CommentOutcome, LabelOutcome } from '../github/executor.ts';
import type { GithubWriteApi } from '../github/types.ts';
import { sanitizeUntrustedText } from '../skills/prompt.ts';
import { applyMissingSet, loadIssueState, markNudged } from './issue-state.ts';
import type { IssueStateSnapshot } from './issue-state.ts';
import type { SqlRunner } from './ports.ts';

/** 配置里表达「缺信息」的判定键（值是该仓库里实际存在的标签名）。 */
export const NEEDS_INFO_KEY = 'needs-info';

/** 评论里引用原文片段的长度上限（长引用会把评论变成刷屏）。 */
export const QUOTE_LIMIT = 120;

/** 单条规则的判定结果。 */
export type ComplianceRuleVerdict = {
  /** 规则 id（进 `missing_set_hash` 的排序输入，必须稳定）。 */
  readonly rule: string;
  /** 出现在评论里的说明（配置没写就用 id）。 */
  readonly description: string;
  readonly required: boolean;
  readonly passed: boolean;
  /** 命中的原文片段（不可信内容，入评论前已中和）。 */
  readonly quote: string | null;
  /** 「为什么算 fail」的人读说明；通过时为 `null`。 */
  readonly note: string | null;
};

export type ComplianceVerdict = {
  readonly rules: readonly ComplianceRuleVerdict[];
  /** 未通过的必填规则 id（已排序、去重）。 */
  readonly failedRuleIds: readonly string[];
  /** `sha256(sorted(failed))`；空集合 → `null`。 */
  readonly missingSetHash: string | null;
  readonly pass: boolean;
  /** 可选规则（`required: false`）失败时不会进 hash，这里单独列出来给人看。 */
  readonly optionalFailures: readonly string[];
};

/** `missing_set_hash`。空集合返回 `null`（关闭判定要求 `missing_set_hash IS NOT NULL`）。 */
export function missingSetHashOf(failedRuleIds: readonly string[]): string | null {
  const ids = [...new Set(failedRuleIds)].sort();
  if (ids.length === 0) {
    return null;
  }
  return createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
}

function pickEvidence(evidence: readonly VerdictEvidence[], rule: string): VerdictEvidence | undefined {
  return evidence.find((item) => item.rule === rule);
}

/**
 * 按配置规则算出结构化判定。
 *
 * `verdict === null`（信封没拿到 / 校验失败）时**所有规则都算 fail**：
 * 这是安全的一侧——不能因为没有证据就把 issue 判成合规。
 */
export function evaluateCompliance(input: {
  readonly rules: readonly ComplianceRule[];
  readonly verdict: Verdict | null;
}): ComplianceVerdict {
  const evidence = input.verdict?.evidence ?? [];
  const rows: ComplianceRuleVerdict[] = input.rules.map((rule) => {
    const hit = pickEvidence(evidence, rule.id);
    const passed = hit !== undefined && hit.passed === true;
    const quote =
      hit === undefined ? null : sanitizeUntrustedText(hit.quote ?? '', QUOTE_LIMIT).text.trim() || null;
    return {
      rule: rule.id,
      description: rule.description ?? rule.id,
      required: rule.required,
      passed,
      quote,
      note: passed ? null : hit === undefined ? '信封里没有这条规则的证据' : '证据标记为未通过',
    };
  });

  const failedRequired = rows.filter((row) => !row.passed && row.required).map((row) => row.rule).sort();
  const optionalFailures = rows.filter((row) => !row.passed && !row.required).map((row) => row.rule).sort();

  return {
    rules: rows,
    failedRuleIds: failedRequired,
    missingSetHash: missingSetHashOf(failedRequired),
    pass: failedRequired.length === 0,
    optionalFailures,
  };
}

/** 标签映射结果（`labels.map` + `labels.allow`，R4）。 */
export type LabelResolution =
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly warning: string };

/**
 * 判定键 → 仓库实际标签名。
 *
 * 映射缺失**不发明标签**（plan §6.1 / tech-plan R4）：降级为「只评论不打标」并记 warn。
 * `labels.allow` 给定时，映射结果不在白名单里也按缺失处理（防手滑写错标签名）。
 */
export function resolveLabel(config: RepoConfig, key: string): LabelResolution {
  const mapped = config.labels.map[key];
  if (mapped === undefined) {
    return {
      ok: false,
      warning: `labels.map 里没有 \`${key}\` 的映射：按 R4 降级为只评论不打标（不发明标签）`,
    };
  }
  if (config.labels.allow !== undefined && !config.labels.allow.includes(mapped)) {
    return {
      ok: false,
      warning: `\`${key}\` 映射到 \`${mapped}\`，但它不在 labels.allow 白名单里：降级为只评论不打标`,
    };
  }
  return { ok: true, label: mapped };
}

/** 催办评论正文（纯函数；同样的缺失项集合产出同样的正文，隐藏标记因此天然去重）。 */
export function buildComplianceComment(verdict: ComplianceVerdict, rules: readonly ComplianceRule[]): string {
  const descriptions = new Map(rules.map((rule) => [rule.id, rule.description ?? rule.id]));
  const lines = [`## 还缺这些信息（${verdict.failedRuleIds.length} 项）`, ''];
  for (const id of verdict.failedRuleIds) {
    const row = verdict.rules.find((item) => item.rule === id);
    const description = descriptions.get(id) ?? id;
    const reason = row?.note ?? row?.quote ?? '';
    lines.push(`- **${id}**（${description}）${reason === '' ? '' : `：${reason}`}`);
  }
  lines.push(
    '',
    '补齐后我会自动复核；这条提示**只在缺失项发生变化时**再发一次。',
  );
  return lines.join('\n');
}

export type ComplianceOutcome =
  /** 仓库配置关了合规检查（`compliance.enabled: false`）。 */
  | 'disabled'
  /** 没有缺失项：集合已清空（并撤掉 needs-info）。 */
  | 'pass'
  /** 有缺失项且这次发了催办。 */
  | 'nudged'
  /** 有缺失项但和上次一模一样且已经催过：什么都不发。 */
  | 'unchanged'
  /** dry-run：只算不写。 */
  | 'dry-run';

export type ComplianceResult = {
  readonly outcome: ComplianceOutcome;
  readonly verdict: ComplianceVerdict;
  /** UPSERT 之后的状态行（dry-run 时是现有行或算出来的形状）。 */
  readonly state: IssueStateSnapshot;
  /** 缺失项集合是否变化（只有变化或从未催过才回复）。 */
  readonly missingSetChanged: boolean;
  readonly comment: CommentOutcome | null;
  readonly label: LabelOutcome | null;
  readonly delta: ReturnType<typeof planLabelDelta> | null;
  readonly warnings: readonly string[];
};

export type ComplianceDeps = {
  readonly db: SqlRunner;
  /** 写执行器；dry-run 或单测里算「只判定」时可不给。 */
  readonly github?: GithubWriteApi;
  readonly ledger?: BotLabelLedger;
  readonly now?: () => Date;
  readonly logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    info(fields: Record<string, unknown>, message: string): void;
  };
};

export type ComplianceInput = {
  readonly repo: string;
  readonly issueNumber: number;
  readonly config: RepoConfig;
  /** 信封的 verdict；没拿到信封传 `null`。 */
  readonly verdict: Verdict | null;
  /** issue 当前的标签（人打的 + 我们打的都在里面）。 */
  readonly currentLabels: readonly string[];
  /** 我们在该 issue 上持有的标签（`bot_labels`）。 */
  readonly botLabels: readonly string[];
  readonly dryRun?: boolean;
};

/** 空判定的占位（`compliance.enabled: false` 时用，避免上层到处判空）。 */
const EMPTY_VERDICT: ComplianceVerdict = {
  rules: [],
  failedRuleIds: [],
  missingSetHash: null,
  pass: true,
  optionalFailures: [],
};

/**
 * 跑一次合规判定并落库 / 回复。
 *
 * 入参里的 `currentLabels` / `botLabels` 由调用方从 GitHub 与 `bot_labels` 读出来传入：
 * 这一层不读 GitHub（只经 `GithubWriteApi` 写），也不自己重算「谁打的标签」。
 */
export async function applyCompliance(deps: ComplianceDeps, input: ComplianceInput): Promise<ComplianceResult> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const warnings: string[] = [];

  const previous = await loadIssueState(deps.db, { repo: input.repo, issueNumber: input.issueNumber });

  if (!input.config.compliance.enabled) {
    return {
      outcome: 'disabled',
      verdict: EMPTY_VERDICT,
      state: previous ?? emptyState(input.repo, input.issueNumber),
      missingSetChanged: false,
      comment: null,
      label: null,
      delta: null,
      warnings: ['仓库配置 compliance.enabled=false：不判定、不回复、不打标'],
    };
  }

  const verdict = evaluateCompliance({ rules: input.config.compliance.rules, verdict: input.verdict });
  const missingSetChanged = previous?.missingSetHash !== verdict.missingSetHash;

  /* ── 1. 先落库（`first_seen_at` 只在集合变化时推进） ─────────────────────── */
  const state = input.dryRun === true ? (previous ?? emptyState(input.repo, input.issueNumber)) : await applyMissingSet(deps.db, {
    repo: input.repo,
    issueNumber: input.issueNumber,
    missingSetHash: verdict.missingSetHash,
    at,
  });

  /* ── 2. 无缺失项：撤 needs-info（只撤自己打过的） ────────────────────────── */
  const resolution = resolveLabel(input.config, NEEDS_INFO_KEY);
  if (!resolution.ok) {
    warnings.push(resolution.warning);
  }

  if (verdict.pass) {
    if (resolution.ok && input.currentLabels.includes(resolution.label)) {
      const delta = planLabelDelta(
        input.currentLabels,
        input.botLabels,
        input.currentLabels.filter((label) => label !== resolution.label),
      );
      if (input.dryRun === true || deps.github === undefined) {
        return {
          outcome: input.dryRun === true ? 'dry-run' : 'pass',
          verdict,
          state,
          missingSetChanged,
          comment: null,
          label: null,
          delta,
          warnings,
        };
      }
      const label = await executeLabelPlan(
        deps.github,
        {
          repo: input.repo,
          issueNumber: input.issueNumber,
          current: input.currentLabels,
          botLabels: input.botLabels,
          desired: input.currentLabels.filter((item) => item !== resolution.label),
        },
        deps.ledger,
      );
      return { outcome: 'pass', verdict, state, missingSetChanged, comment: null, label, delta, warnings };
    }
    return {
      outcome: 'pass',
      verdict,
      state,
      missingSetChanged,
      comment: null,
      label: null,
      delta: null,
      warnings,
    };
  }

  /* ── 3. 有缺失项：回复条件 = 集合变了 或 从未催过 ────────────────────────── */
  const shouldNudge = missingSetChanged || state.lastNudgeAt === null;

  if (input.dryRun === true || deps.github === undefined) {
    if (input.dryRun !== true) {
      warnings.push('未注入 GitHub 写执行器：按 dry-run 处理（只判定不写）');
    }
    return {
      outcome: 'dry-run',
      verdict,
      state,
      missingSetChanged,
      comment: null,
      label: null,
      delta: planLabelDelta(input.currentLabels, input.botLabels, desiredWith(input.currentLabels, resolution)),
      warnings,
    };
  }

  let comment: CommentOutcome | null = null;
  if (shouldNudge) {
    comment = await executeComment(deps.github, {
      repo: input.repo,
      target: input.issueNumber,
      intent: 'compliance',
      body: buildComplianceComment(verdict, input.config.compliance.rules),
    });
    if (comment.action === 'posted') {
      // 只在真正发出去之后记：跳过（标记命中）说明这句话已经说过了。
      await markNudged(deps.db, { repo: input.repo, issueNumber: input.issueNumber, at });
    }
  }

  /* ── 4. 补 needs-info（幂等：已经在就不动） ──────────────────────────────── */
  let label: LabelOutcome | null = null;
  let delta: ReturnType<typeof planLabelDelta> | null = null;
  if (resolution.ok) {
    const desired = desiredWith(input.currentLabels, resolution);
    delta = planLabelDelta(input.currentLabels, input.botLabels, desired);
    if (delta.add.length > 0) {
      label = await executeLabelPlan(
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
    }
  }

  if (comment !== null) {
    deps.logger?.info(
      { repo: input.repo, issue: input.issueNumber, action: comment.action, missingSet: verdict.failedRuleIds },
      comment.action === 'posted' ? '合规催办已发出' : '合规催办命中隐藏标记，跳过',
    );
  }
  for (const warning of warnings) {
    deps.logger?.warn({ repo: input.repo, issue: input.issueNumber }, warning);
  }

  return {
    outcome: shouldNudge ? 'nudged' : 'unchanged',
    verdict,
    state,
    missingSetChanged,
    comment,
    label,
    delta,
    warnings,
  };
}

/** 在现有标签上补一个标签（其余标签原样保留，交给 `planLabelDelta` 判归属）。 */
function desiredWith(current: readonly string[], resolution: LabelResolution): readonly string[] {
  if (!resolution.ok || current.includes(resolution.label)) {
    return current;
  }
  return [...current, resolution.label];
}

/** `dry-run` 且库里还没有这一行时用的占位（形状与真实行一致，便于上层统一读）。 */
function emptyState(repo: string, issueNumber: number): IssueStateSnapshot {
  return {
    repo,
    issueNumber,
    missingSetHash: null,
    firstSeenAt: null,
    lastHumanReplyAt: null,
    lastNudgeAt: null,
    closedAt: null,
    updatedAt: null,
  };
}