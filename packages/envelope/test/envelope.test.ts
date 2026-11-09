import { describe, expect, it } from 'vitest';

import {
  ACTION_INTENTS,
  DROP_REASON_TEXT,
  ENVELOPE_JSON_SCHEMA,
  MAX_COMMENT_BODY,
  filterActions,
  isActionIntent,
  isProtectedPath,
  parseEnvelopeJson,
  summarizeIssues,
  validateEnvelope,
} from '../src/index.ts';
import type { TaskEnvelope } from '../src/index.ts';

/** plan §5 的信封形状（补上 tech-plan §5.6 的 paths）。 */
function validEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    verdict: {
      kind: 'issue',
      labels: ['bug'],
      evidence: [{ rule: 'has-repro-steps', quote: '1. 打开页面 2. 点击按钮 3. 报错' }],
    },
    actions: [{ intent: 'comment', body: '缺少复现步骤，请补充。' }],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.0123 },
    ...overrides,
  };
}

describe('信封 JSON Schema（draft 2020-12）', () => {
  it('声明了 draft 2020-12 与固定 $id', () => {
    expect(ENVELOPE_JSON_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(ENVELOPE_JSON_SCHEMA.$id).toMatch(/envelope-1\.json$/);
    expect(ENVELOPE_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('正例 1：判定类（label + comment）', () => {
    const result = validateEnvelope(validEnvelope({ actions: [{ intent: 'label', add: ['bug'] }, { intent: 'comment', body: '已打标' }] }));
    expect(result.ok).toBe(true);
  });

  it('正例 2：主动建 issue（带 fingerprint）', () => {
    const result = validateEnvelope(
      validEnvelope({
        verdict: { kind: 'pr', labels: [], evidence: [{ rule: 'dep-vuln', quote: 'lodash@4.17.15', passed: false }] },
        actions: [{ intent: 'create_issue', title: '依赖漏洞：lodash < 4.17.21', fingerprint: 'dep-vuln:lodash', body: '详情…' }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('正例 3：推分支 + 开 PR（必须带 paths）', () => {
    const result = validateEnvelope(
      validEnvelope({
        actions: [{ intent: 'push_branch', branch: 'bot/t_01-fix-typo', paths: ['src/a.ts', 'docs/**'], openPr: true }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('反例 1：push_branch 缺 paths（tech-plan §5.6 的补充）', () => {
    const result = validateEnvelope(
      validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/t_01-fix' } as never] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.path.startsWith('/actions/0'))).toBe(true);
    }
  });

  it('反例 2：未知 intent（模型自创 open_pr / merge）', () => {
    for (const intent of ['open_pr', 'merge', 'close_issue']) {
      const result = validateEnvelope(validEnvelope({ actions: [{ intent, branch: 'bot/x' } as never] }));
      expect(result.ok, intent).toBe(false);
    }
  });

  it('反例 3：空 verdict（缺 labels / evidence / kind）', () => {
    expect(validateEnvelope(validEnvelope({ verdict: {} as never })).ok).toBe(false);
    expect(validateEnvelope(validEnvelope({ verdict: null as never })).ok).toBe(false);
    expect(validateEnvelope({ actions: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }).ok).toBe(false);
  });

  it('反例 4：comment body 超长', () => {
    const result = validateEnvelope(validEnvelope({ actions: [{ intent: 'comment', body: 'x'.repeat(MAX_COMMENT_BODY + 1) }] }));
    expect(result.ok).toBe(false);
  });

  it('反例 5：动作字段集封闭（多一个字段就不是合法形状）', () => {
    const result = validateEnvelope(validEnvelope({ actions: [{ intent: 'comment', body: 'x', extra: true } as never] }));
    expect(result.ok).toBe(false);
  });

  it('反例 6：usage 负数 / 非整数 token', () => {
    expect(validateEnvelope(validEnvelope({ usage: { inputTokens: -1, outputTokens: 0, costUsd: 0 } })).ok).toBe(false);
    expect(validateEnvelope(validEnvelope({ usage: { inputTokens: 1.5, outputTokens: 0, costUsd: 0 } })).ok).toBe(false);
  });

  it('反例 7：分支不在 bot/*', () => {
    for (const branch of ['main', 'feature/x', 'Bot/fix']) {
      const result = validateEnvelope(validEnvelope({ actions: [{ intent: 'push_branch', branch, paths: ['src/a.ts'] }] }));
      expect(result.ok, branch).toBe(false);
    }
  });

  it('paths 不许绝对路径与出仓路径', () => {
    expect(validateEnvelope(validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/x-1', paths: ['/etc/passwd'] }] })).ok).toBe(false);
    expect(validateEnvelope(validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/x-1', paths: ['../../etc'] }] })).ok).toBe(false);
    // 拒收清单是过滤阶段的职责，schema 层不拦（否则错误信息落到 oneOf 上，读不出来）
    expect(validateEnvelope(validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/x-1', paths: ['.github/workflows/ci.yml'] }] })).ok).toBe(true);
  });
});

describe('JSON 解析与错误摘要', () => {
  it('非法 JSON 也走同一个返回形状', () => {
    const result = parseEnvelopeJson('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.keyword).toBe('json-parse');
    }
  });

  it('合法 JSON 文本能通过', () => {
    expect(parseEnvelopeJson(JSON.stringify(validEnvelope())).ok).toBe(true);
  });

  it('摘要最多列 3 条并给出总数', () => {
    const issues = Array.from({ length: 5 }, (_unused, index) => ({
      path: `/actions/${index}`,
      keyword: 'pattern',
      message: '不匹配',
    }));
    const summary = summarizeIssues(issues);
    expect(summary).toContain('/actions/0');
    expect(summary).not.toContain('/actions/3');
    expect(summary).toContain('共 5 条');
  });
});

describe('动作白名单与丢弃原因', () => {
  it('白名单就是 plan §5 的 4 类', () => {
    expect([...ACTION_INTENTS]).toEqual(['comment', 'label', 'create_issue', 'push_branch']);
    expect(isActionIntent('comment')).toBe(true);
    expect(isActionIntent('open_pr')).toBe(false);
  });

  it('拒收清单命中 .git/、workflows、submodule、机器人自己的配置', () => {
    expect(isProtectedPath('.git/config')).toBe(true);
    expect(isProtectedPath('.github/workflows/ci.yml')).toBe(true);
    expect(isProtectedPath('sub/.gitmodules')).toBe(true);
    expect(isProtectedPath('.github/pi-bot/skills/x.md')).toBe(true);
    expect(isProtectedPath('src/a.ts')).toBe(false);
  });

  it('好动作不被坏动作连累：只丢坏的那条', () => {
    const envelope = validEnvelope({
      actions: [
        { intent: 'comment', body: '这个可以发' },
        { intent: 'comment', body: '   ' },
        { intent: 'push_branch', branch: 'bot/t_01-a', paths: ['.github/workflows/ci.yml'] },
      ],
    });
    const { accepted, dropped } = filterActions(envelope);
    expect(accepted).toEqual([{ intent: 'comment', body: '这个可以发' }]);
    expect(dropped.map((item) => item.reason)).toEqual(['malformed-action', 'path-protected']);
    expect(dropped[1]?.index).toBe(2);
  });

  it('未知 intent 被丢弃并给出 reason', () => {
    const { accepted, dropped } = filterActions(
      validEnvelope({ actions: [{ intent: 'merge', number: 1 } as never, { intent: 'label', add: ['bug'] }] }),
    );
    expect(accepted).toHaveLength(1);
    expect(dropped[0]?.reason).toBe('unknown-intent');
    expect(DROP_REASON_TEXT['unknown-intent']).toContain('4 类');
  });

  it('push_branch 缺 paths 的 reason 是 missing-paths', () => {
    const { dropped } = filterActions(validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/x-1' } as never] }));
    expect(dropped[0]?.reason).toBe('missing-paths');
  });

  it('M4 之前（写回闸门未开启）push_branch 被挡', () => {
    const envelope = validEnvelope({ actions: [{ intent: 'push_branch', branch: 'bot/x-1', paths: ['src/a.ts'] }] });
    expect(filterActions(envelope, { allowPushBranch: false }).dropped[0]?.reason).toBe('push-branch-disabled');
    expect(filterActions(envelope).accepted).toHaveLength(1);
  });

  it('技能 outputs 之外的动作被丢弃', () => {
    const envelope = validEnvelope({
      actions: [
        { intent: 'comment', body: 'ok' },
        { intent: 'create_issue', title: 'x', fingerprint: 'dep-vuln:y' },
      ],
    });
    const { accepted, dropped } = filterActions(envelope, { allowedIntents: ['comment'] });
    expect(accepted).toEqual([{ intent: 'comment', body: 'ok' }]);
    expect(dropped[0]?.reason).toBe('not-allowed-by-skill');
  });

  it('标签不在仓库映射里被丢弃（R4：不发明新标签）', () => {
    const envelope = validEnvelope({ actions: [{ intent: 'label', add: ['bug', 'invented-label'] }] });
    expect(filterActions(envelope, { allowedLabels: ['bug'] }).dropped[0]?.reason).toBe('label-not-allowed');
    expect(filterActions(envelope, { allowedLabels: ['bug', 'invented-label'] }).accepted).toHaveLength(1);
  });

  it('label 动作两侧都为空时不合规', () => {
    for (const action of [{ intent: 'label' }, { intent: 'label', add: [], remove: [] }]) {
      const { dropped } = filterActions(validEnvelope({ actions: [action as never] }));
      expect(dropped[0]?.reason, JSON.stringify(action)).toBe('malformed-action');
    }
  });

  it('create_issue 的 fingerprint 形状被校验', () => {
    const bad = validEnvelope({ actions: [{ intent: 'create_issue', title: 'x', fingerprint: 'Dep Vuln' }] });
    expect(filterActions(bad).dropped[0]?.reason).toBe('malformed-action');
  });

  it('分支名不合规的 reason 是 branch-not-allowed', () => {
    const { dropped } = filterActions(validEnvelope({ actions: [{ intent: 'push_branch', branch: 'main', paths: ['src/a.ts'] }] }));
    expect(dropped[0]?.reason).toBe('branch-not-allowed');
  });

  it('空 actions 数组是合法的（只判定不动作）', () => {
    const { accepted, dropped } = filterActions(validEnvelope({ actions: [] }));
    expect(accepted).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
