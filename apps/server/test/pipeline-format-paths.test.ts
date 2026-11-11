/**
 * 阶段 0 的三条路径（`workflows/pipeline-format.ts::planFormatOutcome`，§5 / V2 / V3 / V4 / V19）。
 *
 * 这一组只测**纯函数**：动作集合（几条评论、什么标签、什么 reaction、要不要关）+ 要落的转移。
 * 写库与 GitHub 调用在 `pipeline-format-exec.test.ts`，那里才有真库与假 PR。
 */
import { describe, expect, it } from 'vitest';

import type { RepoConfig } from '../../../packages/contract/src/index.ts';
import { createPipelineLimits } from '../src/config/pipeline-constants.ts';
import {
  FORMAT_FAIL_COMMENT_FALLBACK,
  FORMAT_PASS_COMMENT_FALLBACK,
  planFormatOutcome,
} from '../src/workflows/pipeline-format.ts';
import type { FormatPlan, FormatPlanInput } from '../src/workflows/pipeline-format.ts';
import type { PipelineRow } from '../src/workflows/pipeline.ts';

const REPO = 'acme/widgets';
const ISSUE = 7;
const AT = new Date('2026-06-01T12:00:00.000Z');

/** 一行「格式检查正在跑」的状态（BeforeAll 之外每个用例自己覆盖）。 */
function pipelineRow(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    stage: 'format',
    state: 'pending',
    category: null,
    formatAttempts: 0,
    formatFailCount: 0,
    classifyAttempts: 0,
    issueVersion: 'v1',
    infoRequestedAt: null,
    lastRecheckAt: null,
    mentionSentAt: null,
    mentionCategory: null,
    gateNoticeAt: null,
    sessionId: null,
    sessionCursor: 0,
    sessionTurns: 0,
    sessionStartedAt: null,
    staleAt: null,
    blockedReason: null,
    readyAt: null,
    closedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

/** 一封信封（`stage.name` 必须与任务阶段一致，`readStageResult()` 会校验）。 */
function envelope(result: 'pass' | 'fail', comment: string | null = null): unknown {
  return {
    stage: { name: 'format', result },
    verdict: { kind: 'issue', labels: [], evidence: [] },
    actions:
      comment === null ? [] : [{ intent: 'comment', body: comment }],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
  };
}

function plan(over: Partial<FormatPlanInput> = {}): FormatPlan {
  return planFormatOutcome({
    repo: REPO,
    issueNumber: ISSUE,
    pipeline: pipelineRow(),
    envelope: envelope('pass'),
    envelopeValid: true,
    runOutcome: 'succeeded',
    command: 'pipeline:format',
    limits: createPipelineLimits(),
    at: AT,
    ...over,
  });
}

/** 动作的「形状摘要」：断言用（避免整段 body 进断言）。 */
function shape(p: FormatPlan): string[] {
  return p.actions.map((action) =>
    action.kind === 'comment'
      ? `comment:${action.source}`
      : action.kind === 'label'
        ? `label:${action.labels.join(',')}`
        : action.kind === 'reaction'
          ? `reaction:${action.content}`
          : 'closeIssue',
  );
}

const needsInfoConfig = (label: string): RepoConfig =>
  ({ labels: { map: { 'needs-info': label } } }) as unknown as RepoConfig;

describe('pass 首次（V2：零评论）', () => {
  it('没有任何评论动作，只有 rocket + 推进分类', () => {
    const result = plan();
    expect(result.outcome).toBe('pass-first');
    expect(shape(result)).toEqual(['reaction:rocket']);
    expect(result.transition).toMatchObject({
      stage: 'classify',
      state: 'pending',
      formatAttempts: 1,
    });
    // 推进分类：入队命令来自状态机的 effects（不在计划里另写一份）
    expect(result.transition?.effects?.enqueue).toBe('pipeline:classify');
    expect(result.transition && 'formatFailCount' in result.transition).toBe(false);
    expect(result.closeIssue).toBe(false);
  });

  it('通过不增加 format_fail_count，只把 attempts +1（两个计数别混）', () => {
    const result = plan({ pipeline: pipelineRow({ formatAttempts: 3, formatFailCount: 0 }) });
    expect(result.transition?.formatAttempts).toBe(4);
    expect(result.transition?.formatFailCount).toBeUndefined();
  });

  it('pass 不写 info_requested_at（只有 fail 才写）', () => {
    const result = plan({ pipeline: pipelineRow({ infoRequestedAt: AT }) });
    expect(result.transition?.infoRequestedAt).toBeNull();
  });
});

describe('pass 重检（V4 / D8：必须有一条确认评论）', () => {
  it('模型写了确认评论：用它，且标记 model', () => {
    const result = plan({
      pipeline: pipelineRow({ formatFailCount: 1 }),
      envelope: envelope('pass', '收到，补齐了，格式没问题。'),
    });
    expect(result.outcome).toBe('pass-recheck');
    expect(shape(result)).toEqual(['comment:model', 'reaction:rocket']);
    const comment = result.actions[0];
    expect(comment?.kind === 'comment' ? comment.body : '').toBe('收到，补齐了，格式没问题。');
  });

  it('模型没写：控制面兜底句 + warn + note（Q8 唯一例外）', () => {
    const warnings: string[] = [];
    const result = plan({
      pipeline: pipelineRow({ formatFailCount: 2 }),
      envelope: envelope('pass', null),
      logger: {
        warn: (_fields, message) => {
          warnings.push(String(message));
        },
      },
    });
    expect(shape(result)).toEqual(['comment:fallback', 'reaction:rocket']);
    const comment = result.actions[0];
    expect(comment?.kind === 'comment' ? comment.body : '').toBe(FORMAT_PASS_COMMENT_FALLBACK);
    expect(result.notes.join('|')).toContain('recheck-pass-without-comment');
    expect(warnings).toHaveLength(1);
  });
});

describe('fail（V3：恰好一条评论 + needs-info + confused + awaiting_info）', () => {
  it('评论 / 标签 / reaction / 状态一次给全', () => {
    const result = plan({
      envelope: envelope('fail', '缺复现步骤与期望结果。'),
      config: needsInfoConfig('需要信息'),
    });
    expect(result.outcome).toBe('fail');
    expect(shape(result)).toEqual(['comment:model', 'label:需要信息', 'reaction:confused']);
    expect(result.transition).toMatchObject({
      stage: 'format',
      state: 'awaiting_info',
      formatAttempts: 1,
      formatFailCount: 1,
      // 等用户：这一列非空 = 进 48h 关闭扫描
      infoRequestedAt: AT,
    });
    expect(result.closeIssue).toBe(false);
  });

  it('模型没写评论：兜底句 + warn', () => {
    const warnings: string[] = [];
    const result = plan({
      envelope: envelope('fail', null),
      logger: { warn: (_f, m) => warnings.push(String(m)) },
    });
    expect(result.actions[0]).toMatchObject({
      kind: 'comment',
      body: FORMAT_FAIL_COMMENT_FALLBACK,
      source: 'fallback',
    });
    expect(warnings.join('|')).toContain('没写评论');
  });

  it('没有仓库配置时 needs-info 用兜底标签名（不抛）', () => {
    const result = plan({ envelope: envelope('fail', '缺信息') });
    expect(shape(result)).toContain('label:needs-info');
  });

  it('同版本重投（状态已不在 format/pending）→ 一个字都不写', () => {
    const result = plan({
      pipeline: pipelineRow({ state: 'awaiting_info', infoRequestedAt: AT, formatFailCount: 1 }),
      envelope: envelope('fail', '再缺一次'),
    });
    expect(result.outcome).toBe('noop');
    expect(result.actions).toEqual([]);
    expect(result.transition?.ignore).toContain('not-format-running');
  });
});

describe('累计不通过 → 自动关 issue（V19 / Q5）', () => {
  it('第 5 次（默认上限）不通过：评论 + closeIssue，且不再打标/打 reaction/入队', () => {
    const result = plan({
      pipeline: pipelineRow({ formatFailCount: 4, formatAttempts: 4 }),
      envelope: envelope('fail', '第 5 次仍然缺信息。'),
    });
    expect(result.outcome).toBe('fail-closed');
    expect(shape(result)).toEqual(['comment:model', 'closeIssue']);
    expect(result.closeIssue).toBe(true);
    expect(result.transition).toMatchObject({
      stage: 'closed',
      state: 'closed',
      formatFailCount: 5,
      closedAt: AT,
      infoRequestedAt: null,
    });
    // 不再入队任何任务
    expect(result.transition?.effects?.enqueue ?? null).toBeNull();
  });

  it('注入 formatMaxFails=2：第 2 次不通过就关（阈值可注入）', () => {
    const limits = createPipelineLimits({ formatMaxFails: 2 });
    const first = plan({ limits, envelope: envelope('fail', '缺信息') });
    expect(first.outcome).toBe('fail');
    expect(first.closeIssue).toBe(false);

    const second = plan({
      limits,
      pipeline: pipelineRow({ formatFailCount: 1, formatAttempts: 1 }),
      envelope: envelope('fail', '还是缺'),
    });
    expect(second.outcome).toBe('fail-closed');
    expect(shape(second)).toEqual(['comment:model', 'closeIssue']);
  });

  it('到第 5 次也不另发关闭评论：评论恰好 1 条', () => {
    const result = plan({
      pipeline: pipelineRow({ formatFailCount: 4, formatAttempts: 4 }),
      envelope: envelope('fail', '最后一条反馈'),
    });
    expect(result.actions.filter((action) => action.kind === 'comment')).toHaveLength(1);
  });
});

describe('运行失败 / 信封不合法（§5 最后一行）', () => {
  it('第一次失败：不写任何东西，只把状态留在 pending', () => {
    const result = plan({ runOutcome: 'failed', envelopeValid: false, envelope: null });
    expect(result.outcome).toBe('noop');
    expect(result.actions).toEqual([]);
    expect(result.transition).toMatchObject({ state: 'pending', blockedReason: null });
  });

  it('连续 2 次：blocked + blocked_reason，仍然零写入', () => {
    const result = plan({
      runOutcome: 'failed',
      envelopeValid: false,
      envelope: null,
      consecutiveFailures: 2,
    });
    expect(result.outcome).toBe('blocked');
    expect(result.actions).toEqual([]);
    expect(result.transition?.state).toBe('blocked');
    expect(result.transition?.blockedReason).toContain('运行失败');
  });

  it('信封合规但缺 stage：按不合法处理（不猜结论）', () => {
    const result = plan({
      envelope: { verdict: { kind: 'issue', labels: [], evidence: [] }, actions: [], usage: {} },
      consecutiveFailures: 2,
    });
    expect(result.outcome).toBe('blocked');
    expect(result.actions).toEqual([]);
  });

  it('不是阶段 0 的命令：忽略（不改状态机）', () => {
    const result = plan({ command: 'pipeline:classify' });
    expect(result.outcome).toBe('noop');
    expect(result.transition).toBeNull();
  });

  it('没有流水线行：忽略', () => {
    const result = plan({ pipeline: null });
    expect(result.outcome).toBe('noop');
    expect(result.transition).toBeNull();
  });
});
