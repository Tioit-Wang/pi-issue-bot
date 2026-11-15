/**
 * 增量投喂（FR-4.2 / BR-4 / FR-4.1）的用例组：
 *  - **首个事件**下发完整正文；
 *  - **后续事件**只下发「本轮变更 + 本轮指令」，不重复整篇正文（历史由会话承担）；
 *  - 项目自定义模板写 `{{issue.content}}` 时**仍然**拿到全文（向后兼容，需求允许显式要全文）；
 *  - 载荷缺 `changes` 时不崩、不猜。
 *
 * 首轮判据是 `agent_sessions.turns`：这里用**记录式假 `SqlRunner`**（本机没有 PostgreSQL）
 * 分别给出 `turns=0` / `turns=2`，从 `handleWebhook()` 一路断言到
 * `agent_messages.comment_body` 的正文。假实现只按语句前缀给最小可用结果，
 * 不引入 `vi.mock`（AGENTS §6 的三个 0）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_DELTA_TEMPLATES, DEFAULT_EVENT_TEMPLATES } from '../../../packages/contract/src/index.ts';
import { nextAgentTurns, planAgentSession } from '../src/app/compose.ts';
import type { SqlRunner } from '../src/config/repo-config.ts';
import { handleWebhook } from '../src/http/webhook.ts';
import type { WebhookAck, WebhookDeps } from '../src/http/webhook.ts';
import {
  buildV21AgentMessage,
  v21ContentDeltaOf,
  v21IsFirstEventOf,
  v21LineDeltaOf,
  v21RenderContextOf,
  v21TemplateOf,
} from '../src/http/webhook-v21.ts';
import type { V21WebhookDeps } from '../src/http/webhook-v21.ts';
import { renderTemplate, renderTemplateAsync } from '../src/prompt/render.ts';
import type { RenderContext } from '../src/prompt/render.ts';
import type { LogBindings, Logger } from '../../../packages/shared/src/index.ts';
import { validRepoSettings } from './helpers/repo-settings.ts';

const REPO = 'acme/widgets';
const ISSUE_URL = 'https://github.com/acme/widgets/issues/7';
const FIXED_NOW = new Date('2026-06-01T12:00:00.000Z');
/** 正文里**未被改动**的那一行：后续事件的正文里绝不能出现（出现即等于重发全文）。 */
const UNCHANGED_LINE = '复现步骤：点一下就崩';
const PREVIOUS_BODY = `${UNCHANGED_LINE}\n环境：Windows 10`;
const CURRENT_BODY = `${UNCHANGED_LINE}\n环境：Windows 11`;

/* ── 假实现 ───────────────────────────────────────────────────────────────── */

type Captures = {
  /** `agent_messages.comment_body` 的正文（$6） */
  readonly bodies: string[];
  readonly warns: { readonly fields: LogBindings | string; readonly message?: string }[];
};

function createCaptures(): Captures {
  return { bodies: [], warns: [] };
}

/**
 * 记录式假库。
 *
 * `turns` = 会话行里已有的轮次数（`null` = 还没有会话行）：
 *  - `0` / `null` → 首轮；
 *  - `>0` → 后续事件。
 *
 * 传**函数**时每次查询现取：S2 的闭环用例要在两次投递之间「跑完一轮」改写这个值，
 * 就像生产里 `persistAgentSessionAfterRun()` 真把 `turns` 写回库那样。
 */
type TurnsView = number | null | (() => number | null);

function turnsOf(view: TurnsView): number | null {
  return typeof view === 'function' ? view() : view;
}

