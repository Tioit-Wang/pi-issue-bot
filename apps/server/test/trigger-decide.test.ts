import { describe, expect, it } from 'vitest';
import { readV21Settings } from '../src/config/v21-settings.ts';
import {
  DEFAULT_EVENT_TEMPLATES,
  decideEvent,
  decidePullRequest,
  getDefaultEventTemplate,
} from '../src/trigger/decide.ts';

/**
 * 事件判定（FR-2.1 ~ FR-2.5 / BR-6，`docs/v21-contract.md` §2）。
 *
 * 两个必测面：
 *  1. **五个事件的默认值表**（FR-2.1）：`{}` 就是「继承平台默认」，改默认值必须在这里红；
 *  2. **判定顺序**（§2）：顺序错了会产生**误导性留痕**（开关关着却记成 `not-mentioned`，
 *     运维会去改关键词），所以「顺序」本身也要有负例守着。
 */

/** 一个通过闸门的评论（含合法提及）。 */
const OK_COMMENT = { body: '@pi-bot 帮我看看这条', authorAssociation: 'NONE', authorLogin: 'bob' } as const;

/** 带角色清单与限定角色闸门的配置。 */
const ROLE_SETTINGS = {
  comment: {
    mentions: [{ keyword: 'pi-bot' }],
    roles: [
      { name: '维护者', by: 'association', any_of: ['OWNER', 'MEMBER'] },
      { name: '值班', by: 'members', members: ['alice'] },
    ],
  },
  triggers: {
    events: {
      'issue_comment.created': { gates: { require_role: true, allow_roles: ['维护者', '值班'] } },
    },
  },
};

describe('夹具本身是合法配置（否则解析会静默回退到默认值，用例变成空转）', () => {
  it('ROLE_SETTINGS 能通过形状层解析', () => {
    const read = readV21Settings(ROLE_SETTINGS);
    expect(read.error).toBeNull();
    expect(read.ok).toBe(true);
  });
});

describe('FR-2.1 五个事件的默认值', () => {
  it('issues.opened 默认触发，reason=enabled，模板用内置默认', () => {
    const decision = decideEvent({ event: 'issues.opened', action: 'opened', settings: {} });
    expect(decision).toEqual({
      triggered: true,
      event: 'issues.opened',
      template: DEFAULT_EVENT_TEMPLATES['issues.opened'],
      reason: 'enabled',
    });
  });

  it('issues.edited 默认触发（正文变了）', () => {
    const decision = decideEvent({
      event: 'issues.edited',
      action: 'edited',
      settings: {},
      changedFields: ['body'],
    });
    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe('enabled');
  });

  it('issues.labeled 默认 conditional + 空标签表 = 永不触发', () => {
    const decision = decideEvent({
      event: 'issues.labeled',
      action: 'labeled',
      settings: {},
      addedLabel: 'bug',
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.labeled', reason: 'label-not-matched' });
  });

  it('issues.closed 默认关闭', () => {
    const decision = decideEvent({ event: 'issues.closed', action: 'closed', settings: {} });
    expect(decision).toEqual({ triggered: false, event: 'issues.closed', reason: 'switch-off' });
  });

  it('issue_comment.created 默认 conditional + 要提及：@pi-bot 后过闸门', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'open',
      actorIsBot: false,
      comment: OK_COMMENT,
    });
    expect(decision).toEqual({
      triggered: true,
      event: 'issue_comment.created',
      template: DEFAULT_EVENT_TEMPLATES['issue_comment.created'],
      reason: 'conditional-met',
    });
  });
});

describe('事件开关：off 直接不触发，且闸门一律不生效（FR-2.4 优先级）', () => {
  it('opened 被关掉 → switch-off', () => {
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: { triggers: { events: { 'issues.opened': { enabled: 'off' } } } },
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'switch-off' });
  });

  it('评论事件被关掉时，缺提及也只记 switch-off（不记 not-mentioned）', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {
        triggers: {
          events: {
            'issue_comment.created': {
              enabled: 'off',
              gates: { require_mention: true, ignore_bot: true },
            },
          },
        },
      },
      issueState: 'open',
      actorIsBot: false,
      comment: { body: '没有提及任何人的一句话', authorAssociation: 'NONE', authorLogin: 'bob' },
    });
    expect(decision).toEqual({ triggered: false, event: 'issue_comment.created', reason: 'switch-off' });
  });
});

