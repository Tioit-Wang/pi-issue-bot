/**
 * 流水线视图层（看板 / 时间线 / 证据 / 聚合）的单元测试。
 *
 * 断言盯的是**口径**，不是像素：
 *  - `pipeline === null` 必须进「未入流水线」，不能混进任何阶段列；
 *  - 指标条的「今日自动关闭」没有数据源时是 `—`（`null`），不许编数；
 *  - 阶段时间线永远三段，且「到没到」由 `stage` 决定；
 *  - 证据按 `rule` 前缀切两栏（`code:` / `checked:`），未知规则不吞掉。
 */
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/render.tsx';
import type { IssueListItem, IssuePipeline } from '../../../lib/contract.ts';
import { groupByStage, pipelineMetrics, sessionHealth } from '../aggregate.ts';
import { splitEvidence, ClassifyEvidence } from '../classify-evidence.tsx';
import { StageBoard } from '../stage-board.tsx';
import { buildSegments, StageTimeline } from '../stage-timeline.tsx';

const NOW = Date.parse('2026-06-02T12:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function pipeline(overrides: Partial<IssuePipeline> = {}): IssuePipeline {
  return {
    stage: 'format',
    state: 'pending',
    category: null,
    formatFailCount: 0,
    infoRequestedAt: null,
    blockedReason: null,
    readyAt: null,
    staleAt: null,
    sessionId: null,
    sessionTurns: 0,
    ...overrides,
  };
}

function item(number: number, p: IssuePipeline | null, overrides: Partial<IssueListItem> = {}): IssueListItem {
  return {
    repo: 'acme/widgets',
    kind: 'issue',
    number,
    title: `演示 ${String(number)}`,
    url: `https://github.com/acme/widgets/issues/${String(number)}`,
    state: 'open',
    stateStale: false,
    lastActivityAt: ago(30),
    humanTurns: 1,
    autoTurns: 0,
    botTurns: 1,
    lastReplyAt: null,
    lastActorLogin: 'alice',
    lastActorKind: 'human',
    awaitingReply: false,
    labels: [],
    outcomes: { succeeded: 1 },
    lastPreview: null,
    reactionState: null,
    labelDecisions: null,
    feedback: [],
    pipeline: p,
    ...overrides,
  };
}

const ROWS: IssueListItem[] = [
  item(1, pipeline({ stage: 'format', state: 'awaiting_info', formatFailCount: 2, infoRequestedAt: ago(3 * 60) })),
  item(2, pipeline({ stage: 'classify', state: 'awaiting_info', category: 'not-found' })),
  item(3, pipeline({ stage: 'agent', state: 'blocked', category: 'defect', formatFailCount: 4, blockedReason: '信封连续 2 次不合法' })),
  item(4, pipeline({ stage: 'agent', state: 'ready', category: 'requirement', readyAt: ago(120), sessionId: 'sess-1', sessionTurns: 27 })),
  item(5, pipeline({ stage: 'closed', state: 'closed', category: 'other' })),
  item(6, null),
];

describe('聚合口径（客户端按 /api/issues 的 pipeline 字段）', () => {
  it('pipeline === null 单独成组「未入流水线」，不进任何阶段列', () => {
    const groups = groupByStage(ROWS, NOW);
    expect(groups.unassigned.map((row) => row.number)).toEqual([6]);
    expect(groups.format).toHaveLength(1);
    expect(groups.classify).toHaveLength(1);
    // #4 的 readyAt 更早（停留更久）→ 排在 #3 前面；#3 没有时间锚点，用最后活动兜底
    expect(groups.agent.map((row) => row.number)).toEqual([4, 3]);
    expect(groups.closed).toHaveLength(1);
    // 四列 + unassigned = 全部行，一条不丢
    const total =
      groups.format.length + groups.classify.length + groups.agent.length + groups.closed.length + groups.unassigned.length;
    expect(total).toBe(ROWS.length);
  });

  it('列内按停留时长降序（等得久的在前）', () => {
    const groups = groupByStage(
      [
        item(7, pipeline({ stage: 'format', state: 'awaiting_info', infoRequestedAt: ago(10) })),
        item(8, pipeline({ stage: 'format', state: 'awaiting_info', infoRequestedAt: ago(300) })),
      ],
      NOW,
    );
    expect(groups.format.map((row) => row.number)).toEqual([8, 7]);
  });

  it('指标：在流水线不含已结束；待人补充带最久时长；阻塞带最大失败次数；今日自动关闭没有数据源 → null', () => {
    const metrics = pipelineMetrics(ROWS, NOW);
    expect(metrics.inPipeline).toBe(4);
    expect(metrics.awaiting).toBe(2);
    expect(metrics.awaitingLongestMs).toBeGreaterThan(2.9 * 60 * 60 * 1000);
    expect(metrics.blocked).toBe(1);
    expect(metrics.blockedMaxFails).toBe(4);
    expect(metrics.noRow).toBe(1);
    expect(metrics.closedRows).toBe(1);
    expect(metrics.closedToday).toBeNull();
  });

  it('会话健康：只统计有 sessionId 的行；已归档没有接口 → null；接近轮换按 25 轮算', () => {
    const health = sessionHealth(ROWS);
    expect(health.sessions).toBe(1);
    expect(health.avgTurns).toBe(27);
    expect(health.nearRotation).toBe(1);
    expect(health.archived).toBeNull();
  });
});

