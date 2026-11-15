/**
 * 产出契约 v2 的单测（`docs/v21-contract.md` §4 / FR-5.3 / AC-13）。
 *
 * 覆盖的是**判定语义**而不是 zod 的细节：
 *  - 每一类动作各有一份最小正例（少一类就等于契约少讲一类）；
 *  - 未知 `type` / 缺字段 → **整份拒绝**（不是逐条丢弃）；
 *  - `actions` 空数组合法（只判定不动作）；
 *  - `open_pr` 的分支名与 `comment` 的槽位名都是封闭形状。
 */
import { describe, expect, it } from 'vitest';

import {
  ISSUE_READ_TOOL_NAMES,
  MAX_OUTPUT_ACTIONS,
  MAX_TOOL_CALLS_PER_OUTPUT,
  OUTPUT_ACTION_TYPES,
  REACTION_CONTENTS,
  REMOVED_ACTION_TYPES,
  gatedActionOf,
  parseOutputV21Json,
  validateOutputV21,
} from '../src/index.ts';

/** 一份包含**封闭七类里每一类**的产出（顺序即 `OUTPUT_ACTION_TYPES` 的声明顺序）。 */
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

describe('v2 产出契约：动作正例', () => {
  it('全部动作类型齐全时整份通过，且类型顺序与常量一致', () => {
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

describe('FR-5.3：封闭七类之外的写法一律整份拒绝', () => {
  /*
    v2.2 曾为「19 个 issue 工具都要有落点」补了五类动作（reopen_issue / update_issue /
    update_comment / delete_comment / link），动作集合从需求的 7 类涨到 12 类。
    需求 §5.5 的动作全集表只有七行，且明写「动作全集里的七种之一，其他值一律拒绝」，
    所以这里要钉住的是**拒绝**，而不是「这些动作还能用」。

    判定必须整份拒绝（不是跳过那一条）：一份产出里同时有合法的 comment 与被移除的
    update_issue 时，一条都不许执行 —— 否则「执行了一半才发现格式错」正是需求要避免的。
  */
  it('REMOVED_ACTION_TYPES 与 OUTPUT_ACTION_TYPES 不相交，且恰好是那五类', () => {
    expect([...REMOVED_ACTION_TYPES]).toEqual([
      'reopen_issue',
      'update_issue',
      'update_comment',
      'delete_comment',
      'link',
    ]);
    const overlap = REMOVED_ACTION_TYPES.filter((type) =>
      (OUTPUT_ACTION_TYPES as readonly string[]).includes(type),
    );
    expect(overlap).toEqual([]);
  });

  it('封闭集合就是需求表的七类，顺序一致', () => {
    expect([...OUTPUT_ACTION_TYPES]).toEqual([
      'verdict',
      'label',
      'comment',
      'reaction',
      'create_issue',
      'open_pr',
      'close_issue',
    ]);
  });

  it('五类已移除动作逐个被拒，错误写清「已不在封闭集合里」并指到 type', () => {
    for (const type of REMOVED_ACTION_TYPES) {
      const result = validateOutputV21({ actions: [{ type, payload: {} }] });
      expect(result.ok, `${type} 应当被拒`).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]?.path, type).toBe('/actions/0/type');
      expect(result.errors[0]?.message, type).toContain('不在 FR-5.3 的封闭集合里');
      expect(result.errors[0]?.message, type).toContain(type);
    }
  });

  it('合法动作与被移除动作混在一份产出里 → 整份拒绝（一条都不执行）', () => {
    const result = validateOutputV21({
      actions: [
        { type: 'comment', payload: { slot: 'result', body: '好的' } },
        { type: 'update_issue', payload: { title: '偷偷改标题' } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/actions/1/type');
  });

  it('九类里剩下的那两类的合法用法仍旧成立（reply_to / target=comment）', () => {
    // 「收敛集合」不等于「砍掉能力」：回复评论与给评论贴表情都落在 comment / reaction 里。
    expect(
      validateOutputV21({
        actions: [{ type: 'comment', payload: { slot: 'reply-42', body: '已修。', reply_to: 42 } }],
      }).ok,
    ).toBe(true);
    expect(
      validateOutputV21({
        actions: [{ type: 'reaction', payload: { op: 'add', content: 'eyes', target: 'comment', comment_id: 42 } }],
      }).ok,
    ).toBe(true);
  });

  it('关单带原生理由与重复指向', () => {
    const result = validateOutputV21({
      actions: [{ type: 'close_issue', payload: { state_reason: 'duplicate', duplicate_of: 300 } }],
    });
    expect(result.ok).toBe(true);
  });
});

describe('v2.2：跨字段语义校验（整份拒绝，路径精确）', () => {
  it('target=comment 却没给 comment_id → 拒绝并指到字段', () => {
    const result = validateOutputV21({
      actions: [{ type: 'reaction', payload: { op: 'add', content: 'eyes', target: 'comment' } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/actions/0/payload/comment_id');
  });

  it('state_reason=duplicate 却没给 duplicate_of → 拒绝', () => {
    const result = validateOutputV21({
      actions: [{ type: 'close_issue', payload: { state_reason: 'duplicate' } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/actions/0/payload/duplicate_of');
  });
});

describe('项目开关只挂在封闭集合里的那三类上', () => {
  /*
    v2.2 曾为 `link{relation:'duplicate'}` 加过「等价于关单」的旁路判定 —— 那是给
    一个不该存在的动作打补丁。`link` 移出集合后，`gatedActionOf()` 只剩一条判据：
    `type` 在 `GATED_ACTION_TYPES` 里。这比「记得给每个新动作补开关」更难出错。
  */
  it('三类受开关约束，其余返回 null', () => {
    expect(gatedActionOf({ type: 'create_issue' })).toBe('create_issue');
    expect(gatedActionOf({ type: 'open_pr' })).toBe('open_pr');
    expect(gatedActionOf({ type: 'close_issue' })).toBe('close_issue');
    expect(gatedActionOf({ type: 'comment' })).toBeNull();
    expect(gatedActionOf({ type: 'label' })).toBeNull();
    expect(gatedActionOf({ type: 'reaction' })).toBeNull();
    expect(gatedActionOf({ type: 'verdict' })).toBeNull();
  });

  it('已移除的 link 不再被当成关单（它连产出都过不去）', () => {
    expect(gatedActionOf({ type: 'link' })).toBeNull();
  });
});

describe('v2.3：只读工具轮（tool_calls）', () => {
  /*
    只读工具轮是「读类工具真的能用」的唯一通道：模型交 tool_calls，平台执行，
    结果注入下一轮。这几条不变量都必须在契约层成立，不能只靠编排层自律。
  */
  it('单条只读调用合法（actions 为空、无 verdict）', () => {
    const result = validateOutputV21({
      actions: [],
      tool_calls: [{ name: 'IssueCommentsList', input: { number: 331 } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.tool_calls?.[0]?.name).toBe('IssueCommentsList');
  });

  it('带 tool_calls 时不许带 actions（中间轮禁写）', () => {
    const result = validateOutputV21({
      actions: [{ type: 'comment', payload: { slot: 'result', body: '我先说一句。' } }],
      tool_calls: [{ name: 'IssueGet', input: { number: 331 } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/actions');
  });

  it('带 tool_calls 时不许给 verdict（结论留给最终轮）', () => {
    const result = validateOutputV21({
      verdict: 'pass',
      actions: [],
      tool_calls: [{ name: 'IssueGet', input: { number: 331 } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/verdict');
  });

  it('未知工具名 → 拒绝，路径指到 name', () => {
    const result = validateOutputV21({
      actions: [],
      tool_calls: [{ name: 'IssueCommentDeleteAll', input: {} }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toBe('/tool_calls/0/name');
  });

  it('单轮最多 6 条只读调用', () => {
    const calls = Array.from({ length: MAX_TOOL_CALLS_PER_OUTPUT + 1 }, () => ({
      name: 'IssueSearch',
      input: { query: '崩溃' },
    }));
    expect(validateOutputV21({ actions: [], tool_calls: calls }).ok).toBe(false);
    expect(validateOutputV21({ actions: [], tool_calls: calls.slice(1) }).ok).toBe(true);
  });
});

describe('v2.3：五个读工具名的封闭枚举', () => {
  it('ISSUE_READ_TOOL_NAMES 就是那五个读工具（顺序与契约 read 组一致）', () => {
    /*
      契约包（工具面）与信封包（产出面）刻意互不 import，所以两边各有一份名单。
      这条断言是那道闸：任何一侧加了读工具而另一侧没跟上，模型就会写出「契约不认的调用」。
      工具面 ↔ 提示词的对齐由 `apps/server/test/skills-prompt.test.ts` 管。
    */
    expect([...ISSUE_READ_TOOL_NAMES]).toEqual([
      'IssueGet',
      'IssueList',
      'IssueCommentsList',
      'IssueTimeline',
      'IssueSearch',
    ]);
  });
});
