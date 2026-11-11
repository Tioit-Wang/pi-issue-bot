/**
 * 打标归一化（`workflows/normalize.ts`）：纯函数，规则逐条钉死。
 *
 * 为什么值得单独一个文件：这五条规则（映射 / 词表 / 白名单 / 互斥组 / 上限 / 人工否决）
 * 的顺序本身就是语义——顺序错了不会报错，只会「少一个标签」或「多一个标签」，
 * 而那种错误在集成测试里极难看出来。这里把每条规则与**拦截原因**都断言到。
 */
import { describe, expect, it } from 'vitest';

import { humanVetoedFrom, normalizeDesired, toLabelTargets, vocabularyIndex } from '../src/workflows/normalize.ts';
import type { LabelsConfig } from '../../../packages/contract/src/index.ts';
import { parseValidSettings, vocabularyWithRoles } from './helpers/repo-settings.ts';

/** `labels` 段夹具：走合法配置外壳 —— `pipeline.managers` 非空是解析前提（§4.5 / Q4）。 */
const labelsOf = (input: unknown): LabelsConfig => parseValidSettings({ labels: input }).labels;

describe('normalizeDesired：映射与词表', () => {
  it('1:N 展开保持输入顺序，并记下每个标签来自哪个判定键', () => {
    const labels = labelsOf({ map: { bug: 'bug', 'needs-info': ['needs-info', 'triage'] } });
    const result = normalizeDesired({ keys: ['needs-info', 'bug'], labels });

    expect(result.desired).toEqual(['needs-info', 'triage', 'bug']);
    expect(result.sourceKeys).toEqual({ 'needs-info': 'needs-info', triage: 'needs-info', bug: 'bug' });
    expect(result.blocked).toEqual([]);
  });

  it('两个判定键映射到同一个标签时静默去重（不算被拦）', () => {
    const labels = labelsOf({ map: { bug: 'bug', defect: 'bug' } });
    const result = normalizeDesired({ keys: ['bug', 'defect'], labels });

    expect(result.desired).toEqual(['bug']);
    expect(result.blocked).toEqual([]);
    expect(result.sourceKeys['bug']).toBe('bug');
  });

  it('没有映射的判定键 → blocked: unmapped（R4：不发明标签名）', () => {
    const labels = labelsOf({ map: { bug: 'bug' } });
    const result = normalizeDesired({ keys: ['bug', 'performance'], labels });

    expect(result.desired).toEqual(['bug']);
    expect(result.blocked.map((item) => [item.label, item.reason])).toEqual([['performance', 'unmapped']]);
    expect(result.warnings.join('\n')).toContain('labels.map');
  });

  it('词表非空时只允许词表内的名字；词表为空时不限制', () => {
    const withVocab = labelsOf({
      // `role` 自 §4.5 / Q4 起必填：`bug` 按语义归到 `defect`。
      vocabulary: vocabularyWithRoles([{ name: 'bug', meaning: '崩溃' }]),
      map: { bug: 'bug', feature: 'enhancement' },
    });
    const filtered = normalizeDesired({ keys: ['bug', 'feature'], labels: withVocab });
    expect(filtered.desired).toEqual(['bug']);
    expect(filtered.blocked.map((item) => [item.label, item.reason])).toEqual([['enhancement', 'not-in-vocabulary']]);

    const noVocab = labelsOf({ map: { bug: 'bug', feature: 'enhancement' } });
    expect(normalizeDesired({ keys: ['bug', 'feature'], labels: noVocab }).desired).toEqual(['bug', 'enhancement']);
  });

  it('labels.allow 给定时白名单外的映射被拦（防手滑写错标签名）', () => {
    const labels = labelsOf({ map: { bug: 'bug', feature: 'not-allowed' }, allow: ['bug'] });
    const result = normalizeDesired({ keys: ['bug', 'feature'], labels });

    expect(result.desired).toEqual(['bug']);
    expect(result.blocked.map((item) => [item.label, item.reason])).toEqual([['not-allowed', 'not-allowed']]);
  });
});

describe('normalizeDesired：互斥组与上限', () => {
  it('同 group 只留输入顺序第一个，其余记 group-conflict', () => {
    const labels = labelsOf({
      vocabulary: vocabularyWithRoles([
        { name: 'bug', group: 'type' },
        { name: 'feature', group: 'type' },
        { name: 'question', group: 'type' },
      ]),
      map: { bug: 'bug', feature: 'feature', question: 'question' },
    });
    const result = normalizeDesired({ keys: ['bug', 'feature', 'question'], labels });

    expect(result.desired).toEqual(['bug']);
    expect(result.blocked.filter((item) => item.reason === 'group-conflict').map((item) => item.label)).toEqual([
      'feature',
      'question',
    ]);
    expect(result.warnings.join('\n')).toContain('互斥');
  });

  it('max_per_issue 截断（默认 6），被截的记 max-per-issue', () => {
    const labels = labelsOf({
      max_per_issue: 2,
      map: { a: 'a', b: 'b', c: 'c' },
    });
    const result = normalizeDesired({ keys: ['a', 'b', 'c'], labels });

    expect(result.desired).toEqual(['a', 'b']);
    expect(result.blocked.map((item) => [item.label, item.reason])).toEqual([['c', 'max-per-issue']]);
  });

  it('默认上限是 6（契约里的默认值）', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const labels = labelsOf({ map: Object.fromEntries(keys.map((key) => [key, key])) });
    const result = normalizeDesired({ keys, labels });

    expect(result.desired).toHaveLength(6);
    expect(result.blocked).toHaveLength(1);
  });
});

describe('normalizeDesired：人工否决', () => {
  it('人撤下过的标签不再自动加回', () => {
    const labels = labelsOf({ map: { 'needs-info': 'needs-info', bug: 'bug' } });
    const result = normalizeDesired({ keys: ['needs-info', 'bug'], labels, humanVetoed: ['needs-info'] });

    expect(result.desired).toEqual(['bug']);
    expect(result.blocked.map((item) => [item.label, item.reason])).toEqual([['needs-info', 'human-veto']]);
    expect(result.warnings.join('\n')).toContain('人工撤下');
  });

  it('humanVetoedFrom：最后一条是撤标才算否决；之后重打过就不算', () => {
    const vetoed = humanVetoedFrom([
      { label: 'needs-info', appliedAt: new Date('2026-06-01T00:00:00Z'), removedAt: new Date('2026-06-01T01:00:00Z') },
      // 又打了一次（opened_at 更新）→ 不再是否决
      { label: 'bug', appliedAt: new Date('2026-06-01T02:00:00Z'), removedAt: null },
      { label: 'bug', appliedAt: new Date('2026-06-01T00:00:00Z'), removedAt: new Date('2026-06-01T01:00:00Z') },
    ]);

    expect(vetoed).toEqual(['needs-info']);
  });
});

describe('辅助函数', () => {
  it('toLabelTargets 把 string / string[] 归一成数组', () => {
    expect(toLabelTargets(undefined)).toEqual([]);
    expect(toLabelTargets('bug')).toEqual(['bug']);
    expect(toLabelTargets(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('vocabularyIndex：先出现的名字赢（词表里重复声明时不静默覆盖）', () => {
    const index = vocabularyIndex([
      { name: 'bug', role: 'defect', meaning: '第一个' },
      { name: 'bug', role: 'defect', meaning: '第二个' },
    ]);
    expect(index['bug']?.meaning).toBe('第一个');
  });
});
