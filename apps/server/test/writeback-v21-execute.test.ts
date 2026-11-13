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
  /**
   * 每次调用的**入参**（方法名 + input）：`link` 的四种 relation 之间只差
   * 「调了哪个方法、传了什么」，reaction 的评论级目标也一样。
   */
  readonly records: { readonly method: string; readonly input: Record<string, unknown> }[];
};

/** 假端口：记方法名；`failMethod` 让指定方法一调用就抛（模拟 GitHub 写失败）。 */
function createFakePort(
  options: {
    readonly comments?: readonly SlotComment[];
    readonly reactions?: readonly V21ReactionEntry[];
    readonly failMethod?: string | undefined;
    readonly notFoundOnUpdate?: boolean | undefined;
    /** `getIssueComment` 返回的作者（判 `update_comment` / `delete_comment` 的归属）。 */
    readonly commentAuthor?: string | null | undefined;
    /** `getIssueComment` 返回的原正文（`reply_to` 的引用块来源）。 */
    readonly commentBody?: string | null | undefined;
    /** `getIssueUpdatedAt` 返回的当前 `updated_at`（乐观锁用例）。 */
    readonly issueUpdatedAt?: string | undefined;
    /** 存在的 issue 编号；给了就按它判 `issueExists`，不给 = 一律存在。 */
    readonly existingIssueNumbers?: readonly number[] | undefined;
  } = {},
): FakePort {
  const calls: string[] = [];
  const records: { readonly method: string; readonly input: Record<string, unknown> }[] = [];
  const record = (method: string, input?: object): void => {
    if (input !== undefined) {
      records.push({ method, input: { ...input } });
    }
    calls.push(method);
    if (options.failMethod === method) {
      throw new Error(`模拟写失败：${method}`);
    }
  };
  /** issue 编辑面的统一记录（方法与入参都进 `records`，方法名进 `calls`）。 */
  const recordEdit = (method: string, input: object): void => {
    record(method, input);
  };

  const port: V21GithubPort = {
    listIssueComments: async () => {
      calls.push('listIssueComments');
      return [...(options.comments ?? [])];
    },
    createIssueComment: async (input) => {
      record('createIssueComment', input);
      return { id: 1001 };
    },
    updateIssueComment: async (input) => {
      records.push({ method: 'updateIssueComment', input: { ...input } });
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
    listReactions: async (input) => {
      record('listReactions', input);
      return [...(options.reactions ?? [])];
    },
    addReaction: async (input) => {
      record('addReaction', input);
      return { id: 9 };
    },
    removeReaction: async () => {
      record('removeReaction');
    },
    issueEdit: {
      updateIssue: async (input) => {
        recordEdit('updateIssue', input);
        return { updatedAt: '2026-05-02T00:00:00Z' };
      },
      getIssueUpdatedAt: async (input) => {
        recordEdit('getIssueUpdatedAt', input);
        return options.issueUpdatedAt ?? '2026-05-01T00:00:00Z';
      },
      reopenIssue: async (input) => {
        recordEdit('reopenIssue', input);
      },
      closeIssueWithReason: async (input) => {
        recordEdit('closeIssueWithReason', input);
        // 既有断言用 `closeIssue` 这个名字表示「关闭了 issue」这个写行为；
        // v2.2 的关闭走 `closeIssueWithReason`（同一个 PATCH + 可选 state_reason），
        // 所以两个名字都记，既有用例的断言不必改。
        calls.push('closeIssue');
      },
      getIssueComment: async (input) => {
        recordEdit('getIssueComment', input);
        return {
          id: input.commentId,
          authorLogin: options.commentAuthor === undefined ? 'pi-bot[bot]' : options.commentAuthor,
          body: options.commentBody === undefined ? '原来的评论正文' : options.commentBody,
        };
      },
      deleteIssueComment: async (input) => {
        recordEdit('deleteIssueComment', input);
      },
      getIssueId: async (input) => {
        recordEdit('getIssueId', input);
        return 1000 + input.issueNumber;
      },
      issueExists: async (input) => {
        recordEdit('issueExists', input);
        return options.existingIssueNumbers === undefined
          ? true
          : options.existingIssueNumbers.includes(input.issueNumber);
      },
      addBlockedBy: async (input) => {
        recordEdit('addBlockedBy', input);
      },
      addSubIssue: async (input) => {
        recordEdit('addSubIssue', input);
      },
    },
    isOwn: (login) => login === 'pi-bot[bot]',
  };
  return { port, calls, records };
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

/* ── v2.2 写类工具：动作 →「调了哪个端口方法、传了什么」────────────────────── */

/** 取某方法的全部入参记录。 */
function inputsOf(records: FakePort['records'], method: string): Record<string, unknown>[] {
  return records.filter((row) => row.method === method).map((row) => row.input);
}

describe('reaction：评论级目标', () => {
  it('target=comment + comment_id → 端口收到 commentId；只给 comment_id 也按评论级处理', async () => {
    const withTarget = createFakePort();
    const ok = await executeV21(
      baseInput(withTarget.port, {
        output: outputOf({
          actions: [
            { type: 'reaction', payload: { op: 'add', content: 'eyes', target: 'comment', comment_id: 555 } },
          ],
        }),
      }),
    );
    expect(ok.ok).toBe(true);
    expect(inputsOf(withTarget.records, 'addReaction')[0]?.['commentId']).toBe(555);

    const idOnly = createFakePort();
    await executeV21(
      baseInput(idOnly.port, {
        output: outputOf({ actions: [{ type: 'reaction', payload: { op: 'add', content: 'eyes', comment_id: 556 } }] }),
      }),
    );
    expect(inputsOf(idOnly.records, 'addReaction')[0]?.['commentId']).toBe(556);
  });

  it('没给目标时仍然打主贴（不带 commentId，老产出语义不变）', async () => {
    const fake = createFakePort();
    await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'reaction', payload: { op: 'add', content: 'eyes' } }] }),
      }),
    );
    expect(inputsOf(fake.records, 'addReaction')[0]?.['commentId']).toBeUndefined();
  });
});