describe('issues.edited：只认正文变更（only_body_changed 默认 true）', () => {
  it('只改标题 → body-unchanged', () => {
    const decision = decideEvent({
      event: 'issues.edited',
      action: 'edited',
      settings: {},
      changedFields: ['title'],
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.edited', reason: 'body-unchanged' });
  });

  it('只改标签 → body-unchanged', () => {
    const decision = decideEvent({
      event: 'issues.edited',
      action: 'edited',
      settings: {},
      changedFields: ['labels'],
    });
    expect(decision.triggered).toBe(false);
    expect(decision.reason).toBe('body-unchanged');
  });

  it('载荷没给 changes 时按未变更处理（不知道就不干活）', () => {
    const decision = decideEvent({ event: 'issues.edited', action: 'edited', settings: {} });
    expect(decision.reason).toBe('body-unchanged');
  });

  it('标题+正文一起改 → 触发', () => {
    const decision = decideEvent({
      event: 'issues.edited',
      action: 'edited',
      settings: {},
      changedFields: ['title', 'body'],
    });
    expect(decision.triggered).toBe(true);
  });

  it('关掉 only_body_changed 后，只改标题也触发', () => {
    const decision = decideEvent({
      event: 'issues.edited',
      action: 'edited',
      settings: { triggers: { events: { 'issues.edited': { only_body_changed: false } } } },
      changedFields: ['title'],
    });
    expect(decision.triggered).toBe(true);
  });
});

describe('issues.labeled：命中所配标签才触发', () => {
  const LABELED_ON_BUG = {
    triggers: { events: { 'issues.labeled': { enabled: 'conditional', labels: ['bug', 'crash'] } } },
  } as const;

  it('命中 → conditional-met', () => {
    const decision = decideEvent({
      event: 'issues.labeled',
      action: 'labeled',
      settings: LABELED_ON_BUG,
      addedLabel: 'bug',
    });
    expect(decision.triggered).toBe(true);
    expect(decision.reason).toBe('conditional-met');
  });

  it('标签名大小写不敏感', () => {
    const decision = decideEvent({
      event: 'issues.labeled',
      action: 'labeled',
      settings: LABELED_ON_BUG,
      addedLabel: 'BUG',
    });
    expect(decision.triggered).toBe(true);
  });

  it('未命中 → label-not-matched', () => {
    const decision = decideEvent({
      event: 'issues.labeled',
      action: 'labeled',
      settings: LABELED_ON_BUG,
      addedLabel: 'documentation',
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.labeled', reason: 'label-not-matched' });
  });

  it('没给 addedLabel → label-not-matched', () => {
    const decision = decideEvent({
      event: 'issues.labeled',
      action: 'labeled',
      settings: LABELED_ON_BUG,
      addedLabel: null,
    });
    expect(decision.reason).toBe('label-not-matched');
  });
});

describe('评论四闸门（FR-2.4）', () => {
  it('ignore_bot：机器人自己的评论 → bot-self', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'open',
      actorIsBot: true,
      comment: OK_COMMENT,
    });
    expect(decision).toEqual({ triggered: false, event: 'issue_comment.created', reason: 'bot-self' });
  });

  it('ignore_bot 关掉后机器人评论可以触发', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {
        triggers: { events: { 'issue_comment.created': { gates: { ignore_bot: false } } } },
      },
      issueState: 'open',
      actorIsBot: true,
      comment: OK_COMMENT,
    });
    expect(decision.triggered).toBe(true);
  });

  it('allow_closed 默认 false：已关闭 issue 上的新评论 → closed-not-allowed', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'closed',
      actorIsBot: false,
      comment: OK_COMMENT,
    });
    expect(decision).toEqual({
      triggered: false,
      event: 'issue_comment.created',
      reason: 'closed-not-allowed',
    });
  });

  it('allow_closed 打开后已关闭 issue 也能触发', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: { triggers: { events: { 'issue_comment.created': { gates: { allow_closed: true } } } } },
      issueState: 'closed',
      actorIsBot: false,
      comment: OK_COMMENT,
    });
    expect(decision.triggered).toBe(true);
  });

  it('require_mention 默认开着：没提及 → not-mentioned', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'open',
      actorIsBot: false,
      comment: { body: '我觉得这个问题应该先补复现步骤', authorAssociation: 'NONE', authorLogin: 'bob' },
    });
    expect(decision).toEqual({ triggered: false, event: 'issue_comment.created', reason: 'not-mentioned' });
  });

  it('只写在代码块里的 @pi-bot 不算提及 → not-mentioned', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'open',
      actorIsBot: false,
      comment: {
        body: ['这样叫人：', '```', '@pi-bot 帮我看看', '```'].join('\n'),
        authorAssociation: 'NONE',
        authorLogin: 'bob',
      },
    });
    expect(decision.reason).toBe('not-mentioned');
  });

  it('require_mention 关掉后不提及也触发', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: { triggers: { events: { 'issue_comment.created': { gates: { require_mention: false } } } } },
      issueState: 'open',
      actorIsBot: false,
      comment: { body: '随便说一句', authorAssociation: 'NONE', authorLogin: 'bob' },
    });
    expect(decision.triggered).toBe(true);
  });

  it('require_role：关联不够 → role-denied', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: ROLE_SETTINGS,
      issueState: 'open',
      actorIsBot: false,
      comment: { ...OK_COMMENT, authorAssociation: 'CONTRIBUTOR', authorLogin: 'bob' },
    });
    expect(decision).toEqual({ triggered: false, event: 'issue_comment.created', reason: 'role-denied' });
  });

  it('require_role：按作者关联命中 → 触发', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: ROLE_SETTINGS,
      issueState: 'open',
      actorIsBot: false,
      comment: { ...OK_COMMENT, authorAssociation: 'OWNER', authorLogin: 'carol' },
    });
    expect(decision.triggered).toBe(true);
  });

  it('require_role：按成员 login 命中 → 触发（大小写不敏感）', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: ROLE_SETTINGS,
      issueState: 'open',
      actorIsBot: false,
      comment: { ...OK_COMMENT, authorAssociation: 'NONE', authorLogin: 'Alice' },
    });
    expect(decision.triggered).toBe(true);
  });

  it('require_role 但 allow_roles 为空 = 闸门没限定 → 放行', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: { triggers: { events: { 'issue_comment.created': { gates: { require_role: true } } } } },
      issueState: 'open',
      actorIsBot: false,
      comment: { ...OK_COMMENT, authorAssociation: 'NONE', authorLogin: 'bob' },
    });
    expect(decision.triggered).toBe(true);
  });
});

