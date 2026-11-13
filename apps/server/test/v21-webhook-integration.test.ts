/**
 * v2.1 webhook 侧集成测试（WS6-A）：判定留痕 / 模板渲染 / 未知占位符告警 /
 * `{{repo.issues}}` 惰性接线 / PR 与旧命令通道兼容。
 *
 * 为什么用**内存假 `SqlRunner`** 而不是 `openTestDb()`：本机没有 PostgreSQL，
 * 真库夹具会在 `beforeAll` 直接 ECONNREFUSED；而这五个用例断言的是「webhook 调了哪些
 * SQL、写进去的正文是什么」，用记录式假实现反而比真库更精确、且能钉住「零请求」这类约束。
 *
 * 固定用 `source:'replay' + skipDeliveryDedup:true`：跳过验签与投递级 INSERT，
 * 只跑第 4.5 步之后的判定/渲染/落库；`v21` 的判定留痕是独立 UPDATE，照常被记录。
 */
import { describe, expect, it } from 'vitest';
import { handleWebhook } from '../src/http/webhook.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/webhook.ts';
import type { V21UnknownPlaceholderWarning, V21WebhookDeps } from '../src/http/webhook-v21.ts';
import { decideV21Delivery, v21TemplateOf } from '../src/http/webhook-v21.ts';
import type { SqlRunner } from '../src/config/repo-config.ts';
import type { RepoIssuesLister } from '../src/prompt/repo-issues.ts';
import type { LogBindings, Logger } from '../../../packages/shared/src/index.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ISSUE_URL = 'https://github.com/acme/widgets/issues/7';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
/** 四段结构的项目模板（技能触发词 / #编号 / 链接 / 正文快照）+ 一个可识别标记。 */
const PROJECT_TEMPLATE = [
  '/issue-format',
  '',
  '#{{issue.number}} {{issue.url}}',
  '',
  '正文快照：{{issue.content}}',
  '项目模板标记：PROJECT-V21',
].join('\n');

/* ── 记录式假实现 ─────────────────────────────────────────────────────────── */

type DecisionRow = { readonly decision: unknown; readonly reason: unknown };
type WarnRecord = { readonly fields: LogBindings | string; readonly message?: string };

type Captures = {
  readonly decisions: DecisionRow[];
  /** `insertMessage` 写进 `agent_messages.comment_body` 的正文（$6） */
  readonly messageBodies: string[];
  readonly enqueued: string[];
  readonly dispatched: string[];
  readonly reactions: string[];
  readonly warnings: WarnRecord[];
  readonly unknownWarnings: V21UnknownPlaceholderWarning[];
  readonly listIssuesCalls: number[];
};

function createCaptures(): Captures {
  return {
    decisions: [],
    messageBodies: [],
    enqueued: [],
    dispatched: [],
    reactions: [],
    warnings: [],
    unknownWarnings: [],
    listIssuesCalls: [],
  };
}

