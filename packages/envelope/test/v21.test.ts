/**
 * 产出契约 v2 的单测（`docs/v21-contract.md` §4 / FR-5.3 / AC-13）。
 *
 * 覆盖的是**判定语义**而不是 zod 的细节：
 *  - 七类动作各有一份最小正例（少一类就等于契约少讲一类）；
 *  - 未知 `type` / 缺字段 → **整份拒绝**（不是逐条丢弃）；
 *  - `actions` 空数组合法（只判定不动作）；
 *  - `open_pr` 的分支名与 `comment` 的槽位名都是封闭形状。
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_OUTPUT_ACTIONS,
  OUTPUT_ACTION_TYPES,
  REACTION_CONTENTS,
  parseOutputV21Json,
  validateOutputV21,
} from '../src/index.ts';

/** 一份包含七类动作的产出（每类一条，顺序即 §4 的声明顺序）。 */
function fullOutput(): unknown {
  return {
    verdict: 'fail',
    evidence: ['复现步骤缺失'],
    actions: [
      { type: 'verdict', payload: { verdict: 'fail', evidence: ['缺少环境信息'] } },
      { type: 'label', payload: { desired: ['缺陷', '缺少信息'] } },
      { type: 'comment', payload: { slot: 'result', body: '看过这个 issue 了。' } },
      { type: 'reaction', payload: { op: 'add', content: 'eyes' } },
      { type: 'create_issue', payload: { title: '同类问题汇总', fingerprint: 'dup:abc123' } },
      { type: 'open_pr', payload: { branch: 'bot/fix-42', title: '修复 #42' } },
      { type: 'close_issue', payload: {} },
    ],
  };
}

describe('v2 产出契约：七类动作正例', () => {
  it('七类动作齐全时整份通过，且类型顺序与常量一致', () => {
    const result = validateOutputV21(fullOutput());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.output.actions.map((action) => action.type)).toEqual([...OUTPUT_ACTION_TYPES]);
    expect(result.output.verdict).toBe('fail');
  });

  it('只判定不动作：actions 为空数组合法，verdict 可省', () => {
    expect(validateOutputV21({ actions: [] }).ok).toBe(true);
    expect(validateOutputV21({ verdict: 'pass', actions: [] }).ok).toBe(true);
  });

  it('reaction 的 content 限定在 8 种之内', () => {
    for (const content of REACTION_CONTENTS) {
      const result = validateOutputV21({ actions: [{ type: 'reaction', payload: { op: 'add', content } }] });
      expect(result.ok, `content=${content} 应当合法`).toBe(true);
    }
    const bad = validateOutputV21({ actions: [{ type: 'reaction', payload: { op: 'add', content: 'like' } }] });
    expect(bad.ok).toBe(false);
  });

  it('label 允许 clear=true 的空目标集（显式清空）', () => {
    const result = validateOutputV21({
      actions: [{ type: 'label', payload: { desired: [], clear: true } }],
    });
    expect(result.ok).toBe(true);
  });

  it('open_pr 只接受 bot/* 分支', () => {
    const okBranches = ['bot/fix-42', 'bot/a.b_c-1'];
    for (const branch of okBranches) {
      const result = validateOutputV21({ actions: [{ type: 'open_pr', payload: { branch, title: 't' } }] });
      expect(result.ok, `branch=${branch} 应当合法`).toBe(true);
    }
    const badBranches = ['feature/x', 'bot/', 'Bot/fix', 'bot/UPPER', 'refs/heads/bot/x'];
    for (const branch of badBranches) {
      const result = validateOutputV21({ actions: [{ type: 'open_pr', payload: { branch, title: 't' } }] });
      expect(result.ok, `branch=${branch} 应当被拒`).toBe(false);
    }
  });

  it('comment 的槽位名是封闭形状（小写 + 数字 + ._-，≤64）', () => {
    const okSlots = ['result', 'a', 'summary.v2', 'x_1-2'];
    for (const slot of okSlots) {
      const result = validateOutputV21({ actions: [{ type: 'comment', payload: { slot, body: '正文' } }] });
      expect(result.ok, `slot=${slot} 应当合法`).toBe(true);
    }
    const badSlots = ['', 'Result', '-lead', 'a b', 'x'.repeat(65)];
    for (const slot of badSlots) {
      const result = validateOutputV21({ actions: [{ type: 'comment', payload: { slot, body: '正文' } }] });
      expect(result.ok, `slot=${JSON.stringify(slot)} 应当被拒`).toBe(false);
    }
  });
});

describe('v2 产出契约：整份拒绝', () => {
  it('未知 type → 整份拒绝，错误定位到 /actions/<i>/type', () => {
    const result = validateOutputV21({
      actions: [
        { type: 'comment', payload: { slot: 'result', body: '好的' } },
        { type: 'merge_pr', payload: {} },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.path).toBe('/actions/1/type');
    expect(result.errors[0]?.message).toContain('merge_pr');
  });

  it('缺必填字段 → 整份拒绝，错误定位到字段路径', () => {
    const result = validateOutputV21({
      actions: [
        { type: 'comment', payload: { slot: 'result', body: '好的' } },
        { type: 'comment', payload: { slot: 'result' } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((issue) => issue.path.startsWith('/actions/1/payload'))).toBe(true);
  });

  it('顶层缺 actions → 拒绝（actions 是必填）', () => {
    const result = validateOutputV21({ verdict: 'pass' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.some((issue) => issue.path === '/actions')).toBe(true);
  });

  it('多出来的字段同样拒绝（strict object）', () => {
    const result = validateOutputV21({
      actions: [{ type: 'close_issue', payload: {}, reason: 'done' }],
    });
    expect(result.ok).toBe(false);
  });

  it('动作数超过 20 条 → 拒绝', () => {
    const actions = Array.from({ length: MAX_OUTPUT_ACTIONS + 1 }, () => ({
      type: 'reaction',
      payload: { op: 'add', content: 'eyes' },
    }));
    expect(validateOutputV21({ actions }).ok).toBe(false);
  });

  it('create_issue 的指纹形状不合规 → 拒绝', () => {
    const result = validateOutputV21({
      actions: [{ type: 'create_issue', payload: { title: 't', fingerprint: 'AB' } }],
    });
    expect(result.ok).toBe(false);
  });

  it('非对象的产出（数组 / null / 字符串）一律拒绝', () => {
    for (const value of [[], null, 'output', 42]) {
      expect(validateOutputV21(value).ok).toBe(false);
    }
  });
});

describe('parseOutputV21Json：语法错误与形状错误同一个返回形状', () => {
  it('合法 JSON 文本通过', () => {
    const result = parseOutputV21Json(JSON.stringify(fullOutput()));
    expect(result.ok).toBe(true);
  });

  it('JSON 语法错误的路径固定是 /', () => {
    const result = parseOutputV21Json('{"actions": [}');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.path).toBe('/');
    expect(result.errors[0]?.message).toContain('JSON');
  });
});