describe('comment：reply_to 渲染 + 提及中和', () => {
  it('reply_to → 读原评论、逐行引用并只 @ 原评论作者', async () => {
    const fake = createFakePort({ commentAuthor: 'alice', commentBody: '第一行\n第二行' });
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          actions: [
            { type: 'comment', payload: { slot: 'result', body: '@alice 和 @bob 都看一下', reply_to: 777 } },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'getIssueComment')[0]?.['commentId']).toBe(777);
    const body = String(inputsOf(fake.records, 'createIssueComment')[0]?.['body'] ?? '');
    expect(body).toContain('> **@alice** wrote:');
    expect(body).toContain('> 第一行');
    expect(body).toContain('> 第二行');
    // 允许清单 = 装配层给的 + 被回复评论的作者：原评论作者保持可 @。
    expect(body).toContain('@alice 和');
    // 不在允许清单里的提要被插零宽空格（人看不到，GitHub 不再渲染成提及）。
    expect(body).not.toContain('@bob');
    expect(body).toContain('@\u200bbob');
    expect(result.executed[0]?.detail).toContain('已中和');
  });

  it('allowedMentions 里的 login 不被中和', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        allowedMentions: ['bob'],
        output: outputOf({
          actions: [{ type: 'comment', payload: { slot: 'result', body: '你好 @bob，@carol 也看下' } }],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    const body = String(inputsOf(fake.records, 'createIssueComment')[0]?.['body'] ?? '');
    expect(body).toContain('@bob');
    expect(body).toContain('@\u200bcarol');
  });
});

describe('正文里的 issue 引用校验', () => {
  it('引用本仓库不存在的编号 → ref-not-found 且整条失败（不写评论）', async () => {
    const fake = createFakePort({ existingIssueNumbers: [42, 7] });
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'comment', payload: { slot: 'result', body: '参见 #999' } }] }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('ref-not-found');
    expect(fake.calls).not.toContain('createIssueComment');
  });

  it('指向其它仓库的引用跳过校验；超过 maxRefsPerBody 直接失败', async () => {
    const other = createFakePort({ existingIssueNumbers: [] });
    const ok = await executeV21(
      baseInput(other.port, {
        output: outputOf({
          actions: [{ type: 'comment', payload: { slot: 'result', body: '参见 other/repo#999' } }],
        }),
      }),
    );
    expect(ok.ok).toBe(true);
    expect(inputsOf(other.records, 'issueExists')).toEqual([]);

    const many = createFakePort();
    const failed = await executeV21(
      baseInput(many.port, {
        output: outputOf({
          actions: [{ type: 'comment', payload: { slot: 'result', body: '#1 #2 #3 #4 #5 #6' } }],
        }),
      }),
    );
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]?.message).toContain('too-many-refs');
  });

  it('dry-run 不发 issueExists（预演不产生调用）', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        dryRun: true,
        output: outputOf({ actions: [{ type: 'comment', payload: { slot: 'result', body: '参见 #777' } }] }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'issueExists')).toEqual([]);
  });
});

