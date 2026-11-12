/**
 * `writeback/v21/execute.ts` 的单测（`docs/v21-contract.md` §4 校验第 4/5 条 + §5 / AC-13、AC-16）。
 *
 * 端口是纯依赖注入，所以这里不发任何真实请求：假端口记下**每个方法名**，
 * 断言「零写」「没有执行后续动作」才有可观测的证据（而不是只看 ok 字段）。
 *
 * 四个必须钉死的语义：
 *  1. 顺序执行、遇失败即停，`stoppedAt` 是中断下标；
 *  2. 后三类开关关闭 → **执行前**整份拒绝，连第一条允许的动作都不跑；
 *  3. dry-run 零写方法调用，但仍逐条给出计划；
 *  4. `close_issue` 只在顶层 `verdict='fail'` 时执行。
 */
import { describe, expect, it } from 'vitest';

import type { OutputV21 } from '../../../packages/envelope/src/index.ts';
import { validateOutputV21 } from '../../../packages/envelope/src/index.ts';
import type { SlotComment } from '../src/writeback/v21/comments.ts';
import { buildSlotMarker } from '../src/writeback/v21/comments.ts';
import type { ExecuteV21Input, V21GithubPort, V21ReactionEntry } from '../src/writeback/v21/execute.ts';
import { executeV21 } from '../src/writeback/v21/execute.ts';

/** 所有有副作用的方法（列表/reaction 查询是 GET，不算写）。 */
const WRITE_METHODS: readonly string[] = [
  'createIssueComment',
  'updateIssueComment',
  'addLabels',
  'removeLabel',
  'createIssue',
  'closeIssue',
  'openPullRequest',
  'addReaction',
  'removeReaction',
];

type FakePort = {
  readonly port: V21GithubPort;
  readonly calls: string[];
};

/** 假端口：记方法名；`failMethod` 让指定方法一调用就抛（模拟 GitHub 写失败）。 */
function createFakePort(
  options: {
    readonly comments?: readonly SlotComment[];
    readonly reactions?: readonly V21ReactionEntry[];
    readonly failMethod?: string | undefined;
    readonly notFoundOnUpdate?: boolean | undefined;
  } = {},
): FakePort {
  const calls: string[] = [];
  const record = (method: string): void => {
    calls.push(method);
    if (options.failMethod === method) {
      throw new Error(`模拟写失败：${method}`);
    }
  };

  const port: V21GithubPort = {
    listIssueComments: async () => {
      calls.push('listIssueComments');
      return [...(options.comments ?? [])];
    },
    createIssueComment: async () => {
      record('createIssueComment');
      return { id: 1001 };
    },
    updateIssueComment: async (input) => {
      calls.push('updateIssueComment');
      if (options.notFoundOnUpdate === true) {
        // 槽位写回要能认出「原评论被人删了」这种 404 并重建。
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (options.failMethod === 'updateIssueComment') {
        throw new Error('模拟写失败：updateIssueComment');
      }
      return { id: input.commentId };
    },
    addLabels: async () => {
      record('addLabels');
    },
    removeLabel: async () => {
      record('removeLabel');
    },
    createIssue: async () => {
      record('createIssue');
      return { number: 77 };
    },
    closeIssue: async () => {
      record('closeIssue');
    },
    openPullRequest: async () => {
      record('openPullRequest');
      return { number: 88 };
    },
    listReactions: async () => {
      calls.push('listReactions');
      return [...(options.reactions ?? [])];
    },
    addReaction: async () => {
      record('addReaction');
      return { id: 9 };
    },
    removeReaction: async () => {
      record('removeReaction');
    },
    isOwn: (login) => login === 'pi-bot[bot]',
  };
  return { port, calls };
}

/** 用真实校验器过一遍夹具：测试里的产出形状与线上完全一致（不靠 `as any`）。 */
function outputOf(value: unknown): OutputV21 {
  const result = validateOutputV21(value);
  if (!result.ok) {
    throw new Error(
      `测试夹具产出不合规：${result.errors.map((error) => `${error.path} ${error.message}`).join('; ')}`,
    );
  }
  return result.output;
}

function baseInput(port: V21GithubPort, overrides: Partial<ExecuteV21Input> = {}): ExecuteV21Input {
  return {
    output: outputOf({ actions: [] }),
    repo: 'acme/widgets',
    issueNumber: 42,
    dryRun: false,
    actionsEnabled: { create_issue: true, open_pr: true, close_issue: true },
    currentLabels: [],
    botLabels: [],
    catalog: [],
    maxPerIssue: 8,
    api: port,
    ...overrides,
  };
}

/** 一份覆盖六类动作（除 verdict 动作外）的产出，后面几个用例共用。 */
function richOutput(): OutputV21 {
  return outputOf({
    verdict: 'fail',
    actions: [
      { type: 'label', payload: { desired: ['缺陷'] } },
      { type: 'comment', payload: { slot: 'result', body: '结论正文' } },
      { type: 'reaction', payload: { op: 'add', content: 'eyes' } },
      { type: 'create_issue', payload: { title: '同类问题汇总', fingerprint: 'dup:abc123' } },
      { type: 'open_pr', payload: { branch: 'bot/fix-42', title: '修复 #42' } },
      { type: 'close_issue', payload: {} },
    ],
  });
}

const managedCatalog = [{ name: '缺陷', meaning: '确认过的缺陷', managed: true, status: 'active' }] as const;

describe('顺序执行：遇失败即停', () => {
  it('第 2 条写失败 → 后续不执行，stoppedAt=1，已成功的第一条不回滚', async () => {
    const { port, calls } = createFakePort({ failMethod: 'createIssueComment' });
    const output = outputOf({
      actions: [
        { type: 'verdict', payload: { verdict: 'pass' } },
        { type: 'comment', payload: { slot: 'result', body: '结论' } },
        { type: 'reaction', payload: { op: 'add', content: 'eyes' } },
      ],
    });

    const result = await executeV21(baseInput(port, { output }));

    expect(result.ok).toBe(false);
    expect(result.executed.map((row) => [row.index, row.outcome])).toEqual([
      [0, 'ok'],
      [1, 'failed'],
    ]);
    expect(result.stoppedAt).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(result.errors[0]?.type).toBe('comment');
    expect(calls).not.toContain('addReaction');
  });

  it('全部成功时 stoppedAt=null 且 errors 为空', async () => {
    const { port } = createFakePort();
    const output = outputOf({
      actions: [
        { type: 'verdict', payload: { verdict: 'pass' } },
        { type: 'comment', payload: { slot: 'result', body: '结论' } },
      ],
    });
    const result = await executeV21(baseInput(port, { output }));
    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.executed).toHaveLength(2);
  });
});

