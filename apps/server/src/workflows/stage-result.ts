/**
 * 阶段结论的**读取与校验**（`docs/plan-fixed-pipeline.md` §4.1 / §6 / §10.3）。
 *
 * 阶段任务复用同一个信封，只在顶层多了一个可选的 `stage`：
 *
 * ```jsonc
 * { "stage": { "name": "format" | "classify", "result": "pass" | "fail" | "requirement" | … } }
 * ```
 *
 * 这里做三件**控制面**必须做的事（做完才允许写库；任何一条不过 → `ok:false`，
 * 调用方置 `blocked` 并**零写入**）：
 *
 *  1. `stage.name` 必须等于任务所属阶段——不然一个 `format` 任务可以自称 `classify` 的结论；
 *  2. `result` 必须在该阶段允许集合内（`STAGE_RESULTS_BY_NAME`，契约层与信封 schema 同一份）；
 *  3. **正确性校验**（不是排版要求）：`classify` 且 `result='defect'` 时，
 *     `verdict.evidence` 至少要有一条 `rule` 以 `code:` 开头、`quote` 命中 `path:line`
 *     ——缺陷报告的第一件事是「在哪一行」，没有行号就不是缺陷报告。
 *     不满足 → **强制降级 `not-found`**（D3/Q6 修订的虚拟缺陷路径），并带 `downgraded: true`。
 *
 * 为什么降级而不是 `ok:false`：模型说「这是缺陷但我说不出在哪」，那正好是「当前查不到」
 * 的业务语义——走 not-found 会让 issue 停在 `classify/awaiting_info` 等管理员，
 * 比整轮失败（`blocked`）对用户友好得多，也不会白烧一次分类容器。
 */
import { STAGE_RESULTS_BY_NAME } from '../../../../packages/envelope/src/index.ts';
import type {
  EnvelopeStageName,
  EnvelopeStageResult,
  TaskEnvelope,
  Verdict,
  VerdictEvidence,
} from '../../../../packages/envelope/src/index.ts';

/* ── 口径常量 ─────────────────────────────────────────────────────────────── */

/**
 * 「这是哪一行」的证据形式：`path/to/file.ts:123`。
 *
 * 只认 `quote` 的**开头**（`^`）：证据里允许写「…:123 这里少判了空值」，
 * 但不允许把行号埋在句子中间——那样面板点不进代码，人也没法核对。
 * `path` 允许 `\w./-`（覆盖 `src/a/b.ts`、`packages/x/src/index.ts`、`./a.ts`）。
 */
export const CODE_QUOTE_RE = /^[\w./-]+\.\w+:\d+/u;

/** 缺陷证据的 `rule` 前缀（提示词里约定 `rule=code:...`）。 */
export const CODE_RULE_PREFIX = 'code:';

/** 「已查范围」证据的 `rule` 前缀（§6：查不到时必须写清查了哪儿，面板可复核）。 */
export const CHECKED_RULE_PREFIX = 'checked:';

/* ── 类型 ─────────────────────────────────────────────────────────────────── */

/** 读取成功时的结论（`result` 已经过降级处理）。 */
export type StageResultReadOk = {
  readonly ok: true;
  readonly stage: EnvelopeStageName;
  readonly result: EnvelopeStageResult;
  /** 是否被控制面降级（`defect` → `not-found`） */
  readonly downgraded: boolean;
  /** 降级/说明用的一句话（给人读，进日志与 `blocked_reason` 之外的审计） */
  readonly detail: string | null;
  /** 评论正文（阶段任务的 `actions[].intent=comment`，最多取第一条非空） */
  readonly commentBody: string | null;
  /** 「已查范围」（`rule=checked:...` 的证据），面板展示用 */
  readonly checkedScope: readonly VerdictEvidence[];
};

/** 读取失败：调用方置 `blocked`，**零写入**。 */
export type StageResultReadFail = {
  readonly ok: false;
  readonly reason: StageResultRejectReason;
  readonly detail: string;
};

export type StageResultRejectReason =
  /** 阶段任务的信封里没有 `stage`（老信封 / 模型漏了） */
  | 'missing-stage'
  /** `stage.name` 与任务阶段不一致 */
  | 'stage-mismatch'
  /** `result` 不在该阶段的允许集合内 */
  | 'result-not-allowed';

export type StageResultRead = StageResultReadOk | StageResultReadFail;

/* ── 缺必填信息（`verdict.evidence` → `needs-info` 的唯一判据） ───────────────── */

/** `label_decisions.reason` 里引用原文片段的上限（长引用会让面板变成噪声）。 */
export const REASON_QUOTE_LIMIT = 80;

/** 缺的一项必填信息（来自 `verdict.evidence` 的 `passed !== true`）。 */
export type MissingEvidence = {
  readonly rule: string;
  /** 命中的原文片段（已截断）；`null` = 模型没给证据。 */
  readonly quote: string | null;
};

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

/* ── 读取 ─────────────────────────────────────────────────────────────────── */

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 证据条目清洗：只保留 `rule` / `quote` 都是非空字符串的（`passed` 可选）。 */
export function evidenceOf(envelope: unknown): VerdictEvidence[] {
  const verdict = recordOf(recordOf(envelope)?.['verdict']);
  const evidence = verdict?.['evidence'];
  if (!Array.isArray(evidence)) {
    return [];
  }
  const out: VerdictEvidence[] = [];
  for (const item of evidence) {
    const record = recordOf(item);
    const rule = textOf(record?.['rule']);
    const quote = textOf(record?.['quote']);
    if (rule === null || quote === null) {
      continue;
    }
    const passed = record?.['passed'];
    out.push({
      rule,
      quote,
      ...(typeof passed === 'boolean' ? { passed } : {}),
    });
  }
  return out;
}