function createFakeDb(
  settings: unknown,
  c: Captures,
  turns: TurnsView,
): { readonly db: SqlRunner; readonly sessionReads: { count: number } } {
  const sessionReads = { count: 0 };
  const db: SqlRunner = {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.startsWith('INSERT INTO "webhook_deliveries"')) {
        return { rows: [], rowCount: 1 };
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
      if (text.startsWith('SELECT "state", "sandbox_id"')) {
        sessionReads.count += 1;
        const rowTurns = turnsOf(turns);
        if (rowTurns === null) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ state: 'idle', sandbox_id: null, session_id: 'sess-1', turns: rowTurns, cursor: 0 }],
          rowCount: 1,
        };
      }
      if (text.includes('INTO "quota_counters"')) {
        // 日配额占格（SL-3）：给一行 `count` = 「抢到了这一格」。
        // 没有这条分支，`reserveDailyQuota()` 读到空行会判 granted=false，
        // 整条投递被改判成 `daily-quota`，消息正文根本不会产生。
        return { rows: [{ count: 1 }], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "agent_messages"')) {
        c.bodies.push(typeof values[5] === 'string' ? values[5] : '');
        return { rows: [{ created_at: FIXED_NOW }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, sessionReads };
}

function createLogger(c: Captures): Logger {
  const logger: Logger = {
    level: 'info',
    debug: () => undefined,
    info: () => undefined,
    warn: (fields: LogBindings | string, message?: string) => {
      c.warns.push({ fields, message });
    },
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

/* ── 载荷 ─────────────────────────────────────────────────────────────────── */

function editedPayload(withChanges = true): Record<string, unknown> {
  return {
    action: 'edited',
    repository: { full_name: REPO },
    sender: { login: 'alice', type: 'User' },
    ...(withChanges ? { changes: { body: { from: PREVIOUS_BODY } } } : {}),
    issue: {
      number: 7,
      title: '导出按钮点击后闪退',
      body: CURRENT_BODY,
      html_url: ISSUE_URL,
      state: 'open',
      updated_at: '2026-06-01T00:00:00.000Z',
      user: { login: 'alice', type: 'User' },
      labels: [{ name: '缺陷' }],
    },
  };
}

function eventSettings(event: string, trigger: Record<string, unknown>): unknown {
  return validRepoSettings({ triggers: { events: { [event]: trigger } } });
}

/** 走 replay：跳过验签与投递 INSERT，只跑判定 → 渲染 → 落库。 */
async function deliverEdited(
  settings: unknown,
  turns: TurnsView,
): Promise<{ readonly c: Captures; readonly sessionReads: { count: number } }> {
  const c = createCaptures();
  const { db, sessionReads } = createFakeDb(settings, c, turns);
  await deliverWith(db, settings, c);
  return { c, sessionReads };
}

/**
 * 用**同一份库**投一次 `issues.edited`。
 *
 * 「连续两个事件」的用例靠它：同一个 `db` / 同一个 `turns` 视图，模拟真实的一条 issue
 * 上先后到达两条投递，中间没有谁把 `turns` 加一（上一轮还没跑完）。
 */
async function deliverWith(db: SqlRunner, settings: unknown, c: Captures): Promise<void> {
  const ack: WebhookAck = { addEyesReaction: async () => undefined };
  const v21: V21WebhookDeps = { db };
  const deps: WebhookDeps = {
    verify: async () => true,
    db,
    enqueue: async () => 'job-1',
    ack,
    logger: createLogger(c),
    now: () => FIXED_NOW,
    isPaused: async () => false,
    dispatchAgent: async () => null,
    v21,
  };
  await handleWebhook(deps, {
    deliveryId: 'dlv-incremental',
    event: 'issues',
    rawBody: JSON.stringify(editedPayload()),
    signature: null,
    source: 'replay',
    forcedDryRun: true,
    skipDeliveryDedup: true,
  });
}


/** 一份完整的渲染上下文（首轮、带正文、带评论），用于纯渲染断言。 */
function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    repo: REPO,
    actor: 'alice',
    eventAction: 'edited',
    issue: {
      author: 'alice',
      number: 7,
      url: ISSUE_URL,
      title: '导出按钮点击后闪退',
      content: CURRENT_BODY,
      labels: ['缺陷'],
      updatedAt: '2026-06-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

/* ── 用例 ───────────────────────────────────────────────────────────────── */

describe('行级差异（内容增量的取值基础）', () => {
  it('只报「多了哪些行、少了哪些行」，未改动的行不出现', () => {
    const delta = v21LineDeltaOf(PREVIOUS_BODY, CURRENT_BODY);
    expect(delta.added).toEqual(['环境：Windows 11']);
    expect(delta.removed).toEqual(['环境：Windows 10']);
  });

  it('重复行按次数算差（同一行出现两次只多算一次）', () => {
    expect(v21LineDeltaOf('a\na', 'a\na\na').added).toEqual(['a']);
    expect(v21LineDeltaOf('a\na\na', 'a\na').removed).toEqual(['a']);
  });
});

describe('{{issue.contentDelta}} 的取值口径', () => {
  it('首轮恒为空串（正文由 {{issue.content}} 承担）', () => {
    expect(v21ContentDeltaOf({ event: 'issues.edited', payload: editedPayload() })).toBe('');
  });

  it('后续轮 + issues.edited：给变更字段与行级增删', () => {
    const delta = v21ContentDeltaOf({ event: 'issues.edited', payload: editedPayload(), firstEvent: false });
    expect(delta).toContain('变更字段：正文');
    expect(delta).toContain('+ 环境：Windows 11');
    expect(delta).toContain('- 环境：Windows 10');
    // 未改动的行不属于「变更内容」
    expect(delta).not.toContain(UNCHANGED_LINE);
  });

  it('缺失 changes 不崩：明写「未提供」，不猜也不静默', () => {
    const delta = v21ContentDeltaOf({
      event: 'issues.edited',
      payload: editedPayload(false),
      firstEvent: false,
    });
    expect(delta).toBe('变更字段：未知（载荷未提供 changes）');
  });

  it('labeled / closed 给语义变更，评论事件为空串（评论正文另有占位符）', () => {
    const labeled = v21ContentDeltaOf({
      event: 'issues.labeled',
      payload: { label: { name: '缺陷' }, issue: { number: 7 } },
      firstEvent: false,
    });
    expect(labeled).toBe('新增标签：缺陷');
    expect(v21ContentDeltaOf({ event: 'issues.closed', payload: {}, firstEvent: false })).toBe(
      '状态：open → closed',
    );
    expect(
      v21ContentDeltaOf({ event: 'issue_comment.created', payload: {}, firstEvent: false }),
    ).toBe('');
  });
});

describe('模板选择：平台默认分「首轮 / 后续」，项目自定义不受影响', () => {
  it('项目没写模板：首轮用全文默认，后续轮用增量默认', () => {
    const settings = eventSettings('issues.edited', { enabled: 'on', prompt: null });
    expect(v21TemplateOf(settings, 'issues.edited')).toBe(DEFAULT_EVENT_TEMPLATES['issues.edited']);
    expect(v21TemplateOf(settings, 'issues.edited', 'delta')).toBe(
      DEFAULT_EVENT_DELTA_TEMPLATES['issues.edited'],
    );
    // 增量默认模板里没有全文占位符——这是「不重复整篇正文」的机械保证
    expect(DEFAULT_EVENT_DELTA_TEMPLATES['issues.edited']).not.toContain('{{issue.content}}');
    expect(DEFAULT_EVENT_DELTA_TEMPLATES['issues.edited']).toContain('{{issue.contentDelta}}');
  });

  it('四个后续轮模板都不含全文占位符，且增量内容都包在 ``` 围栏里（I10）', () => {
    // 逐个事件钉住，而不是只钉 edited：将来谁给 labeled / closed / comment 补上
    // `{{issue.content}}`，或把某个增量模板写成裸拼，这里必须红。
    for (const event of ['issues.edited', 'issues.labeled', 'issues.closed'] as const) {
      const template = DEFAULT_EVENT_DELTA_TEMPLATES[event];
      expect(template).not.toContain('{{issue.content}}');
      // 围栏紧贴在占位符前后（中间只允许换行）：外部文本永远是数据
      expect(template).toMatch(/```\r?\n\{\{issue\.contentDelta\}\}\r?\n```/);
    }
    // 评论事件：正文由 {{comment.body}} 单独给，同样必须围栏
    const comment = DEFAULT_EVENT_DELTA_TEMPLATES['issue_comment.created'];
    expect(comment).not.toContain('{{issue.content}}');
    expect(comment).toMatch(/```\r?\n\{\{comment\.body\}\}\r?\n```/);
    // `issues.opened` 的增量版就是全文版：它只可能是首轮，不能悄悄变成增量模板
    expect(DEFAULT_EVENT_DELTA_TEMPLATES['issues.opened']).toBe(DEFAULT_EVENT_TEMPLATES['issues.opened']);
  });

  it('逐字照抄默认模板的项目：后续轮仍拿全文（那是它的显式选择）', () => {
    // 反证用：`pickEventTemplate()` 只在项目 prompt 为空时才换增量模板。
    // 「与默认串逐字相等」不等于「平台默认」—— 项目可能真的抄了一份并要求全文。
    const verbatim = DEFAULT_EVENT_TEMPLATES['issues.edited'];
    const settings = eventSettings('issues.edited', { enabled: 'on', prompt: verbatim });
    expect(v21TemplateOf(settings, 'issues.edited', 'delta')).toBe(verbatim);
    expect(v21TemplateOf(settings, 'issues.edited', 'delta')).toContain('{{issue.content}}');
  });

  it('项目自定义模板（写 {{issue.content}}）两种变体都原样返回 → 仍拿全文', () => {
    const custom = '自定义：{{issue.content}}';
    const settings = eventSettings('issues.edited', { enabled: 'on', prompt: custom });
    expect(v21TemplateOf(settings, 'issues.edited')).toBe(custom);
    expect(v21TemplateOf(settings, 'issues.edited', 'delta')).toBe(custom);
  });
});

describe('渲染：{{issue.content}} 语义未变，{{issue.contentDelta}} / {{issue.isFirstEvent}} 新增', () => {
  it('全文占位符照样是全文（自定义模板向后兼容）', () => {
    const result = renderTemplate('{{issue.content}}', renderContext({ firstEvent: false, contentDelta: '+ 新' }));
    expect(result.text).toBe(CURRENT_BODY);
    expect(result.unknown).toEqual([]);
  });

  it('首轮没有变更：delta 渲染成空串而不是「未知占位符」', () => {
    const result = renderTemplate('[{{issue.contentDelta}}]', renderContext({ firstEvent: true }));
    expect(result.text).toBe('[]');
    expect(result.unknown).toEqual([]);
  });

  it('后续轮：delta 有值，isFirstEvent 渲染成 false', () => {
    const ctx = renderContext({ firstEvent: false, contentDelta: '+ 环境：Windows 11' });
    expect(renderTemplate('{{issue.contentDelta}}', ctx).text).toBe('+ 环境：Windows 11');
    expect(renderTemplate('{{issue.isFirstEvent}}', ctx).text).toBe('false');
  });

  it('没给 firstEvent 时按首轮渲染（判断不了就多给全文）', () => {
    expect(renderTemplate('{{issue.isFirstEvent}}', renderContext()).text).toBe('true');
  });
});

describe('buildV21AgentMessage：首轮全文 / 后续轮增量', () => {
  const noopDeps = (c: Captures): V21WebhookDeps => ({ db: createFakeDb(validRepoSettings(), c, null).db });

  async function build(
    firstEvent: boolean | undefined,
    settings: unknown,
    decidedTemplate?: string,
  ): Promise<string> {
    const c = createCaptures();
    const result = await buildV21AgentMessage({
      settings,
      event: 'issues.edited',
      repo: REPO,
      eventAction: 'edited',
      payload: editedPayload(),
      deps: noopDeps(c),
      logger: createLogger(c),
      deliveryId: 'dlv-build',
      ...(firstEvent === undefined ? {} : { firstEvent }),
      ...(decidedTemplate === undefined ? {} : { decidedTemplate }),
    });
    return result.text;
  }

  it('首轮（firstEvent 省略）→ 含全文', async () => {
    const text = await build(undefined, eventSettings('issues.edited', { enabled: 'on', prompt: null }));
    expect(text).toContain('正文快照');
    expect(text).toContain(UNCHANGED_LINE);
    expect(text).toContain('环境：Windows 11');
  });

  it('后续轮 → 不含全文，只含变更（未改动的行不出现）', async () => {
    const text = await build(false, eventSettings('issues.edited', { enabled: 'on', prompt: null }));
    expect(text).toContain('本轮变更：');
    expect(text).toContain('+ 环境：Windows 11');
    expect(text).toContain('- 环境：Windows 10');
    expect(text).not.toContain(UNCHANGED_LINE);
    expect(text).not.toContain('正文快照');
  });

  it('后续轮 + 项目自定义模板写 {{issue.content}} → 仍渲染全文（向后兼容）', async () => {
    const text = await build(
      false,
      eventSettings('issues.edited', { enabled: 'on', prompt: '看下正文：\n{{issue.content}}' }),
    );
    expect(text).toContain(UNCHANGED_LINE);
    expect(text).toContain('环境：Windows 11');
  });

  /*
    下面两条走**生产调用形态**（`handleV21Webhook` 总会把 `decideEvent()` 解析好的模板
    当 `decidedTemplate` 传进来，见 `webhook-v21.ts` 的调用点）。只测 `v21TemplateOf()`
    钉不住 `pickEventTemplate()` 的「与默认串相等 ⇒ 回头再看 settings」那一支：
    若有人日后把判定改成「相等即当平台默认」，项目逐字照抄默认模板的显式选择会被悄悄改掉。
  */
  it('生产形态：decidedTemplate = 内置默认串、项目没写模板 → 后续轮换成增量', async () => {
    const text = await build(
      false,
      eventSettings('issues.edited', { enabled: 'on', prompt: null }),
      DEFAULT_EVENT_TEMPLATES['issues.edited'],
    );
    expect(text).toContain('本轮变更：');
    expect(text).not.toContain(UNCHANGED_LINE);
  });

  it('生产形态：decidedTemplate = 内置默认串、项目逐字照抄了默认模板 → 后续轮仍是全文', async () => {
    const verbatim = DEFAULT_EVENT_TEMPLATES['issues.edited'];
    const text = await build(
      false,
      eventSettings('issues.edited', { enabled: 'on', prompt: verbatim }),
      verbatim,
    );
    expect(text).toContain(UNCHANGED_LINE);
    expect(text).not.toContain('本轮变更：');
  });
});

describe('首轮判据：agent_sessions.turns', () => {
  it('没有会话行 / turns=0 → 首轮；turns>0 → 后续', async () => {
    const c = createCaptures();
    // 域键（BR-5）：本组用例全是 issue 域的会话行
    const key = { repo: REPO, domain: 'issue' as const, issueNumber: 7 };
    const warns: unknown[] = [];
    const onWarn = (error: unknown): void => {
      warns.push(error);
    };
    expect(await v21IsFirstEventOf(createFakeDb(validRepoSettings(), c, null).db, key, onWarn)).toBe(true);
    expect(await v21IsFirstEventOf(createFakeDb(validRepoSettings(), c, 0).db, key, onWarn)).toBe(true);
    expect(await v21IsFirstEventOf(createFakeDb(validRepoSettings(), c, 2).db, key, onWarn)).toBe(false);
    expect(warns).toEqual([]);
  });

  it('读库失败 → 按首轮处理并留一条 warn（不让投递 500）', async () => {
    const failing: SqlRunner = {
      query: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    };
    const warns: unknown[] = [];
    const first = await v21IsFirstEventOf(
      failing,
      { repo: REPO, domain: 'issue', issueNumber: 7 },
      (error) => {
        warns.push(error);
      },
    );
    expect(first).toBe(true);
    expect(warns).toHaveLength(1);
  });
});

describe('端到端（handleWebhook）：同一个 issues.edited 载荷，首轮与后续轮正文不同', () => {
  const settings = eventSettings('issues.edited', { enabled: 'on', prompt: null });

  it('turns=0：正文含完整正文快照', async () => {
    const { c } = await deliverEdited(settings, 0);
    expect(c.bodies).toHaveLength(1);
    const text = c.bodies[0] ?? '';
    expect(text).toContain('正文快照');
    expect(text).toContain(UNCHANGED_LINE);
    expect(text).toContain('环境：Windows 11');
  });

  it('turns=2：正文只有变更与本轮指令，没有正文快照', async () => {
    const { c } = await deliverEdited(settings, 2);
    expect(c.bodies).toHaveLength(1);
    const text = c.bodies[0] ?? '';
    expect(text).toContain('/proposal-analysis');
    expect(text).toContain('本轮变更：');
    expect(text).toContain('+ 环境：Windows 11');
    expect(text).not.toContain(UNCHANGED_LINE);
    expect(text).not.toContain('正文快照');
    // 增量模板也必须已渲染（没有残留占位符）
    expect(text).not.toContain('{{');
  });
});

describe('上下文注入：contentDelta / isFirstEvent 真的有数据源', () => {
  it('后续轮：contentDelta 取自事件与载荷，isFirstEvent 渲染成 false', async () => {
    const ctx = v21RenderContextOf({
      repo: REPO,
      event: 'issues.edited',
      eventAction: 'edited',
      payload: editedPayload(),
      firstEvent: false,
    });
    expect(ctx.contentDelta).toContain('+ 环境：Windows 11');
    expect(ctx.firstEvent).toBe(false);
    // 数据源真接上了：渲染出的正文带增删行，且没有未知占位符
    const rendered = await renderTemplateAsync('{{issue.contentDelta}}', ctx);
    expect(rendered.text).toContain('- 环境：Windows 10');
    expect(rendered.unknown).toEqual([]);
  });

  it('首轮：contentDelta 是空串，isFirstEvent 渲染成 true', async () => {
    const ctx = v21RenderContextOf({
      repo: REPO,
      event: 'issues.edited',
      eventAction: 'edited',
      payload: editedPayload(),
      firstEvent: true,
    });
    expect(ctx.contentDelta).toBe('');
    expect((await renderTemplateAsync('{{issue.isFirstEvent}}', ctx)).text).toBe('true');
  });
});

/**
 * S2 的闭环：`turns` 的写回（`nextAgentTurns()`，在 `app/compose.ts`）与首轮判据
 * （`v21IsFirstEventOf()`，`turns <= 0`）必须是同一套语义。
 *
 * 两个方向的错都不会自己红：归零写成 `null` / 不归零 / 每轮都归零，症状都只是
 * 「agent 悄悄少了上下文」或「增量永不生效」。这里把**两次投递之间跑完一轮**这件事
 * 用可变会话行显式摆出来，并断言到 `agent_messages` 的正文上（可观察事实）。
 */
describe('S2 闭环：运行时重置 → turns 归零 → 下一条事件重新拿全文', () => {
  const settings = eventSettings('issues.edited', { enabled: 'on', prompt: null });

  it('重置前（有 5 轮）给增量；重置归零后给全文；那一轮跑完（turns=1）又回到增量', async () => {
    // 会话行：模拟 `agent_sessions.turns`，只有 `persistAgentSessionAfterRun()` 会改写它
    let turns: number | null = 5;
    const read = (): number | null => turns;

    // ① 重置前：历史里有 5 轮 → 后续轮 → 只有变更
    const before = await deliverEdited(settings, read);
    expect(before.c.bodies[0] ?? '').toContain('本轮变更：');
    expect(before.c.bodies[0] ?? '').not.toContain(UNCHANGED_LINE);

    // ② 运行时重置会话：`persistAgentSessionAfterRun()` 写回 turns=0
    turns = nextAgentTurns({ previousTurns: turns, sessionReset: true });
    expect(turns).toBe(0);
    // 判据立刻认这是首轮；正文必须是全文（新会话里没有任何历史）
    const afterReset = await deliverEdited(settings, read);
    const fullText = afterReset.c.bodies[0] ?? '';
    expect(fullText).toContain('正文快照');
    expect(fullText).toContain(UNCHANGED_LINE);
    expect(fullText).not.toContain('本轮变更：');

    // ③ 重置后的那一轮跑完：正常 +1（不是又归零），下一条事件回到后续轮
    turns = nextAgentTurns({ previousTurns: turns, sessionReset: false });
    expect(turns).toBe(1);
    const afterFirstTurn = await deliverEdited(settings, read);
    expect(afterFirstTurn.c.bodies[0] ?? '').toContain('本轮变更：');
    expect(afterFirstTurn.c.bodies[0] ?? '').not.toContain(UNCHANGED_LINE);
  });

  it('非 agent 任务不写会话行：`planAgentSession()` 给出的 session 是 undefined（persist 的早退条件）', () => {
    // `persistAgentSessionAfterRun()` 的第一句就是 `if (agentSession.session === undefined) return;`
    // 这里断言那个条件真的成立：非 agent 任务不该把 `turns` 推上去，否则会污染首轮判据。
    expect(planAgentSession({ session: null, isAgentTask: false }).session).toBeUndefined();
    expect(planAgentSession({ session: null, isAgentTask: true }).session).toBeDefined();
  });
});

describe('S5 连续事件：上一轮还没跑完时，每一条都按首轮给全文', () => {
  it('同一个 issue 连来两条 edited 投递（turns 始终是 0）→ 两次正文都含全文', async () => {
    const settings = eventSettings('issues.edited', { enabled: 'on', prompt: null });
    const c = createCaptures();
    // 上一轮还排在队列里没执行：没有任何人把 turns 加一，会话行一直是 0 轮
    const { db } = createFakeDb(settings, c, 0);

    await deliverWith(db, settings, c);
    await deliverWith(db, settings, c);

    expect(c.bodies).toHaveLength(2);
    for (const body of c.bodies) {
      expect(body).toContain('正文快照');
      expect(body).toContain(UNCHANGED_LINE);
      expect(body).not.toContain('本轮变更：');
    }
  });
});
