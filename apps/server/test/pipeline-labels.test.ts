/**
 * 分类结论 → 标签（`workflows/pipeline-labels.ts`）—— `docs/plan-fixed-pipeline.md` §4.5 / §6。
 *
 * 两条容易被写错的规则：
 *  - `not-found` **一律不打缺陷标签**（D3：虚拟缺陷不打标）；
 *  - 词表里没有该 role 的项 → 返回空数组 + warn 一次，**不报错**（流程照跑）。
 *
 * 另外验证「不重写第二套打标逻辑」：互斥组 / 上限仍然由 `normalizeDesired` 说了算。
 */
import { describe, expect, it } from 'vitest';
import { parseRepoSettings } from '../../../packages/contract/src/index.ts';
import type { RepoSettings } from '../../../packages/contract/src/index.ts';
import {
  labelsOfRole,
  pipelineLabelPlan,
  pipelineLabelsFor,
  pipelineLabelsToApply,
} from '../src/workflows/pipeline-labels.ts';

/** 用契约的解析器造 settings（默认值只有一处来源，测试不手抄）。 */
function settingsOf(input: unknown): RepoSettings {
  return parseRepoSettings(input);
}

const FULL = settingsOf({
  pipeline: { managers: ['alice'] },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement' },
      { name: '缺陷', role: 'defect' },
      { name: '咨询', role: 'other' },
      { name: '缺陷-后端', role: 'defect' },
    ],
  },
});

/** 只捕获 warn 的假 logger（不引 pino）。 */
function fakeLogger(): { warns: string[]; warn: (fields: unknown, message?: string) => void } {
  const warns: string[] = [];
  return {
    warns,
    warn: (_fields: unknown, message?: string) => {
      warns.push(message ?? '');
    },
  };
}

describe('labelsOfRole', () => {
  it('按 role 取名字，保持词表顺序并去重', () => {
    expect(labelsOfRole(FULL.labels.vocabulary, 'requirement')).toEqual(['需求']);
    expect(labelsOfRole(FULL.labels.vocabulary, 'defect')).toEqual(['缺陷', '缺陷-后端']);
    expect(labelsOfRole(FULL.labels.vocabulary, 'other')).toEqual(['咨询']);
  });

  it('词表里没有该 role → 空数组（不是抛错）', () => {
    const minimal = settingsOf({
      pipeline: { managers: ['alice'] },
      labels: { vocabulary: [{ name: '需求', role: 'requirement' }] },
    });
    expect(labelsOfRole(minimal.labels.vocabulary, 'defect')).toEqual([]);
  });
});

describe('pipelineLabelsFor', () => {
  it('requirement / defect / other 各取自己的 role', () => {
    expect(pipelineLabelsFor(FULL, 'requirement')).toEqual(['需求']);
    expect(pipelineLabelsFor(FULL, 'defect')).toEqual(['缺陷', '缺陷-后端']);
    expect(pipelineLabelsFor(FULL, 'other')).toEqual(['咨询']);
  });

  it('not-found 一律空数组（不打缺陷标签，D3）', () => {
    expect(pipelineLabelsFor(FULL, 'not-found')).toEqual([]);
  });

  it('缺该 role 时返回空 + warn 一次（流程继续，不报错）', () => {
    const minimal = settingsOf({
      pipeline: { managers: ['alice'] },
      labels: { vocabulary: [{ name: '需求', role: 'requirement' }] },
    });
    const logger = fakeLogger();
    expect(pipelineLabelsFor(minimal, 'defect', logger)).toEqual([]);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain('role=defect');
    // `not-found` 不触发 warn（本来就不该打标）
    expect(pipelineLabelsFor(minimal, 'not-found', logger)).toEqual([]);
    expect(logger.warns).toHaveLength(1);
  });
});

describe('pipelineLabelPlan：交给 normalizeDesired 做互斥组与上限', () => {
  it('同一互斥组只留第一个（词表 group 生效）', () => {
    const grouped = settingsOf({
      pipeline: { managers: ['alice'] },
      labels: {
        vocabulary: [
          { name: '需求', role: 'requirement', group: 'kind' },
          { name: '咨询', role: 'other', group: 'kind' },
        ],
        max_per_issue: 5,
      },
    });
    const plan = pipelineLabelPlan({ settings: grouped, result: 'requirement' });
    expect(plan.desired).toEqual(['需求']);
  });

  it('人工否决的标签不会被打回来', () => {
    const plan = pipelineLabelPlan({
      settings: FULL,
      result: 'defect',
      humanVetoed: ['缺陷-后端'],
    });
    expect(plan.desired).toEqual(['缺陷']);
    expect(plan.blocked.map((item) => item.reason)).toContain('human-veto');
  });

  it('not-found 归一化后仍然是空（没有 key 就没有 desired）', () => {
    expect(pipelineLabelsToApply({ settings: FULL, result: 'not-found' })).toEqual([]);
  });
});