describe('三层去重与日配额（在闸门之后判）', () => {
  it('内容重复 → content-duplicate', () => {
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: {},
      contentDuplicate: true,
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'content-duplicate' });
  });

  it('日配额用尽 → daily-quota', () => {
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: {},
      dailyQuotaExceeded: true,
    });
    expect(decision.reason).toBe('daily-quota');
  });

  it('闸门先于去重：没提及 + 内容重复 → 记 not-mentioned', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      issueState: 'open',
      actorIsBot: false,
      comment: { body: '没有提及', authorAssociation: 'NONE', authorLogin: 'bob' },
      contentDuplicate: true,
    });
    expect(decision.reason).toBe('not-mentioned');
  });

  it('仓库不可用优先于一切 → repo-disabled', () => {
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: {},
      repoDisabled: true,
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'repo-disabled' });
  });

  it('验签失败优先于仓库可用性 → signature-invalid（不再误标 repo-disabled）', () => {
    /*
      实测缺陷（issue #30）：401 的投递被记成 `repo-disabled`，而 `repos.enabled = true`，
      排查时先去查仓库开关。验签失败必须单独成 reason，且排在仓库可用性之前——
      因为这条投递压根没被信任，讨论「仓库开不开」没有意义。
    */
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: {},
      repoDisabled: true,
      signatureInvalid: true,
    });
    expect(decision).toEqual({ triggered: false, event: 'issues.opened', reason: 'signature-invalid' });
  });

  it('只给 signatureInvalid 时也判 signature-invalid（401 路径不依赖仓库状态）', () => {
    const decision = decideEvent({
      event: 'issue_comment.created',
      action: 'created',
      settings: {},
      signatureInvalid: true,
    });
    expect(decision.reason).toBe('signature-invalid');
  });
});

describe('模板取值：项目配置优先，空/空白回退内置默认', () => {
  it('配了模板就用配置的原文（含空白与换行）', () => {
    const template = '/label-triage\n#{{issue.number}} {{issue.url}}\n';
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: { triggers: { events: { 'issues.opened': { prompt: template } } } },
    });
    expect(decision.triggered).toBe(true);
    if (decision.triggered) {
      expect(decision.template).toBe(template);
    }
  });

  it('prompt 是空白串时回退内置默认（面板允许清空输入框）', () => {
    const decision = decideEvent({
      event: 'issues.opened',
      action: 'opened',
      settings: { triggers: { events: { 'issues.opened': { prompt: '   ' } } } },
    });
    expect(decision.triggered).toBe(true);
    if (decision.triggered) {
      expect(decision.template).toBe(DEFAULT_EVENT_TEMPLATES['issues.opened']);
    }
  });

  it('内置默认模板都包含四段结构（技能触发词 / #编号 / 链接 / 正文）', () => {
    const events = ['issues.opened', 'issues.edited', 'issues.labeled', 'issues.closed', 'issue_comment.created'] as const;
    for (const event of events) {
      const template = getDefaultEventTemplate(event);
      expect(template, event).toMatch(/^\/[a-z-]+/u);
      expect(template, event).toContain('#{{issue.number}}');
      expect(template, event).toContain('{{issue.url}}');
      expect(template, event).toMatch(/```[\s\S]*\{\{[a-z]+\.[a-z]+\}\}[\s\S]*```/u);
    }
  });
});

describe('PR 事件：本期不处理（§0「不纳入」）', () => {
  it('decidePullRequest 恒为 pr-ignored，且不带模板', () => {
    expect(decidePullRequest()).toEqual({
      triggered: false,
      event: 'pull_request.*',
      reason: 'pr-ignored',
    });
  });
});