/** 记录所有 SQL，按语句前缀返回最小可用结果。 */
function createFakeDb(settings: unknown, c: Captures, deliveryDuplicate = false): SqlRunner {
  return {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.startsWith('INSERT INTO "webhook_deliveries"')) {
        // rowCount=0 模拟投递级幂等命中（同一 X-GitHub-Delivery 重投）
        return { rows: [], rowCount: deliveryDuplicate ? 0 : 1 };
      }
      if (text.startsWith('SELECT "signature_valid"')) {
        return { rows: [{ signature_valid: true }], rowCount: 1 };
      }
      if (text.includes('FROM "repos" WHERE "repo_full_name"')) {
        return {
          rows: [
            {
              enabled: true,
              dry_run: false,
              archived_at: null,
              settings,
              settings_valid: true,
              settings_error: null,
              source: 'manual',
              installation_id: null,
              settings_updated_at: null,
              updated_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.startsWith('UPDATE "webhook_deliveries" SET "decision"')) {
        c.decisions.push({ decision: values[1], reason: values[2] });
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "agent_messages"')) {
        // AGENT_SQL.insertMessage 的第 6 个参数就是 comment_body（1-based $6）
        c.messageBodies.push(typeof values[5] === 'string' ? values[5] : '');
        return { rows: [{ created_at: FIXED_NOW }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function createCapturingLogger(c: Captures): Logger {
  const logger: Logger = {
    level: 'info',
    debug: () => undefined,
    info: () => undefined,
    warn: (fields: LogBindings | string, message?: string) => {
      c.warnings.push({ fields, message });
    },
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

/* ── 载荷与依赖装配 ───────────────────────────────────────────────────────── */

function issueOpenedPayload(): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    issue: {
      number: 7,
      title: '导出按钮点击后闪退',
      body: '复现步骤：点一下就崩',
      html_url: ISSUE_URL,
      state: 'open',
      updated_at: '2026-06-01T00:00:00Z',
      user: { login: 'alice', type: 'User' },
      labels: [{ name: '缺陷' }],
    },
  };
}

function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'created',
    repository: { full_name: REPO },
    sender: { login: 'bob', type: 'User' },
    issue: {
      number: 7,
      title: '导出按钮点击后闪退',
      body: '复现步骤：点一下就崩',
      html_url: ISSUE_URL,
      state: 'open',
      updated_at: '2026-06-01T00:00:00Z',
      user: { login: 'alice', type: 'User' },
      labels: [{ name: '缺陷' }],
    },
    comment: {
      id: 99,
      body: '@pi-bot 帮我看看这个崩溃',
      author_association: 'MEMBER',
      user: { login: 'bob', type: 'User' },
      ...overrides,
    },
  };
}

function pullRequestPayload(): Record<string, unknown> {
  return {
    action: 'opened',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    pull_request: { number: 7, title: '加个按钮', html_url: ISSUE_URL },
  };
}

type HarnessOptions = {
  readonly settings?: unknown;
  /** 不传 = 装配层没有 GitHub client，`{{repo.issues}}` 必须按未知占位符保留 */
  readonly listIssues?: RepoIssuesLister | undefined;
  /** 不注入 v21 = 旧路径（用于兼容性断言） */
  readonly withV21?: boolean;
  /** 模拟投递级幂等命中（insertDelivery rowCount=0） */
  readonly deliveryDuplicate?: boolean;
};

type Harness = {
  readonly deps: WebhookDeps;
  readonly c: Captures;
};

function harness(options: HarnessOptions = {}): Harness {
  const c = createCaptures();
  const settings = options.settings ?? validRepoSettings();
  const fakeDb = createFakeDb(settings, c, options.deliveryDuplicate === true);
  const ack: WebhookAck = {
    addEyesReaction: async () => {
      c.reactions.push('eyes');
    },
  };
  const listIssuesCalls = c.listIssuesCalls;
  const lister: RepoIssuesLister | undefined =
    options.listIssues === undefined
      ? undefined
      : async (input) => {
          listIssuesCalls.push(input.page);
          return options.listIssues === undefined ? { total: 0, items: [] } : options.listIssues(input);
        };
  const v21: V21WebhookDeps | undefined =
    options.withV21 === false
      ? undefined
      : {
          db: fakeDb,
          onUnknownPlaceholders: (warning: V21UnknownPlaceholderWarning) => {
            c.unknownWarnings.push(warning);
          },
          ...(lister === undefined ? {} : { listIssues: lister }),
        };
  const deps: WebhookDeps = {
    verify: async () => true,
    db: fakeDb,
    enqueue: async (data) => {
      c.enqueued.push(data.command);
      return 'job-1';
    },
    ack,
    logger: createCapturingLogger(c),
    now: () => FIXED_NOW,
    isPaused: async () => false,
    dispatchAgent: async (key) => {
      c.dispatched.push(`${key.repo}#${String(key.issueNumber)}`);
      return null;
    },
    ...(v21 === undefined ? {} : { v21 }),
  };
  return { deps, c };
}

/** 走 replay：跳过验签与投递 INSERT，只验证 v2.1 判定/渲染/落库链。 */
async function deliver(
  deps: WebhookDeps,
  event: string,
  payload: unknown,
  deliveryId: string,
): Promise<{ readonly body: Record<string, unknown> }> {
  const result = await handleWebhook(deps, {
    deliveryId,
    event,
    rawBody: JSON.stringify(payload),
    signature: null,
    source: 'replay',
    forcedDryRun: true,
    skipDeliveryDedup: true,
  });
  return { body: result.body as unknown as Record<string, unknown> };
}

function eventSettings(event: string, trigger: Record<string, unknown>): unknown {
  return validRepoSettings({ triggers: { events: { [event]: trigger } } });
}

/** 结构化告警里找 unknown 那一条。 */
function unknownWarns(c: Captures): WarnRecord[] {
  return c.warnings.filter(
    (item) => typeof item.fields !== 'string' && Array.isArray(item.fields['unknown']),
  );
}

/* ── 用例 ───────────────────────────────────────────────────────────────── */

describe('v2.1 webhook 集成（判定留痕 / 模板渲染 / 惰性接线）', () => {
  it('①-A 开关关闭：未触发也留痕 decision=ignored + reason=switch-off，且不入队', async () => {
    const { deps, c } = harness({
      settings: eventSettings('issues.opened', { enabled: 'off', prompt: null }),
    });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-switch-off');

    expect(body['action']).toBe('ignored');
    expect(c.decisions).toEqual([{ decision: 'ignored', reason: 'switch-off' }]);
    expect(c.messageBodies).toHaveLength(0);
    expect(c.enqueued).toHaveLength(0);
    expect(c.dispatched).toHaveLength(0);
  });

  it('①-B 评论未提及：留痕 not-mentioned；机器人自己在已开启的事件下留痕 bot-self', async () => {
    const notMentioned = harness({
      settings: eventSettings('issue_comment.created', {
        enabled: 'conditional',
        prompt: null,
        gates: { require_mention: true, require_role: false, allow_roles: [], ignore_bot: true, allow_closed: false },
      }),
    });
    await deliver(
      notMentioned.deps,
      'issue_comment',
      commentPayload({ body: '只是一句普通讨论' }),
      'dlv-not-mentioned',
    );
    expect(notMentioned.c.decisions).toEqual([{ decision: 'ignored', reason: 'not-mentioned' }]);
    expect(notMentioned.c.messageBodies).toHaveLength(0);

    const botSelf = harness({
      settings: eventSettings('issue_comment.created', {
        enabled: 'conditional',
        prompt: null,
        gates: { require_mention: false, require_role: false, allow_roles: [], ignore_bot: true, allow_closed: false },
      }),
    });
    await deliver(
      botSelf.deps,
      'issue_comment',
      { ...commentPayload(), sender: { login: 'pi-bot[bot]', type: 'Bot' } },
      'dlv-bot-self',
    );
    expect(botSelf.c.decisions).toEqual([{ decision: 'ignored', reason: 'bot-self' }]);
    expect(botSelf.c.messageBodies).toHaveLength(0);
  });

  it('①-C 投递级重复：不覆盖原判定（原投递行已有 decision，重投不该被写成 repo-disabled）', async () => {
    const { deps, c } = harness({ deliveryDuplicate: true });
    const result = await handleWebhook(deps, {
      deliveryId: 'dlv-duplicate',
      event: 'issues',
      rawBody: JSON.stringify(issueOpenedPayload()),
      signature: null,
      source: 'replay',
      forcedDryRun: true,
    });
    expect((result.body as unknown as Record<string, unknown>)['action']).toBe('duplicate');
    expect(c.decisions).toHaveLength(0);
    expect(c.messageBodies).toHaveLength(0);
  });

  it('② 项目模板渲染结果进入 agent_messages.comment_body，四段顺序可断言', async () => {
    const { deps, c } = harness({
      settings: eventSettings('issues.opened', { enabled: 'on', prompt: PROJECT_TEMPLATE }),
    });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-project-template');

    expect(body['action']).toBe('enqueued');
    expect(c.decisions).toEqual([{ decision: 'triggered', reason: 'enabled' }]);
    expect(c.messageBodies).toHaveLength(1);
    const text = c.messageBodies[0] ?? '';

    // 四段顺序：技能触发词 → #编号 → {{issue.url}} 链接 → 正文快照
    const skillAt = text.indexOf('/issue-format');
    const numberAt = text.indexOf('#7');
    const linkAt = text.indexOf(ISSUE_URL);
    const snapshotAt = text.indexOf('正文快照：');
    expect(skillAt).toBeGreaterThanOrEqual(0);
    expect(numberAt).toBeGreaterThan(skillAt);
    expect(linkAt).toBeGreaterThan(numberAt);
    expect(snapshotAt).toBeGreaterThan(linkAt);
    expect(text).toContain('复现步骤：点一下就崩');
    expect(text).toContain('项目模板标记：PROJECT-V21');
    expect(text).not.toContain('{{issue.url}}');
    expect(text).not.toContain('{{issue.number}}');
    expect(c.dispatched).toEqual([`${REPO}#7`]);
  });

  it('②-B 内置默认模板也过同一个渲染器：prompt=null 时四段齐全且已渲染', async () => {
    const { deps, c } = harness({
      settings: eventSettings('issues.opened', { enabled: 'on', prompt: null }),
    });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-default-template');

    expect(body['action']).toBe('enqueued');
    const text = c.messageBodies[0] ?? '';
    expect(text.indexOf('/proposal-analysis')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('#7')).toBeGreaterThan(text.indexOf('/proposal-analysis'));
    expect(text.indexOf(ISSUE_URL)).toBeGreaterThan(text.indexOf('#7'));
    expect(text.indexOf('正文快照：')).toBeGreaterThan(text.indexOf(ISSUE_URL));
    expect(text).toContain('当前标签：缺陷');
    expect(text).not.toContain('{{issue.labels}}');
  });

  it('②-C 显式模板解析与 decideEvent().template 等价（项目模板 / 内置默认两种都不静默错值）', () => {
    const cases: readonly { readonly name: string; readonly settings: unknown }[] = [
      {
        name: '项目模板',
        settings: eventSettings('issues.opened', { enabled: 'on', prompt: PROJECT_TEMPLATE }),
      },
      {
        name: '内置默认模板',
        settings: eventSettings('issues.opened', { enabled: 'on', prompt: null }),
      },
    ];
    for (const item of cases) {
      const decision = decideV21Delivery({
        event: 'issues',
        action: 'opened',
        payload: issueOpenedPayload(),
        settings: item.settings,
      });
      expect(decision, item.name).not.toBeNull();
      expect(decision?.triggered, item.name).toBe(true);
      if (decision !== null && decision.triggered) {
        expect(v21TemplateOf(item.settings, 'issues.opened'), item.name).toBe(decision.template);
      const expectedSkill = item.name === '内置默认模板' ? '/proposal-analysis' : '/issue-format';
      expect(decision.template.startsWith(expectedSkill), item.name).toBe(true);
        expect(decision.template.includes('{{issue.url}}'), item.name).toBe(true);
      }
    }
  });

  it('③ 未知占位符原样保留，并产生含 unknown/event/repo 的结构化告警', async () => {
    const TEMPLATE = [
      '/issue-format',
      '',
      '#{{issue.number}} {{issue.url}}',
      '',
      '扩展字段：{{issue.notExist}}',
      '正文快照：{{issue.content}}',
    ].join('\n');
    const { deps, c } = harness({
      settings: eventSettings('issues.opened', { enabled: 'on', prompt: TEMPLATE }),
    });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-unknown');

    expect(body['action']).toBe('enqueued');
    const text = c.messageBodies[0] ?? '';
    expect(text).toContain('{{issue.notExist}}');
    const warns = unknownWarns(c);
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields).toMatchObject({
      unknown: ['issue.notExist'],
      event: 'issues.opened',
      repo: REPO,
      deliveryId: 'dlv-unknown',
    });
    // 生产消费方不只有 logger：注入的告警钩子也拿到了同一份结构化告警
    expect(c.unknownWarnings).toEqual([
      { unknown: ['issue.notExist'], event: 'issues.opened', repo: REPO, deliveryId: 'dlv-unknown' },
    ]);
  });

  it('④ 模板未写 {{repo.issues}} 时 listIssues 零调用；写了才调用并渲染索引', async () => {
    const lister: RepoIssuesLister = async () => ({
      total: 1,
      items: [
        {
          number: 42,
          title: '导出按钮点击后闪退',
          state: 'open',
          isPullRequest: false,
          updatedAt: '2026-06-01T00:00:00Z',
        },
      ],
    });

    const without = harness({
      listIssues: lister,
      settings: eventSettings('issues.opened', {
        enabled: 'on',
        prompt: '/issue-format\n#{{issue.number}} {{issue.url}}\n正文快照：{{issue.content}}',
      }),
    });
    await deliver(without.deps, 'issues', issueOpenedPayload(), 'dlv-no-index');
    expect(without.c.listIssuesCalls).toEqual([]);
    expect(without.c.messageBodies[0]).not.toContain('{{repo.issues}}');

    const withIndex = harness({
      listIssues: lister,
      settings: eventSettings('issues.opened', {
        enabled: 'on',
        prompt: '/issue-format\n#{{issue.number}} {{issue.url}}\n索引：{{repo.issues}}\n正文快照：{{issue.content}}',
      }),
    });
    await deliver(withIndex.deps, 'issues', issueOpenedPayload(), 'dlv-with-index');
    expect(withIndex.c.listIssuesCalls.length).toBeGreaterThan(0);
    expect(withIndex.c.messageBodies[0]).toContain('#42 [open] 导出按钮点击后闪退');
    expect(withIndex.c.messageBodies[0]).not.toContain('{{repo.issues}}');
  });

  it('④-B 没有 GitHub client 时 {{repo.issues}} 原样保留（不静默丢、不伪造数据）+ 告警', async () => {
    const { deps, c } = harness({
      settings: eventSettings('issues.opened', {
        enabled: 'on',
        prompt: '/issue-format\n#{{issue.number}} {{issue.url}}\n索引：{{repo.issues}}\n正文快照：{{issue.content}}',
      }),
    });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-no-client');

    expect(body['action']).toBe('enqueued');
    expect(c.listIssuesCalls).toEqual([]);
    expect(c.messageBodies[0]).toContain('{{repo.issues}}');
    expect(unknownWarns(c)[0]?.fields).toMatchObject({ unknown: ['repo.issues'], event: 'issues.opened', repo: REPO });
  });

  it('⑤ PR 事件留 pr-ignored 且完全不入队', async () => {
    const { deps, c } = harness();
    const { body } = await deliver(deps, 'pull_request', pullRequestPayload(), 'dlv-pr');

    expect(body['action']).toBe('ignored');
    expect(c.decisions).toEqual([{ decision: 'ignored', reason: 'pr-ignored' }]);
    expect(c.messageBodies).toHaveLength(0);
    expect(c.enqueued).toHaveLength(0);
    expect(c.dispatched).toHaveLength(0);
  });

  it('⑥ 独立分支：v0.3 白名单外的 issues.labeled / issues.closed 被 v2 触发后仍落消息', async () => {
    const labeled = harness({
      settings: eventSettings('issues.labeled', {
        enabled: 'conditional',
        prompt: null,
        labels: ['缺陷'],
      }),
    });
    const labeledPayload = { ...issueOpenedPayload(), action: 'labeled', label: { name: '缺陷' } };
    const r1 = await deliver(labeled.deps, 'issues', labeledPayload, 'dlv-labeled');
    expect(r1.body['action']).toBe('enqueued');
    expect(labeled.c.decisions).toEqual([{ decision: 'triggered', reason: 'conditional-met' }]);
    expect(labeled.c.messageBodies).toHaveLength(1);
    expect(labeled.c.messageBodies[0]).toContain('/label-triage');

    const closed = harness({
      settings: eventSettings('issues.closed', { enabled: 'on', prompt: null }),
    });
    const r2 = await deliver(
      closed.deps,
      'issues',
      { ...issueOpenedPayload(), action: 'closed' },
      'dlv-closed',
    );
    expect(r2.body['action']).toBe('enqueued');
    expect(closed.c.messageBodies).toHaveLength(1);
    expect(closed.c.messageBodies[0]).toContain('/issue-analysis');
  });

  it('⑤-B 旧命令通道（source=command）在注入 v21 时行为不变：仍走 enqueue，不落 v2 消息', async () => {
    const { deps, c } = harness();
    const payload = commentPayload({
      body: '@pi-bot /review-pr 看一下这个改动',
      id: 555,
    });
    (payload['issue'] as Record<string, unknown>)['pull_request'] = { url: 'https://example.invalid/pr/12' };
    const { body } = await deliver(deps, 'issue_comment', payload, 'dlv-command');

    expect(body['action']).toBe('enqueued');
    expect(c.enqueued).toEqual(['/review-pr']);
    expect(c.messageBodies).toHaveLength(0);
  });

  it('⑤-C 不注入 v21 时旧路径逐字节不变：不写判定行、不渲染模板、仍落 v0.3 消息', async () => {
    const { deps, c } = harness({ withV21: false });
    const { body } = await deliver(deps, 'issues', issueOpenedPayload(), 'dlv-legacy');

    expect(body['action']).toBe('enqueued');
    expect(c.decisions).toHaveLength(0);
    expect(c.unknownWarnings).toHaveLength(0);
    // 旧路径仍落一条 agent 消息（v0.3 composeAgentMessage 产物），正文里没有 v2 的四段结构
    expect(c.messageBodies).toHaveLength(1);
    expect(c.messageBodies[0]).not.toContain('项目模板标记');
  });
});
