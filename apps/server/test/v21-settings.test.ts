/**
 * v2.1 设置读取助手（`apps/server/src/config/v21-settings.ts`）的测试。
 *
 * 两条主线：
 * 1. **默认值**与契约一致（`docs/v21-contract.md` §1）：判定方与面板读到同一份值；
 * 2. **容错**：`settings` 是 `unknown`（jsonb / 请求体 / 手改库），解析失败必须**不抛**、
 *    回退默认值并置 `ok:false`——配置写坏了不能把 webhook 或 worker 带崩。
 *
 * 不连库：这层是纯函数，查库是调用方的事。
 */
import { describe, expect, it } from 'vitest';

import {
  readV21Settings,
  resolveAgentExecution,
  resolveCommentConfig,
  resolveCommentGates,
  resolveEventTrigger,
  resolveManagedCatalog,
} from '../src/config/v21-settings.ts';

// 内置默认的身份说明（`resolveAgentExecution()` 在两处都空时回落它）：
// 断言直接比对常量，避免测试里抄一份文案 —— 抄一份就等于多了一份「身份说明」。
import { AGENT_IDENTITY_PROMPT } from '../src/skills/prompt.ts';

/** 一份最小合法配置（`agent.managers` 非空 + 词表两角色）：只写关心的字段，其余走默认。 */
const BASE = {
  agent: { managers: ['alice'] },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement', meaning: '新的功能或改进', group: 'type' },
      { name: '缺陷', role: 'defect' },
    ],
  },
} as const;

describe('resolveEventTrigger：五个事件的默认值', () => {
  it('空配置 = FR-2.1 的默认值表', () => {
    expect(resolveEventTrigger({}, 'issues.opened')).toMatchObject({
      enabled: 'on',
      prompt: null,
      onlyBodyChanged: false,
      labels: [],
      ok: true,
      error: null,
    });
    expect(resolveEventTrigger({}, 'issues.edited')).toMatchObject({ enabled: 'on', onlyBodyChanged: true });
    expect(resolveEventTrigger({}, 'issues.labeled')).toMatchObject({ enabled: 'conditional', labels: [] });
    expect(resolveEventTrigger({}, 'issues.closed')).toMatchObject({ enabled: 'off' });
    expect(resolveEventTrigger({}, 'issue_comment.created')).toMatchObject({ enabled: 'conditional' });
  });

  it('显式配置覆盖默认值：开关、模板、标签表', () => {
    const settings = {
      ...BASE,
      triggers: {
        events: {
          'issues.closed': { enabled: 'on', prompt: '/close-check {{issue.number}}' },
          'issues.labeled': { enabled: 'conditional', labels: ['needs-triage'] },
        },
      },
    };
    expect(resolveEventTrigger(settings, 'issues.closed')).toMatchObject({
      enabled: 'on',
      prompt: '/close-check {{issue.number}}',
    });
    expect(resolveEventTrigger(settings, 'issues.labeled')).toMatchObject({
      enabled: 'conditional',
      labels: ['needs-triage'],
    });
    // 没配的事件仍是默认值
    expect(resolveEventTrigger(settings, 'issues.opened').enabled).toBe('on');
  });

  it('onlyBodyChanged 只对 issues.edited 生效（别的开关上写它也不用）', () => {
    const settings = {
      ...BASE,
      triggers: { events: { 'issues.opened': { enabled: 'on', only_body_changed: true } } },
    };
    expect(resolveEventTrigger(settings, 'issues.opened').onlyBodyChanged).toBe(false);
    expect(resolveEventTrigger(settings, 'issues.edited').onlyBodyChanged).toBe(true);
  });

  it('返回的 labels 是可安全修改的副本（调用方不会改到解析结果）', () => {
    const settings = { ...BASE, triggers: { events: { 'issues.labeled': { labels: ['a'] } } } };
    const first = resolveEventTrigger(settings, 'issues.labeled');
    (first.labels as string[]).push('b');
    expect(resolveEventTrigger(settings, 'issues.labeled').labels).toEqual(['a']);
  });
});

