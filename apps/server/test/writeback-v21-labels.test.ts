/**
 * `writeback/v21/labels.ts` 的单测（`docs/v21-contract.md` §5 / FR-5.4 / BR-9~BR-11 / AC-14）。
 *
 * 这里验的是**保护规则**而不是算术：差集算错会被一眼看出来，
 * 但「空集被当成清空」「超限被静默截断」「把人打的标签删了」都是上线后才炸的那一类。
 * 所以每条规则都给一个「差点就会写错」的反例。
 */
import { describe, expect, it } from 'vitest';

import type { CatalogEntry, LabelPlanInput } from '../src/writeback/v21/labels.ts';
import {
  deletionOwner,
  describeLabelPlan,
  isManageableCatalogEntry,
  planLabelTargetState,
} from '../src/writeback/v21/labels.ts';

/** 一条默认「可管理」的目录项；overrides 用来造四种不可管理形态。 */
function entry(name: string, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name,
    meaning: `${name} 的含义`,
    managed: true,
    status: 'active',
    ...overrides,
  };
}

/** 常用目录：`缺陷` / `需求` 可管理，另外三条各有各的不可管理原因。 */
function catalog(): readonly CatalogEntry[] {
  return [
    entry('缺陷'),
    entry('需求'),
    entry('外部标签', { meaning: null }),
    entry('退役标签', { status: 'retired' }),
    entry('人工标签', { managed: false }),
  ];
}

function baseInput(overrides: Partial<LabelPlanInput> = {}): LabelPlanInput {
  return {
    current: [],
    desired: [],
    catalog: catalog(),
    maxPerIssue: 3,
    botLabels: [],
    ...overrides,
  };
}

describe('planLabelTargetState：空集保护与整批拒绝', () => {
  it('desired 为空且没有 clear → empty-without-clear（不删任何标签）', () => {
    const plan = planLabelTargetState(baseInput({ current: ['缺陷', '需求'] }));
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('empty-without-clear');
    expect(plan.detail).toContain('clear');
  });

  it('全空白的 desired 与空数组等价，同样拒绝', () => {
    const plan = planLabelTargetState(baseInput({ current: ['缺陷'], desired: ['  ', '\n'] }));
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('empty-without-clear');
  });

  it('clear=true 才允许表达「清空」，且只删可管理的标签', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['缺陷', '外部标签', '退役标签', '人工标签', '目录外'],
        desired: [],
        clear: true,
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual([]);
    expect(plan.remove).toEqual(['缺陷']);
    expect(plan.skipped.map((item) => item.reason)).toEqual([
      'missing-meaning',
      'retired',
      'unmanaged',
      'not-in-catalog',
    ]);
  });

  it('desired 超过 maxPerIssue → over-limit 整批拒绝，不截断前半段', () => {
    const plan = planLabelTargetState(
      baseInput({ current: ['需求'], desired: ['缺陷', '需求', '缺陷2', '缺陷3'], maxPerIssue: 3 }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toBe('over-limit');
    expect(plan.detail).toContain('整批拒绝');
    // ok:false 分支根本没有 add/remove 字段：语义上不可能只写一半。
    expect('add' in plan).toBe(false);
    expect('remove' in plan).toBe(false);
  });

  it('desired 里出现目录外/不可管理的标签 → unknown-label 整批拒绝', () => {
    for (const bad of ['外部标签', '退役标签', '人工标签', '根本不在目录']) {
      const plan = planLabelTargetState(baseInput({ desired: ['缺陷', bad] }));
      expect(plan.ok, `desired 含 ${bad} 应当整批拒绝`).toBe(false);
      if (plan.ok) {
        continue;
      }
      expect(plan.reason).toBe('unknown-label');
      expect(plan.detail).toContain(bad);
    }
  });
});

describe('planLabelTargetState：目标态差集与不可管理标签的保护', () => {
  it('add = desired − current，remove = current ∩ 可管理目录 − desired，且保持顺序', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['需求', '缺陷', '外部标签', '退役标签', '人工标签', '目录外'],
        desired: ['缺陷', '已确认'],
        maxPerIssue: 5,
        catalog: [...catalog(), entry('已确认')],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['已确认']);
    expect(plan.remove).toEqual(['需求']);
    // 四种不可管理标签既不删也不加，全部进 skipped（含原因）。
    expect(plan.skipped).toEqual([
      { label: '外部标签', reason: 'missing-meaning' },
      { label: '退役标签', reason: 'retired' },
      { label: '人工标签', reason: 'unmanaged' },
      { label: '目录外', reason: 'not-in-catalog' },
    ]);
  });

  it('meaning 为空 / retired / managed=false / 目录外一律不动（不删不加）', () => {
    const plan = planLabelTargetState(
      baseInput({
        current: ['外部标签', '退役标签', '人工标签', '目录外'],
        desired: ['缺陷'],
      }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['缺陷']);
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toHaveLength(4);
  });

  it('meaning 是纯空白也等价于没填，且 isManageableCatalogEntry 与之一致', () => {
    const blank = entry('空白含义', { meaning: '   ' });
    const plan = planLabelTargetState(
      baseInput({ current: ['空白含义'], desired: ['缺陷'], catalog: [...catalog(), blank] }),
    );
    expect(isManageableCatalogEntry(blank)).toBe(false);
    expect(isManageableCatalogEntry(entry('缺陷'))).toBe(true);
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.remove).toEqual([]);
    expect(plan.skipped).toEqual([{ label: '空白含义', reason: 'missing-meaning' }]);
  });

  it('重复标签名去重后不超限，也不重复写', () => {
    const plan = planLabelTargetState(
      baseInput({ desired: ['缺陷', ' 缺陷 ', '需求', '需求'], maxPerIssue: 2 }),
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.add).toEqual(['缺陷', '需求']);
    expect(plan.remove).toEqual([]);
  });
});

describe('删除归属与审计文案', () => {
  it('deletionOwner：在 botLabels 里是 bot，否则是 human', () => {
    expect(deletionOwner('缺陷', ['缺陷', '需求'])).toBe('bot');
    expect(deletionOwner('人工标签', ['缺陷'])).toBe('human');
    expect(deletionOwner('缺陷', [])).toBe('human');
  });

  it('describeLabelPlan 带上拒绝原因，以及每个删除项的 owner', () => {
    const rejected = planLabelTargetState(baseInput());
    expect(describeLabelPlan(rejected)).toContain('empty-without-clear');

    const ok = planLabelTargetState(baseInput({ current: ['需求', '缺陷'], desired: ['缺陷'] }));
    const text = describeLabelPlan(ok, { 需求: 'bot' });
    expect(text).toContain('需求(bot)');
    expect(text).toContain('不加标签');
  });
});