describe('阶段看板', () => {
  it('四列 + 列头计数 + 未入流水线一行', () => {
    renderWithProviders(<StageBoard groups={groupByStage(ROWS, NOW)} now={NOW} repo="acme/widgets" />);

    for (const [stage, count] of [
      ['format', '1'],
      ['classify', '1'],
      ['agent', '2'],
      ['closed', '1'],
    ] as const) {
      expect(screen.getByTestId(`stage-column-${stage}`)).toBeTruthy();
      expect(screen.getByTestId(`stage-count-${stage}`).textContent).toBe(count);
    }

    // 每张卡只有四项：标题 / 状态徽章 / 停留 / 尝试
    const card = screen.getByTestId('stage-card-acme/widgets#issue3');
    expect(card.textContent).toContain('演示 3');
    expect(within(card).getByTestId('pipeline-state-badge').textContent).toBe('阻塞');
    expect(within(card).getByTestId('stage-card-attempts').textContent).toBe('4/5 次');
    expect(within(card).getByTestId('stage-card-dwell').getAttribute('title') ?? '').toContain('起算：');

    // 未入流水线：单独一行，不混进阶段列
    expect(screen.getByTestId('stage-unassigned-count').textContent).toBe('1');
    expect(screen.getByTestId('stage-unassigned').textContent).toContain('#6');
    expect(within(screen.getByTestId('stage-column-format')).queryByText('演示 6')).toBeNull();
  });
});

describe('阶段时间线（三段）', () => {
  it('永远三段；已过的段是「已通过」，当前段是状态徽章，后面的段是「未开始」', () => {
    renderWithProviders(
      <StageTimeline pipeline={pipeline({ stage: 'classify', state: 'awaiting_info', category: 'not-found' })} now={NOW} />,
    );
    expect(screen.getByTestId('stage-timeline-format').getAttribute('data-status')).toBe('done');
    expect(screen.getByTestId('stage-timeline-classify').getAttribute('data-status')).toBe('current');
    expect(screen.getByTestId('stage-timeline-agent').getAttribute('data-status')).toBe('pending');

    const classify = screen.getByTestId('stage-timeline-classify');
    expect(classify.textContent).toContain('阶段 1 · 标签分类');
    expect(classify.textContent).toContain('待人补充');
    expect(within(classify).getByTestId('stage-fact-classify-结论').textContent).toBe('查不到');
  });

  it('关键事实：格式失败次数 / 分类结论 / 会话轮次都在，缺的写 —', () => {
    const segments = buildSegments(
      pipeline({ stage: 'agent', state: 'ready', category: 'defect', formatFailCount: 3, sessionId: null, sessionTurns: 4 }),
      NOW,
    );
    const facts = (key: 'format' | 'classify' | 'agent'): string[] =>
      segments
        .find((segment) => segment.key === key)
        ?.facts.map((fact) => `${fact.label}=${fact.value}`) ?? [];

    expect(facts('format')).toContain('格式不通过=3/5 次');
    expect(facts('classify')).toContain('结论=缺陷');
    expect(facts('agent')).toContain('会话=—');
    expect(facts('agent')).toContain('轮次=4/30');
  });

  it('没有流水线行时不画三段，只说一句事实', () => {
    renderWithProviders(<StageTimeline pipeline={null} now={NOW} />);
    expect(screen.getByTestId('stage-timeline').textContent).toContain('未入流水线');
    expect(screen.queryByTestId('stage-timeline-format')).toBeNull();
  });
});

describe('分类证据（两栏）', () => {
  const evidence = [
    { rule: 'code:apps/server/src/search/ranking.ts:118', quote: 'scoreOf()', passed: null },
    { rule: 'code:apps/server/src/db/schema.ts:42-58', quote: 'issue_pipeline 表定义', passed: true },
    { rule: 'checked:apps/server/src/search/**', quote: '翻了三个文件', passed: null },
    { rule: 'need-fix', quote: '未知前缀的规则', passed: false },
  ];

  it('按 rule 前缀切栏：code → 代码引用（path:line 拆开），checked → 已查范围，其余单列', () => {
    const split = splitEvidence(evidence);
    expect(split.code.map((ref) => `${ref.path}:${ref.line ?? ''}`)).toEqual([
      'apps/server/src/search/ranking.ts:118',
      'apps/server/src/db/schema.ts:42-58',
    ]);
    expect(split.checked.map((entry) => entry.scope)).toEqual(['apps/server/src/search/**']);
    expect(split.other.map((entry) => entry.rule)).toEqual(['need-fix']);
  });

  it('渲染成两栏 + 等宽引用', () => {
    renderWithProviders(<ClassifyEvidence evidence={evidence} />);
    expect(screen.getByTestId('evidence-code').textContent).toContain('代码引用 2');
    expect(screen.getByTestId('evidence-checked').textContent).toContain('已查范围 1');
    expect(screen.getByTestId('evidence-code').textContent).toContain('ranking.ts');
    expect(screen.getByTestId('evidence-other').textContent).toContain('need-fix');
  });

  it('没有证据时两栏都是 —，并说明这一版信封没有 evidence', () => {
    renderWithProviders(<ClassifyEvidence evidence={[]} />);
    expect(screen.getByTestId('evidence-code').textContent).toContain('—');
    expect(screen.getByTestId('evidence-checked').textContent).toContain('—');
    expect(screen.getByTestId('evidence-empty').textContent).toContain('verdict.evidence');
  });
});