describe('resolveCommentGates：四闸门', () => {
  it('默认：要提及、不限角色、忽略机器人、不响应已关闭 issue', () => {
    expect(resolveCommentGates({})).toEqual({
      require_mention: true,
      require_role: false,
      allow_roles: [],
      ignore_bot: true,
      allow_closed: false,
      ok: true,
      error: null,
    });
  });

  it('显式配置的闸门生效', () => {
    const settings = {
      ...BASE,
      comment: {
        mentions: [{ keyword: 'pi-bot' }],
        roles: [{ name: '维护者', by: 'association', any_of: ['OWNER'] }],
      },
      triggers: {
        events: {
          'issue_comment.created': {
            gates: { require_role: true, allow_roles: ['维护者'], allow_closed: true, ignore_bot: false },
          },
        },
      },
    };
    expect(resolveCommentGates(settings)).toMatchObject({
      require_role: true,
      allow_roles: ['维护者'],
      allow_closed: true,
      ignore_bot: false,
      require_mention: true,
    });
  });
});

describe('resolveCommentConfig：关键词与角色清单', () => {
  it('默认一个关键词 pi-bot、没有角色，case_sensitive 补成 false', () => {
    expect(resolveCommentConfig({})).toEqual({
      mentions: [{ keyword: 'pi-bot', case_sensitive: false }],
      roles: [],
      ok: true,
      error: null,
    });
  });

  it('角色清单原样透出（两种判别方式都在）', () => {
    const settings = {
      ...BASE,
      comment: {
        mentions: [{ keyword: 'pi-bot' }, { keyword: '小豆', case_sensitive: true }],
        roles: [
          { name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] },
          { name: '值班同学', by: 'members', members: ['alice'] },
        ],
      },
    };
    const resolved = resolveCommentConfig(settings);
    expect(resolved.mentions).toEqual([
      { keyword: 'pi-bot', case_sensitive: false },
      { keyword: '小豆', case_sensitive: true },
    ]);
    expect(resolved.roles).toEqual([
      { name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] },
      { name: '值班同学', by: 'members', members: ['alice'] },
    ]);
  });
});

describe('resolveAgentExecution：系统提示词与限额', () => {
  it('默认：内置身份说明、并发 2、日配额 100、单轮 20 分钟、三类动作全关、留 90 天', () => {
    expect(resolveAgentExecution({})).toEqual({
      // 没配 `agent.system_prompt` 时不是空串，而是**内置默认**（`skills/prompt.ts`）：
      // 这个值会经 `session/create` 的 system 通道真的发出去（以前它硬编码在任务提示词里）。
      system_prompt: AGENT_IDENTITY_PROMPT,
      concurrency: 2,
      daily_quota: 100,
      turn_timeout_minutes: 20,
      actions: { create_issue: false, open_pr: false, close_issue: false },
      data_retention_days: 90,
      ok: true,
      error: null,
    });
  });

  it('agent.limits 是数值的唯一来源', () => {
    const settings = {
      ...BASE,
      agent: {
        managers: ['alice'],
        limits: { concurrency: 4, daily_quota: 7, turn_timeout_minutes: 5, data_retention_days: 30 },
      },
    };
    expect(resolveAgentExecution(settings)).toMatchObject({
      concurrency: 4,
      daily_quota: 7,
      turn_timeout_minutes: 5,
      data_retention_days: 30,
    });
  });

  it('system_prompt：agent.system_prompt 非空时优先，否则读 limits 里的那份', () => {
    const viaLimits = resolveAgentExecution({
      ...BASE,
      agent: { managers: ['alice'], limits: { system_prompt: '来自 limits 的设定' } },
    });
    expect(viaLimits.system_prompt).toBe('来自 limits 的设定');

    const viaTop = resolveAgentExecution({
      ...BASE,
      agent: { managers: ['alice'], system_prompt: '来自 agent 的设定', limits: { system_prompt: '旧值' } },
    });
    expect(viaTop.system_prompt).toBe('来自 agent 的设定');

    // 空白（默认值）= 用内置默认，不会盖掉 limits 里的值
    const blank = resolveAgentExecution({
      ...BASE,
      agent: { managers: ['alice'], system_prompt: '   ', limits: { system_prompt: '兜底' } },
    });
    expect(blank.system_prompt).toBe('兜底');

    // 两处都空（含只有空白）→ 回落内置默认，绝不返回空串（空串进 system 通道等于没有身份）
    expect(resolveAgentExecution({ ...BASE, agent: { managers: ['alice'] } }).system_prompt).toBe(
      AGENT_IDENTITY_PROMPT,
    );
    expect(
      resolveAgentExecution({ ...BASE, agent: { managers: ['alice'], limits: { system_prompt: '  ' } } })
        .system_prompt,
    ).toBe(AGENT_IDENTITY_PROMPT);
  });

  it('actions：任一路径打开即视为开启（默认全关）', () => {
    expect(
      resolveAgentExecution({ ...BASE, agent: { managers: ['alice'], actions: { open_pr: true } } }).actions,
    ).toEqual({ create_issue: false, open_pr: true, close_issue: false });
    expect(
      resolveAgentExecution({ ...BASE, agent: { managers: ['alice'], limits: { actions: { close_issue: true } } } })
        .actions,
    ).toEqual({ create_issue: false, open_pr: false, close_issue: true });
    // 两处都开也不合成奇怪的值
    expect(
      resolveAgentExecution({
        ...BASE,
        agent: {
          managers: ['alice'],
          actions: { create_issue: true },
          limits: { actions: { create_issue: true, open_pr: true } },
        },
      }).actions,
    ).toEqual({ create_issue: true, open_pr: true, close_issue: false });
  });
});