/**
 * 有 `path:line` 的代码证据（`defect` 的**硬要求**）。
 *
 * `passed === false` 也算：报告一条「这里写错了」的证据，`passed` 当然是 false。
 */
export function codeEvidenceOf(evidence: readonly VerdictEvidence[]): VerdictEvidence[] {
  return evidence.filter(
    (item) => item.rule.startsWith(CODE_RULE_PREFIX) && CODE_QUOTE_RE.test(item.quote.trim()),
  );
}

/** 「已查范围」：`rule` 以 `checked:` 开头的条目（§6，面板展示「查了什么、没查到什么」）。 */
export function classifyEvidenceScope(evidence: readonly VerdictEvidence[]): VerdictEvidence[] {
  return evidence.filter((item) => item.rule.startsWith(CHECKED_RULE_PREFIX));
}

/** 阶段任务产出的评论正文：`actions[]` 里第一条非空 `comment`（没有 → `null`）。 */
export function commentBodyOf(envelope: unknown): string | null {
  const actions = recordOf(envelope)?.['actions'];
  if (!Array.isArray(actions)) {
    return null;
  }
  for (const action of actions) {
    const record = recordOf(action);
    if (record?.['intent'] !== 'comment') {
      continue;
    }
    const body = textOf(record['body']);
    if (body !== null && body.trim() !== '') {
      return body;
    }
  }
  return null;
}

/**
 * 读一个阶段任务的信封（§4.1 的三条控制面校验）。
 *
 * 第二个参数是**任务所属阶段**（来自 `tasks.command` 的 `pipeline:<stage>`），
 * 不是信封里自称的阶段：校验的方向就是「信封必须服从任务」。
 */
export function readStageResult(
  envelope: unknown,
  taskStage: EnvelopeStageName,
): StageResultRead {
  const stage = recordOf(recordOf(envelope)?.['stage']);
  if (stage === null) {
    return {
      ok: false,
      reason: 'missing-stage',
      detail: `${taskStage} 阶段的信封缺少顶层 stage：阶段任务必须给结论（stage.name + stage.result）`,
    };
  }
  const name = textOf(stage['name']);
  if (name === null || !(name in STAGE_RESULTS_BY_NAME)) {
    return {
      ok: false,
      reason: 'stage-mismatch',
      detail: `stage.name 非法（收到 ${JSON.stringify(stage['name'])}）：只能是 format / classify`,
    };
  }
  if (name !== taskStage) {
    return {
      ok: false,
      reason: 'stage-mismatch',
      detail: `stage.name=${name} 与任务阶段 ${taskStage} 不一致：阶段结论不能跨阶段自证`,
    };
  }
  const allowed = STAGE_RESULTS_BY_NAME[taskStage];
  const rawResult = textOf(stage['result']);
  if (rawResult === null || !(allowed as readonly string[]).includes(rawResult)) {
    return {
      ok: false,
      reason: 'result-not-allowed',
      detail: `${taskStage} 阶段的 stage.result 只能是 ${allowed.join(' / ')}（收到 ${JSON.stringify(stage['result'])}）`,
    };
  }

  const evidence = evidenceOf(envelope);
  const commentBody = commentBodyOf(envelope);
  const checkedScope = classifyEvidenceScope(evidence);
  let result = rawResult as EnvelopeStageResult;
  let downgraded = false;
  let detail: string | null = null;

  if (taskStage === 'classify' && result === 'defect' && codeEvidenceOf(evidence).length === 0) {
    // 正确性校验：缺陷报告必须有 `path:line`，否则按「当前查不到」处理（D3 → Q6 修订）
    result = 'not-found';
    downgraded = true;
    detail =
      'stage.result=defect 但 verdict.evidence 里没有 rule=code:* 且 quote 形如 path:line 的条目：已降级为 not-found';
  }

  return {
    ok: true,
    stage: taskStage,
    result,
    downgraded,
    detail,
    commentBody,
    checkedScope,
  };
}

/**
 * `pipeline:<stage>` → 阶段名（`notice` 不是流水线阶段，返回 `null`）。
 *
 * 放这里而不是 `workflows/pipeline.ts`：调用方（写回路径）拿到的是**信封**，
 * 它需要的正是「任务阶段」这一个词，和信封校验在同一处定义最不容易配错。
 */
export function stageOfPipelineCommand(
  command: string,
): EnvelopeStageName | null {
  if (command === 'pipeline:format') {
    return 'format';
  }
  if (command === 'pipeline:classify') {
    return 'classify';
  }
  return null;
}

/** 把 `TaskEnvelope` 收窄成「一定带 stage」的形状（`readStageResult` 通过之后用）。 */
export function stagedEnvelope(
  envelope: TaskEnvelope,
  stage: EnvelopeStageName,
  result: EnvelopeStageResult,
): TaskEnvelope & { stage: { name: EnvelopeStageName; result: EnvelopeStageResult } } {
  return { ...envelope, stage: { name: stage, result } };
}