describe('后三类动作开关：执行前整份拒绝', () => {
  it('三个开关全关 → 一条都不执行（含前面的普通 comment），错误全是 action-disabled', async () => {
    const { port, calls } = createFakePort();
    const output = outputOf({
      verdict: 'fail',
      actions: [
        { type: 'comment', payload: { slot: 'result', body: '会写吗' } },
        { type: 'open_pr', payload: { branch: 'bot/fix-42', title: '修复' } },
        { type: 'create_issue', payload: { title: '汇总' } },
        { type: 'close_issue', payload: {} },
      ],
    });

    const result = await executeV21(
      baseInput(port, {
        output,
        actionsEnabled: { create_issue: false, open_pr: false, close_issue: false },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.executed).toEqual([]);
    expect(result.stoppedAt).toBeNull();
    expect(result.errors.map((error) => error.index)).toEqual([1, 2, 3]);
    for (const error of result.errors) {
      expect(error.message).toContain('action-disabled');
    }
    // 连一次 GET 都不该发生：这是「执行前」而不是「执行到第 N 条才拒绝」。
    expect(calls).toEqual([]);
  });

  it('只关一个开关，前面的允许动作也照样整份拒绝', async () => {
    const { port, calls } = createFakePort();
    const output = outputOf({
      actions: [
        { type: 'verdict', payload: { verdict: 'pass' } },
        { type: 'create_issue', payload: { title: '汇总' } },
      ],
    });

    const result = await executeV21(
      baseInput(port, { output, actionsEnabled: { create_issue: false, open_pr: true, close_issue: true } }),
    );

    expect(result.ok).toBe(false);
    expect(result.executed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.index).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('dry-run：零写调用但仍产出计划', () => {
  it('六类动作各出一条 dry-run 计划，且没有任何写方法被调用', async () => {
    const { port, calls } = createFakePort();

    const result = await executeV21(
      baseInput(port, {
        output: richOutput(),
        dryRun: true,
        catalog: managedCatalog,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.executed).toHaveLength(6);
    for (const row of result.executed) {
      expect(row.outcome).toBe('ok');
      expect(row.detail?.startsWith('dry-run')).toBe(true);
    }
    expect(calls.filter((method) => WRITE_METHODS.includes(method))).toEqual([]);
  });

  it('同一份产出关掉 dry-run 后确实会写（证明上面的零写断言不是空断言）', async () => {
    const { port, calls } = createFakePort();

    const result = await executeV21(
      baseInput(port, { output: richOutput(), catalog: managedCatalog }),
    );

    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBeNull();
    for (const method of ['addLabels', 'createIssueComment', 'addReaction', 'createIssue', 'openPullRequest', 'closeIssue']) {
      expect(calls, `应当调用 ${method}`).toContain(method);
    }
  });
});

describe('close_issue：不采信模型自评', () => {
  it('verdict=pass → 失败 close-without-fail，且不调用 closeIssue', async () => {
    const { port, calls } = createFakePort();
    const output = outputOf({
      verdict: 'pass',
      actions: [{ type: 'close_issue', payload: {} }],
    });

    const result = await executeV21(baseInput(port, { output }));

    expect(result.ok).toBe(false);
    expect(result.stoppedAt).toBe(0);
    expect(result.errors[0]?.message).toContain('close-without-fail');
    expect(calls).not.toContain('closeIssue');
  });

  it('verdict 缺省 → 同样失败', async () => {
    const { port, calls } = createFakePort();
    const output = outputOf({ actions: [{ type: 'close_issue', payload: {} }] });

    const result = await executeV21(baseInput(port, { output }));

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('close-without-fail');
    expect(calls).not.toContain('closeIssue');
  });

  it('verdict=fail → 允许执行，closeIssue 收到 not_planned', async () => {
    const { port, calls } = createFakePort();
    const output = outputOf({
      verdict: 'fail',
      actions: [{ type: 'close_issue', payload: {} }],
    });

    const result = await executeV21(baseInput(port, { output }));

    expect(result.ok).toBe(true);
    expect(result.stoppedAt).toBeNull();
    expect(calls).toContain('closeIssue');
  });
});

describe('其余分支：槽位、去重闸门、reaction 归属', () => {
  it('槽位已存在 → 覆盖（updateIssueComment），不新建评论', async () => {
    const marker = buildSlotMarker({ repo: 'acme/widgets', issueNumber: 42, slot: 'result' });
    const { port, calls } = createFakePort({ comments: [{ id: 55, body: `旧结论\n\n${marker}` }] });
    const output = outputOf({
      actions: [{ type: 'comment', payload: { slot: 'result', body: '新结论' } }],
    });

    const result = await executeV21(baseInput(port, { output }));

    expect(result.ok).toBe(true);
    expect(calls).toContain('updateIssueComment');
    expect(calls).not.toContain('createIssueComment');
  });

  it('原评论被删（404）→ 重建一条，不算失败', async () => {
    const { port, calls } = createFakePort({ notFoundOnUpdate: true });
    const output = outputOf({
      actions: [{ type: 'comment', payload: { slot: 'result', body: '新结论' } }],
    });
    const slotStore = {
      get: async () => 55,
      put: async () => undefined,
      delete: async () => undefined,
    };

    const result = await executeV21(baseInput(port, { output, slotStore }));

    expect(result.ok).toBe(true);
    expect(calls).toContain('updateIssueComment');
    expect(calls).toContain('createIssueComment');
    expect(result.executed[0]?.detail).toContain('重建');
  });

  it('create_issue：duplicate 跳过创建，quota 失败并中断', async () => {
    const duplicatePort = createFakePort();
    const output = outputOf({
      actions: [{ type: 'create_issue', payload: { title: '汇总', fingerprint: 'dup:abc123' } }],
    });
    const duplicate = await executeV21(
      baseInput(duplicatePort.port, { output, createIssueGuard: async () => 'duplicate' }),
    );
    expect(duplicate.ok).toBe(true);
    expect(duplicatePort.calls).not.toContain('createIssue');

    const quotaPort = createFakePort();
    const quota = await executeV21(baseInput(quotaPort.port, { output, createIssueGuard: async () => 'quota' }));
    expect(quota.ok).toBe(false);
    expect(quota.stoppedAt).toBe(0);
    expect(quota.errors[0]?.message).toContain('create-issue-quota');
    expect(quotaPort.calls).not.toContain('createIssue');
  });

  it('reaction remove 只删自己打的；没有自己的就失败', async () => {
    const reactions: readonly V21ReactionEntry[] = [
      { id: 1, content: 'eyes', userLogin: 'someone' },
      { id: 2, content: 'eyes', userLogin: 'pi-bot[bot]' },
    ];
    const withOwn = createFakePort({ reactions });
    const output = outputOf({
      actions: [{ type: 'reaction', payload: { op: 'remove', content: 'eyes' } }],
    });
    const result = await executeV21(baseInput(withOwn.port, { output }));
    expect(result.ok).toBe(true);
    expect(withOwn.calls.filter((method) => method === 'removeReaction')).toHaveLength(1);

    const noOwn = createFakePort({ reactions: [reactions[0]!] });
    const failed = await executeV21(baseInput(noOwn.port, { output }));
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]?.message).toContain('reaction-not-found');
    expect(noOwn.calls).not.toContain('removeReaction');
  });
});