describe('resolveManagedCatalog：标签目录', () => {
  it('补齐 managed/status：老条目等价于 managed=true + active，meaning 缺省为 null', () => {
    expect(resolveManagedCatalog(BASE)).toEqual([
      { name: '需求', meaning: '新的功能或改进', group: 'type', managed: true, status: 'active' },
      { name: '缺陷', meaning: null, group: null, managed: true, status: 'active' },
    ]);
  });

  it('返回全部条目（retired / managed=false 不过滤，过滤是调用方的事）', () => {
    const entries = resolveManagedCatalog({
      ...BASE,
      labels: {
        vocabulary: [
          { name: '需求', role: 'requirement', managed: false },
          { name: '缺陷', role: 'defect', status: 'retired' },
          { name: 'bug', role: 'defect', meaning: '功能不符合预期' },
        ],
      },
    });
    expect(entries.map((entry) => [entry.name, entry.managed, entry.status])).toEqual([
      ['需求', false, 'active'],
      ['缺陷', true, 'retired'],
      ['bug', true, 'active'],
    ]);
  });

  it('空配置 → 空目录（空目录 = 不动任何标签，是安全侧）', () => {
    expect(resolveManagedCatalog({})).toEqual([]);
  });
});

describe('容错：解析失败不抛、回退默认值并置 ok:false', () => {
  const BROKEN = [
    ['字符串', 'not-an-object'],
    ['数字', 42],
    ['数组', []],
    ['未知键（strict 拒收）', { pipelines: {} }],
    ['类型错误', { triggers: { events: { 'issues.opened': { enabled: 'maybe' } } } }],
    ['词表 role 非法', { labels: { vocabulary: [{ name: 'x', role: 'bug' }] } }],
  ] as const;

  it.each(BROKEN)('%s → ok:false 且不抛', (_label, broken) => {
    expect(() => readV21Settings(broken)).not.toThrow();
    const read = readV21Settings(broken);
    expect(read.ok).toBe(false);
    expect(read.error).toBeTruthy();
    // 回退值仍然可用（形状默认值）
    expect(read.settings.triggers.events['issues.closed'].enabled).toBe('off');

    expect(resolveEventTrigger(broken, 'issues.opened').ok).toBe(false);
    expect(resolveEventTrigger(broken, 'issues.opened').enabled).toBe('on');
    expect(resolveCommentGates(broken).ok).toBe(false);
    expect(resolveCommentGates(broken).require_mention).toBe(true);
    expect(resolveCommentConfig(broken).ok).toBe(false);
    expect(resolveCommentConfig(broken).mentions).toEqual([{ keyword: 'pi-bot', case_sensitive: false }]);
    expect(resolveAgentExecution(broken).ok).toBe(false);
    expect(resolveAgentExecution(broken).concurrency).toBe(2);
    // 目录回退为空（不动任何标签）
    expect(resolveManagedCatalog(broken)).toEqual([]);
  });

  it('null / undefined 按「全默认」处理（列 NOT NULL，真为空只能是手改库）', () => {
    for (const empty of [null, undefined]) {
      const read = readV21Settings(empty);
      expect(read.ok).toBe(true);
      expect(resolveEventTrigger(empty, 'issues.edited').onlyBodyChanged).toBe(true);
      expect(resolveAgentExecution(empty).daily_quota).toBe(100);
    }
  });
});