describe('close_issue：state_reason 与附带说明', () => {
  it('state_reason=duplicate + duplicate_of → closeIssueWithReason(duplicate)，且不额外发关联评论', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          verdict: 'fail',
          actions: [
            { type: 'close_issue', payload: { state_reason: 'duplicate', duplicate_of: 41, comment: '与 #41 重复' } },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'closeIssueWithReason')[0]).toMatchObject({
      reason: 'duplicate',
      duplicateOf: 41,
    });
    // 说明评论由 GitHub 层（`buildLinkNote`）发，执行器只写 close 槽位那一条。
    const created = inputsOf(fake.records, 'createIssueComment');
    expect(created).toHaveLength(1);
    expect(String(created[0]?.['body'])).not.toContain('pi-bot:link');
    expect(result.executed[0]?.detail).toContain('duplicate_of=#41');
  });

  it('缺省 reason 仍然是 not_planned（v2.0 语义不变）', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({ verdict: 'fail', actions: [{ type: 'close_issue', payload: {} }] }),
      }),
    );
    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'closeIssueWithReason')[0]).toMatchObject({ reason: 'not_planned' });
    expect(inputsOf(fake.records, 'closeIssueWithReason')[0]?.['duplicateOf']).toBeUndefined();
  });
});

describe('reopen_issue / update_issue', () => {
  it('reopen_issue → 调 reopenIssue（当前 issue）', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, { output: outputOf({ actions: [{ type: 'reopen_issue', payload: {} }] }) }),
    );
    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'reopenIssue')[0]).toMatchObject({ repo: 'acme/widgets', issueNumber: 42 });
  });

  it('expected_updated_at 不匹配 → update-conflict，且不调 updateIssue', async () => {
    const fake = createFakePort({ issueUpdatedAt: '2026-06-01T00:00:00Z' });
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          actions: [
            { type: 'update_issue', payload: { title: '新标题', expected_updated_at: '2026-01-01T00:00:00Z' } },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('update-conflict');
    expect(inputsOf(fake.records, 'updateIssue')).toEqual([]);
  });

  it('乐观锁匹配 → updateIssue 只带给了的字段', async () => {
    const fake = createFakePort({ issueUpdatedAt: '2026-06-01T00:00:00Z' });
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          actions: [
            {
              type: 'update_issue',
              payload: { title: '新标题', expected_updated_at: '2026-06-01T00:00:00Z' },
            },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    const input = inputsOf(fake.records, 'updateIssue')[0];
    expect(input).toMatchObject({ repo: 'acme/widgets', issueNumber: 42, title: '新标题' });
    // 没给的字段不该出现（否则 PATCH 会拿 undefined 覆盖掉别人的改动）。
    expect(input === undefined ? null : Object.keys(input).sort()).toEqual(['issueNumber', 'repo', 'title']);
    expect(result.executed[0]?.detail).toContain('title');
  });
});

