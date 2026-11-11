/**
 * 阶段结论的读取与校验（`workflows/stage-result.ts`）—— `docs/plan-fixed-pipeline.md` §4.1 / §6。
 *
 * 三条控制面校验各自一组用例：
 *  1. `stage.name` 必须等于任务阶段（否则调用方置 blocked、**零写入**）；
 *  2. `result` 必须在该阶段允许集合内；
 *  3. `defect` 必须有 `path:line` 证据，否则**强制降级 not-found**（正确性校验，不是排版要求）。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyEvidenceScope,
  codeEvidenceOf,
  commentBodyOf,
  readStageResult,
} from '../src/workflows/stage-result.ts';

/** 一个最小的阶段信封（`stage` 由各用例给）。 */
function envelope(stage: unknown, actions: unknown[] = [], evidence: unknown[] = []) {
  return {
    stage,
    verdict: { kind: 'issue', labels: [], evidence },
    actions,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

describe('readStageResult：格式阶段', () => {
  it('pass / fail 都合法', () => {
    const pass = readStageResult(envelope({ name: 'format', result: 'pass' }), 'format');
    expect(pass).toMatchObject({ ok: true, stage: 'format', result: 'pass', downgraded: false });

    const fail = readStageResult(envelope({ name: 'format', result: 'fail' }), 'format');
    expect(fail).toMatchObject({ ok: true, result: 'fail' });
  });

  it('缺少 stage → missing-stage（调用方 blocked，零写入）', () => {
    const read = readStageResult(envelope(undefined), 'format');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('missing-stage');
  });

  it('stage.name 与任务阶段不一致 → stage-mismatch', () => {
    const read = readStageResult(envelope({ name: 'classify', result: 'pass' }), 'format');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('stage-mismatch');
  });

  it('result 不在该阶段允许集合内 → result-not-allowed', () => {
    const read = readStageResult(envelope({ name: 'format', result: 'requirement' }), 'format');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('result-not-allowed');
  });
});

describe('readStageResult：分类阶段与正确性校验', () => {
  it('requirement / other 不需要行号证据', () => {
    for (const result of ['requirement', 'other'] as const) {
      const read = readStageResult(envelope({ name: 'classify', result }), 'classify');
      expect(read).toMatchObject({ ok: true, result, downgraded: false });
    }
  });

  it('defect 有 `path:line` 证据 → 保持 defect', () => {
    const read = readStageResult(
      envelope(
        { name: 'classify', result: 'defect' },
        [],
        [{ rule: 'code:src/app/index.ts', quote: 'src/app/index.ts:42 这里少判了空值', passed: false }],
      ),
      'classify',
    );
    expect(read).toMatchObject({ ok: true, result: 'defect', downgraded: false });
  });

  it('defect 没有行号证据 → 强制降级 not-found 且标记 downgraded', () => {
    const read = readStageResult(
      envelope({ name: 'classify', result: 'defect' }, [], [
        { rule: 'code:src/a.ts', quote: '这里写得不太对' },
      ]),
      'classify',
    );
    expect(read).toMatchObject({ ok: true, result: 'not-found', downgraded: true });
    if (read.ok) expect(read.detail).toContain('降级为 not-found');
  });

  it('defect 的 `rule` 不是 code: 前缀 → 同样降级（证据必须指到代码）', () => {
    const read = readStageResult(
      envelope({ name: 'classify', result: 'defect' }, [], [
        { rule: 'checked:src/a.ts', quote: 'src/a.ts:12' },
      ]),
      'classify',
    );
    expect(read).toMatchObject({ result: 'not-found', downgraded: true });
  });

  it('not-found 原样通过（虚拟缺陷路径）', () => {
    const read = readStageResult(
      envelope({ name: 'classify', result: 'not-found' }, [], [
        { rule: 'checked:src/**', quote: '没有找到对应的实现' },
      ]),
      'classify',
    );
    expect(read).toMatchObject({ ok: true, result: 'not-found', downgraded: false });
    if (read.ok) expect(read.checkedScope).toHaveLength(1);
  });
});

describe('证据与评论的投影', () => {
  it('classifyEvidenceScope 只挑 `checked:` 开头的条目（面板的「已查范围」）', () => {
    const scope = classifyEvidenceScope([
      { rule: 'code:src/a.ts', quote: 'src/a.ts:1' },
      { rule: 'checked:packages/x', quote: '搜过 package 名' },
      { rule: 'checked:docs', quote: '看过文档' },
    ]);
    expect(scope.map((item) => item.rule)).toEqual(['checked:packages/x', 'checked:docs']);
  });

  it('codeEvidenceOf 要求 rule=code:* 且 quote 形如 path:line', () => {
    expect(
      codeEvidenceOf([
        { rule: 'code:src/a.ts', quote: './src/a.ts:10' },
        { rule: 'code:src/a.ts', quote: '第 10 行' },
        { rule: 'other', quote: 'src/a.ts:10' },
      ]),
    ).toHaveLength(1);
  });

  it('commentBodyOf 取第一条非空 comment', () => {
    expect(
      commentBodyOf({
        actions: [
          { intent: 'comment', body: '   ' },
          { intent: 'comment', body: '请补充复现步骤' },
        ],
      }),
    ).toBe('请补充复现步骤');
    expect(commentBodyOf({ actions: [] })).toBeNull();
  });
});