describe('update_comment / delete_comment：只动自己写的', () => {
  it('别人的评论 → comment-not-own，且一个写方法都不调', async () => {
    const fake = createFakePort({ commentAuthor: 'mallory' });
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          actions: [{ type: 'update_comment', payload: { comment_id: 900, body: '改一下' } }],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('comment-not-own');
    expect(fake.calls).not.toContain('updateIssueComment');

    const del = createFakePort({ commentAuthor: 'mallory' });
    const deleted = await executeV21(
      baseInput(del.port, {
        output: outputOf({ actions: [{ type: 'delete_comment', payload: { comment_id: 900 } }] }),
      }),
    );
    expect(deleted.ok).toBe(false);
    expect(deleted.errors[0]?.message).toContain('comment-not-own');
    expect(inputsOf(del.records, 'deleteIssueComment')).toEqual([]);
  });

  it('自己的评论 → 改写走 updateIssueComment、删除走 deleteIssueComment', async () => {
    const fake = createFakePort();
    const updated = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          actions: [{ type: 'update_comment', payload: { comment_id: 900, body: '改一下' } }],
        }),
      }),
    );
    expect(updated.ok).toBe(true);
    expect(inputsOf(fake.records, 'updateIssueComment')[0]).toMatchObject({ commentId: 900, body: '改一下' });

    const del = createFakePort();
    const deleted = await executeV21(
      baseInput(del.port, {
        output: outputOf({ actions: [{ type: 'delete_comment', payload: { comment_id: 901 } }] }),
      }),
    );
    expect(deleted.ok).toBe(true);
    expect(inputsOf(del.records, 'deleteIssueComment')[0]).toMatchObject({ commentId: 901 });
  });
});

describe('link：四种 relation 的端口映射', () => {
  it('relates → 一条带标记的关联评论', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'relates', target_number: 41 } }] }),
      }),
    );

    expect(result.ok).toBe(true);
    const body = String(inputsOf(fake.records, 'createIssueComment')[0]?.['body'] ?? '');
    expect(body).toContain('#41');
    expect(body).toContain('pi-bot:link relates');
  });

  it('duplicate → closeIssueWithReason(duplicate_of)，且不额外发关联评论', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        // `duplicate` 等价于关单，所以它和 `close_issue` 共用同一条前置条件（verdict=fail）。
        output: outputOf({
          verdict: 'fail',
          actions: [{ type: 'link', payload: { relation: 'duplicate', target_number: 41 } }],
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(inputsOf(fake.records, 'closeIssueWithReason')[0]).toMatchObject({
      reason: 'duplicate',
      duplicateOf: 41,
    });
    // 说明评论由 GitHub 层发；执行器再发一条就等于同一个关系出现两次。
    expect(inputsOf(fake.records, 'createIssueComment')).toEqual([]);
  });

  it('duplicate 在 verdict 不是 fail 时整条拒绝（不留「换个动作名关单」的后门）', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        output: outputOf({
          verdict: 'pass',
          actions: [{ type: 'link', payload: { relation: 'duplicate', target_number: 41 } }],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(inputsOf(fake.records, 'closeIssueWithReason')).toEqual([]);
    expect(result.errors[0]?.message).toContain('close-without-fail');
  });

  it('blocked_by → addBlockedBy(当前 issue, target 的 id)', async () => {
    const fake = createFakePort();
    await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'blocked_by', target_number: 41 } }] }),
      }),
    );
    expect(inputsOf(fake.records, 'addBlockedBy')[0]).toMatchObject({
      issueNumber: 42,
      blockedByIssueId: 1041,
    });
  });

  it('blocks → 语义反过来：addBlockedBy(target, 当前 issue 的 id)', async () => {
    const fake = createFakePort();
    await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'blocks', target_number: 41 } }] }),
      }),
    );
    expect(inputsOf(fake.records, 'addBlockedBy')[0]).toMatchObject({
      issueNumber: 41,
      blockedByIssueId: 1042,
    });
  });

  it('parent → addSubIssue(parent=target, sub=当前 issue 的 id)', async () => {
    const fake = createFakePort();
    await executeV21(
      baseInput(fake.port, {
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'parent', target_number: 41 } }] }),
      }),
    );
    expect(inputsOf(fake.records, 'addSubIssue')[0]).toMatchObject({
      parentNumber: 41,
      subIssueId: 1042,
    });
  });

  it('duplicate 受 close_issue 开关约束（换个工具名也关不掉单）', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        actionsEnabled: { create_issue: true, open_pr: true, close_issue: false },
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'duplicate', target_number: 41 } }] }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('action-disabled');
    expect(fake.calls).toEqual([]);
  });

  it('dry-run → 只给计划，一条写方法都不调', async () => {
    const fake = createFakePort();
    const result = await executeV21(
      baseInput(fake.port, {
        dryRun: true,
        output: outputOf({ actions: [{ type: 'link', payload: { relation: 'blocked_by', target_number: 41 } }] }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.executed[0]?.detail).toContain('dry-run');
    expect(fake.calls).toEqual([]);
  });
});
