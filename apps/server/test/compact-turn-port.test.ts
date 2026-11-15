/**
 * `compact/turn-compaction.ts` + `compact/remind.ts` + `compact/window.ts` 的单测（FR-5.6 接线层）。
 *
 * 为什么要有这一层单独的用例：引擎（`compact-engine.test.ts`）证明的是「给定窗口与历史，
 * 六阶降级怎么走」；这里证明的是**接线**——宿主快照能不能变成消息、什么时候拒发、
 * 提示词到底变成什么样、提醒是不是只响一次。两层混测会让「引擎对但没接上」照样绿。
 *
 * 断言口径遵守 AGENTS §6：只断言可观察事实（提示词文本、落库记录、返回值），
 * 不用快照、不用假时钟、不用 `vi.mock`（依赖全是构造注入的假件）。
 */
import { describe, expect, it } from 'vitest';

import { createCompactor } from '../src/compact/engine.ts';
import type { CompactDeps, CompactInput, CompactionRecordInput, CompactStore } from '../src/compact/engine.ts';
import { estimateMessagesTokens } from '../src/compact/tokens.ts';
import type { MessageLike } from '../src/compact/tokens.ts';
import {
  COMPACTION_LIMIT_CODE,
  composeRebuildText,
  composeTurnText,
  createTurnCompaction,
  createUnavailableSummarize,
  messagesFromSnapshotItems,
} from '../src/compact/turn-compaction.ts';
import type { TurnCompactionRequest } from '../src/compact/turn-compaction.ts';
import { createReminderLedger, planReminderTier, takeReminder } from '../src/compact/remind.ts';
import { FALLBACK_WINDOW_TOKENS, resolveModelWindow } from '../src/compact/window.ts';
import type { ResolvedWindow } from '../src/compact/window.ts';

/* ── 假件 ─────────────────────────────────────────────────────────────────── */

type FakeStore = CompactStore & { readonly rows: CompactionRecordInput[] };

function createFakeStore(): FakeStore {
  const rows: CompactionRecordInput[] = [];
  return {
    rows,
    async record(record) {
      rows.push(record);
    },
    async latestGeneration(sessionId) {
      return rows.filter((row) => row.sessionId === sessionId).length;
    },
  };
}

/** 摘要永远失败（模拟「本进程没有摘要模型客户端」），且按致命处理 → 立刻走阶 5 兜底。 */
function unavailableDeps(store: CompactStore, sleeps: number[] = []): CompactDeps {
  return {
    summarize: createUnavailableSummarize('测试：没有摘要模型'),
    store,
    isFatal: () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

function request(overrides: Partial<TurnCompactionRequest> = {}): TurnCompactionRequest {
  return {
    sessionId: 'session-1',
    turnText: '本轮任务：把 P0-1 的遗留风险讲清楚',
    history: [],
    historyComplete: true,
    ...overrides,
  };
}

/** 造一段必定过自动压缩线的历史（ASCII 4 字符 ≈ 1 token）。 */
function heavyHistory(): MessageLike[] {
  const filler = 'a'.repeat(30_000);
  return [
    { role: 'user', content: `goal: 修 docs/requirements.html 与 src/compact/engine.ts 的 FR-5.6 ${filler}` },
    // 带 toolCalls 才是「有主的工具结果」：`stripOrphanToolResults()` 会剔掉查不到调用方的
    // toolResult，没有这一行，AC-24 用例断的「报错原文出现在重建视图里」就永远不成立。
    {
      role: 'assistant',
      content: `progress: 已改 src/compact/engine.ts ${filler}`,
      toolCalls: [{ id: 'call-1', name: 'Bash' }],
    },
    {
      role: 'tool',
      content: `error: TypeError: cannot read 'x' at compact/engine.ts:436 ${filler}`,
      toolCallId: 'call-1',
      toolName: 'Bash',
    },
    { role: 'assistant', content: 'continue' },
  ];
}

/**
 * 显式给一个「已命中模型表的 32K 窗口」（`matched: true` → `resolveCompactionBudget()` 不再抬预算）。
 *
 * 为什么不用 `resolveModelWindow('some-private-model')` 表示「窄窗口」：未命中表时
 * `resolveCompactionBudget()` 会把压缩预算抬到 128K（`window.ts` 的裁决：32K−16K 预留只剩
 * 16.7K，等于把 1M 模型压到 1.5%）。本组用例要证明的是「**窗口决定阈值**」，
 * 所以窗口必须是查出来的真值，而不是「没认出来」的那个猜测。
 */
function narrowWindow(): ResolvedWindow {
  return { tokens: 32_768, family: 'test-32k', model: 'test-32k-matched', matched: true };
}

/* ── 窗口：从模型名现算 ───────────────────────────────────────────────────── */

describe('resolveModelWindow · 窗口从模型名现算（FR-5.6「触发」第一条）', () => {
  it('已知模型按表命中，未知模型退保守下限（永不返回 0 / 负数）', () => {
    expect(resolveModelWindow('gpt-4.1-mini')).toMatchObject({ tokens: 1_000_000, matched: true });
    expect(resolveModelWindow('claude-sonnet-4-20250514')).toMatchObject({ tokens: 200_000, matched: true });
    expect(resolveModelWindow('deepseek-chat')).toMatchObject({ tokens: 64_000, matched: true });

    const unknown = resolveModelWindow('some-private-model-v9');
    expect(unknown).toMatchObject({ tokens: FALLBACK_WINDOW_TOKENS, matched: false, family: null });
    expect(resolveModelWindow(null)).toMatchObject({ tokens: FALLBACK_WINDOW_TOKENS, model: null });
    expect(resolveModelWindow('   ').tokens).toBe(FALLBACK_WINDOW_TOKENS);
  });
});

/* ── 快照 → 消息 ──────────────────────────────────────────────────────────── */

describe('messagesFromSnapshotItems · 宿主快照还原成压缩输入', () => {
  it('跳过宿主自己的 compact 标记，抽取正文 / 工具名 / callId', () => {
    const messages = messagesFromSnapshotItems([
      { itemType: 'message', content: { role: 'user', text: '第一句' } },
      { itemType: 'message', content: { role: 'assistant', text: '收到', thinking: '想一想' } },
      { itemType: 'tool', content: { toolCallId: 'call-9', toolName: 'Read', output: 'file body' } },
      { itemType: 'compaction', content: { text: '这是宿主自己的压缩摘要' } },
      { itemType: 'message', content: { text: '   ' } },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: '第一句' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '收到', thinking: '想一想' });
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'file body', toolCallId: 'call-9', toolName: 'Read' });
    // compact 标记不能变成「一条要总结的消息」，否则摘要会去总结摘要
    expect(messages.some((message) => message.content.includes('宿主自己的压缩摘要'))).toBe(false);
  });

  it('part 数组与未知形状都不炸：能抠就抠，抠不出就跳过', () => {
    const messages = messagesFromSnapshotItems([
      { itemType: 'message', content: [{ text: '前半' }, { text: '后半' }] },
      { itemType: 'message', content: { weird: { nested: true } } },
      { itemType: 'message', content: 42 },
    ]);
    expect(messages[0]?.content).toBe('前半\n后半');
    // 第三四条：一条退化成 JSON（有信息就留着），一条彻底空 → 跳过
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toContain('nested');
  });

  it('助手消息的 toolCalls 被保留（否则算不出孤儿 toolResult）', () => {
    const messages = messagesFromSnapshotItems([
      { itemType: 'message', content: { role: 'assistant', text: '我读一下', toolCalls: [{ id: 'call-1', name: 'Read' }] } },
    ]);
    expect(messages[0]?.toolCalls).toEqual([{ id: 'call-1', name: 'Read' }]);
  });
});

/* ── 提示词拼装 ───────────────────────────────────────────────────────────── */

describe('composeTurnText · 拼装规则', () => {
  it('没有 checkpoint / 提醒时逐字节返回原文（= 接线前的行为）', () => {
    expect(composeTurnText({ turnText: '原文' })).toBe('原文');
    expect(composeTurnText({ turnText: '原文', checkpoint: null, reminder: null })).toBe('原文');
    // 空摘要不产生空标题块
    expect(composeTurnText({ turnText: '原文', checkpoint: { generation: 1, summary: '   ', fallback: false } })).toBe(
      '原文',
    );
  });

  it('兜底 checkpoint 不许说「旧历史已不在上下文里」（历史其实一条没少）', () => {
    const text = composeTurnText({
      turnText: '原文',
      checkpoint: { generation: 2, summary: '## 目标\n修 FR-5.6', fallback: true },
    });
    expect(text).toContain('第 2 代（兜底 · 规则化留存）');
    expect(text).toContain('会话历史本身没有丢');
    expect(text).not.toContain('旧历史已不在本次上下文中');
    expect(text.endsWith('原文')).toBe(true);
  });

  it('正常压缩才写「窗口之外的旧历史已不在上下文中」', () => {
    const text = composeTurnText({
      turnText: '原文',
      checkpoint: { generation: 1, summary: '## 目标\n修 FR-5.6', fallback: false },
    });
    expect(text).toContain('第 1 代（自动压缩）');
    expect(text).toContain('窗口之外的旧历史已不在本次上下文中');
  });
});

/* ── 两档临边提醒 ─────────────────────────────────────────────────────────── */

describe('两档临边提醒（FR-5.6「触发」末条）', () => {
  it('两档阈值都在自动压缩线（0.9）以下，且高档优先', () => {
    const hardLimit = 10_000;
    expect(planReminderTier(7_000, hardLimit)).toBe('none');
    expect(planReminderTier(7_500, hardLimit)).toBe('room'); // 0.75
    expect(planReminderTier(8_500, hardLimit)).toBe('save-now'); // 0.85
    expect(planReminderTier(9_000, hardLimit)).toBe('save-now'); // 已过自动线也只能报末档
    expect(planReminderTier(9_000, 0)).toBe('none');
  });

  it('每档只响一次：同一会话两次越线只提醒一次', () => {
    const ledger = createReminderLedger();
    const facts = { currentTokens: 8_000, hardLimit: 10_000 };
    const first = takeReminder({ sessionId: 's1', facts, ledger });
    const second = takeReminder({ sessionId: 's1', facts, ledger });
    expect(first?.tier).toBe('room');
    expect(second).toBeNull();
    // 换个会话照常提醒（台账按 sessionId 分）
    expect(takeReminder({ sessionId: 's2', facts, ledger })?.tier).toBe('room');
  });

  it('文案给出剩余量，末档要求把必须留存的写下来', () => {
    const ledger = createReminderLedger();
    const room = takeReminder({ sessionId: 's1', facts: { currentTokens: 8_000, hardLimit: 10_000 }, ledger });
    expect(room?.text).toContain('还剩约 2000 token');

    const saveNow = takeReminder({ sessionId: 's1', facts: { currentTokens: 9_500, hardLimit: 10_000 }, ledger });
    expect(saveNow?.tier).toBe('save-now');
    expect(saveNow?.text).toContain('现在就');
    expect(saveNow?.text).toContain('报错原文');
  });
});

/* ── 端口：请求前到底发什么 ───────────────────────────────────────────────── */

describe('createTurnCompaction · 请求前检查', () => {
  it('没有历史（ephemeral / 本轮新建会话）：提示词一个字节都不改，不查库', async () => {
    const store = createFakeStore();
    const port = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 1,
      compact: createCompactor(unavailableDeps(store)),
      window: resolveModelWindow('some-private-model'),
    });

    const outcome = await port(request({ history: [] }));
    expect(outcome).toEqual({ send: true, text: '本轮任务：把 P0-1 的遗留风险讲清楚', note: null, reminder: null });
    expect(store.rows).toHaveLength(0);
  });

  it('未过自动线：照发原文；落在提醒档位时只加提醒（不压缩）', async () => {
    const outcome = await createTurnCompaction({
      repo: 'o/r',
      issueNumber: 1,
      window: resolveModelWindow('some-private-model'),
      // 假引擎：明确「below」，但已用 8000 / 硬边界 10000 → 第一档提醒
      compact: async (input: CompactInput) => ({
        compacted: false,
        reason: 'below',
        beforeTokens: input.messages.length > 0 ? 8_000 : 0,
        plan: { needed: false, hardLimit: 10_000, autoLimit: 9_000, currentTokens: 8_000, generation: 0, reason: 'below' },
        layers: ['precheck'],
      }),
    })(request({ history: [{ role: 'user', content: 'hi' }] }));

    expect(outcome.send).toBe(true);
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    expect(outcome.note).toBeNull();
    expect(outcome.reminder).toBe('room');
    expect(outcome.text).toContain('【上下文预算提醒】');
    expect(outcome.text.endsWith('本轮任务：把 P0-1 的遗留风险讲清楚')).toBe(true);
  });

  it('过自动线：追加一条 checkpoint（兜底 fallback=true），并要求换会话重建视图', async () => {
    const store = createFakeStore();
    const sleeps: number[] = [];
    const port = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      compact: createCompactor(unavailableDeps(store, sleeps)),
      window: narrowWindow(),
    });

    const history = heavyHistory();
    const before = JSON.stringify(history);
    const outcome = await port(request({ sessionId: 'session-9', history }));

    expect(outcome.send).toBe(true);
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    // AC-25：压缩记录可查（前后 token / 摘要长度 / 是否兜底 / 第几代）
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ repo: 'o/r', issueNumber: 7, sessionId: 'session-9', generation: 1, fallback: true });
    expect(store.rows[0]?.beforeTokens ?? 0).toBeGreaterThan(store.rows[0]?.afterTokens ?? 0);
    expect(store.rows[0]?.summaryChars ?? 0).toBeGreaterThan(0);

    expect(outcome.note).toMatchObject({ fallback: true, generation: 1, historyComplete: true });
    expect(outcome.note?.layers).toContain('fallback');
    // 致命摘要错误不该触发 2/4/8 秒退避
    expect(sleeps).toEqual([]);

    // 退路正文（换会话失败时用）：checkpoint 前缀 + 兜底措辞 + 原文保留在末尾
    expect(outcome.text).toContain('第 1 代（兜底 · 规则化留存）');
    expect(outcome.text).toContain('会话历史本身没有丢');
    expect(outcome.text.endsWith('本轮任务：把 P0-1 的遗留风险讲清楚')).toBe(true);

    // 主路径：这一轮的 checkpoint 以「换会话重建」的形态发出去（FR-5.6「喂给模型的内容 =
    // 从最新 checkpoint 重建」）—— 重建正文里是摘要 + 保留的真实最近消息，不是「全量历史 + 附言」。
    const rebuild = outcome.rebuild;
    expect(rebuild).toBeDefined();
    expect(rebuild?.recentMessages ?? 0).toBeGreaterThan(0);
    expect(rebuild?.tokens ?? 0).toBeGreaterThan(0);
    expect(rebuild?.text).toContain('第 1 代（兜底 · 规则化留存）');
    expect(rebuild?.text).toContain('本次请求的上下文由这份**兜底** checkpoint 重建');
    expect(rebuild?.text).toContain('【重建视图 · 保留的真实最近消息（原样，未改写）】');
    expect(rebuild?.text.endsWith('本轮任务：把 P0-1 的遗留风险讲清楚')).toBe(true);
    // 判硬边界用的是「真正发出去的包」：32K 窗口 → hardLimit 16_768
    expect(rebuild?.tokens ?? 0).toBeLessThan(16_768);
    // 重建视图不许说「历史没丢」——新会话里它就是没有旧历史（原始记录在后台）
    expect(rebuild?.text).not.toContain('会话历史本身没有丢');

    // 追加不改写：传进来的历史一条不删、一字不改
    expect(JSON.stringify(history)).toBe(before);
  });

  it('兜底 checkpoint 原样保留精确路径与报错原文（AC-24 的最小证据）', async () => {
    const store = createFakeStore();
    const port = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      compact: createCompactor(unavailableDeps(store)),
      window: narrowWindow(),
    });

    const outcome = await port(request({ history: heavyHistory() }));
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    // 系统抠出的文件清单（不依赖模型记忆）必须逐字出现 —— 前缀退路与重建视图两处都要有，
    // 否则「换会话后模型看不到路径」等于把 AC-24 的最小证据丢在退路上。
    expect(outcome.text).toContain('src/compact/engine.ts');
    expect(outcome.text).toContain('docs/requirements.html');
    expect(outcome.rebuild?.text).toContain('src/compact/engine.ts');
    expect(outcome.rebuild?.text).toContain('docs/requirements.html');
    // 报错原文（工具结果）若落在保留窗口里，必须逐字出现在重建视图中
    expect(outcome.rebuild?.text).toContain("TypeError: cannot read 'x'");
  });

  it('硬边界：拒绝发送（send=false + 明确原因），且不返回任何提示词', async () => {
    const outcome = await createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      window: resolveModelWindow('some-private-model'),
      compact: async () => ({
        compacted: false,
        reason: 'hard-limit',
        beforeTokens: 20_000,
        plan: { needed: true, hardLimit: 16_768, autoLimit: 15_091, currentTokens: 20_000, generation: 1, reason: 'hard' },
        layers: ['precheck', 'fallback', 'hard-limit'],
        error: '压缩后仍超硬边界（hardLimit=16768），拒绝发送请求',
      }),
    })(request({ history: heavyHistory(), historyComplete: false }));

    expect(outcome.send).toBe(false);
    if (outcome.send) {
      throw new Error('应当拒发');
    }
    expect(outcome.code).toBe(COMPACTION_LIMIT_CODE);
    expect(outcome.message).toContain('硬边界');
    expect(outcome.details).toMatchObject({ hardLimit: 16_768, historyComplete: false });
  });

  it('压缩器自己抛错：按原文发送 + 记 warn（不把任务判死）', async () => {
    const warns: string[] = [];
    const outcome = await createTurnCompaction({
      repo: 'o/r',
      issueNumber: 1,
      window: resolveModelWindow('some-private-model'),
      compact: async () => {
        throw new Error('store down');
      },
      logger: {
        warn: (_detail, message) => {
          warns.push(message);
        },
      },
    })(request({ history: heavyHistory() }));

    expect(outcome).toMatchObject({ send: true, note: null, reminder: null });
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    expect(outcome.text).toBe('本轮任务：把 P0-1 的遗留风险讲清楚');
    expect(warns).toEqual(['压缩检查点失败（按原文发送本轮请求）']);
  });

  it('窗口来自模型名：1M 窗口下同一段历史不该触发压缩', async () => {
    const store = createFakeStore();
    const port = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 1,
      compact: createCompactor(unavailableDeps(store)),
      window: resolveModelWindow('gpt-4.1'),
    });
    const history = heavyHistory();
    // 先确认这段历史确实过了 32K 窗口的自动线（否则这条用例证明不了「窗口决定阈值」）。
    // 窄窗口必须是**查出来的真值**，不是「没认出来」的猜测 —— 见 `narrowWindow()` 的注释。
    const narrow = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 1,
      compact: createCompactor(unavailableDeps(createFakeStore())),
      window: narrowWindow(),
    });
    const narrowOutcome = await narrow(request({ history }));
    expect(narrowOutcome.send && narrowOutcome.note !== null).toBe(true);

    const wideOutcome = await port(request({ history }));
    expect(wideOutcome).toMatchObject({ send: true, note: null });
    expect(store.rows).toHaveLength(0);
    expect(estimateMessagesTokens(history)).toBeLessThan(1_000_000);
    // 1M 窗口下连重建都不该被要求（没压缩就没有 checkpoint）
    expect(wideOutcome.send && wideOutcome.rebuild === undefined).toBe(true);
  });

  it('换会话重建视图：保留最近真实消息、不含窗口外的旧原文、原历史一字不改', async () => {
    const store = createFakeStore();
    const port = createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      compact: createCompactor(unavailableDeps(store)),
      window: narrowWindow(),
    });

    // 窗口外的旧细节放在首条用户消息的 400 字之后：兜底摘要只摘录前 400 字，
    // 只要它没进「保留的真实最近窗口」，重建视图里就不该出现它。
    const filler = 'a'.repeat(30_000);
    const history: MessageLike[] = [
      {
        role: 'user',
        content: `goal: 修 src/compact/engine.ts 的 FR-5.6 ${'a'.repeat(2_000)} OLD-DETAIL-XYZZY ${filler}`,
      },
      { role: 'assistant', content: `progress: 已改 src/compact/engine.ts ${filler}` },
      { role: 'tool', content: `error: boom ${filler}`, toolCallId: 'call-1', toolName: 'Bash' },
      { role: 'assistant', content: 'RECENT-REAL-MESSAGE：已定位 src/compact/engine.ts:436' },
    ];
    const before = JSON.stringify(history);

    const outcome = await port(request({ sessionId: 'session-9', history }));
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    const rebuild = outcome.rebuild;
    expect(rebuild).toBeDefined();
    // 摘要进重建视图（兜底：首条用户消息摘录 + 系统抠出的文件清单）
    expect(rebuild?.text).toContain('goal: 修 src/compact/engine.ts');
    // 最近的真实消息原样保留（含助手正文，不是只丢一份摘要进去）
    expect(rebuild?.text).toContain('RECENT-REAL-MESSAGE');
    // 窗口之外的旧原文不在重建视图里 —— 这正是「重建」与「前缀」的区别
    expect(rebuild?.text).not.toContain('OLD-DETAIL-XYZZY');
    // 追加不改写：传进来的历史一条不删、一字不改（后台视图仍是完整对话）
    expect(JSON.stringify(history)).toBe(before);
  });

  it('重建视图自己超硬边界：拒绝发送（判据是发出去的包，不是假想视图）', async () => {
    const outcome = await createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      window: narrowWindow(),
      compact: async () => ({
        compacted: true,
        summary: '## 目标\n修 FR-5.6',
        generation: 1,
        beforeTokens: 20_000,
        // 假想视图的 token 报得很小（3_000），但真正的重建正文会远超硬边界
        afterTokens: 3_000,
        fallback: false,
        layers: ['precheck', 'summary:l1'],
        plan: { needed: true, hardLimit: 16_768, autoLimit: 15_091, currentTokens: 20_000, generation: 1, reason: 'hard' },
        view: {
          summary: '## 目标\n修 FR-5.6',
          messages: [{ role: 'assistant', content: 'x'.repeat(100_000) }],
        },
      }),
    })(request({ history: heavyHistory() }));

    expect(outcome.send).toBe(false);
    if (outcome.send) {
      throw new Error('应当拒发');
    }
    expect(outcome.code).toBe(COMPACTION_LIMIT_CODE);
    expect(outcome.message).toContain('硬边界');
    expect(outcome.message).toContain('重建视图');
    expect(outcome.details).toMatchObject({ hardLimit: 16_768 });
    expect(outcome.details['rebuiltTokens']).toBeGreaterThan(16_768);
  });

  it('重建视图超界但前缀路径还没越线：退回前缀、不要求换会话', async () => {
    const outcome = await createTurnCompaction({
      repo: 'o/r',
      issueNumber: 7,
      window: narrowWindow(),
      compact: async () => ({
        compacted: true,
        summary: '## 目标\n修 FR-5.6',
        generation: 1,
        // 宿主历史只有 1_000 token：前缀路径的真实包仍然安全
        beforeTokens: 1_000,
        afterTokens: 3_000,
        fallback: false,
        layers: ['precheck', 'summary:l1'],
        plan: { needed: true, hardLimit: 16_768, autoLimit: 15_091, currentTokens: 20_000, generation: 1, reason: 'hard' },
        view: {
          summary: '## 目标\n修 FR-5.6',
          messages: [{ role: 'assistant', content: 'x'.repeat(100_000) }],
        },
      }),
    })(request({ history: heavyHistory() }));

    expect(outcome.send).toBe(true);
    if (!outcome.send) {
      throw new Error('应当照发');
    }
    expect(outcome.rebuild).toBeUndefined();
    expect(outcome.text).toContain('第 1 代（自动压缩）');
    expect(outcome.text.endsWith('本轮任务：把 P0-1 的遗留风险讲清楚')).toBe(true);
  });
});

describe('composeRebuildText · 重建视图拼装', () => {
  it('最近窗口为空时不写「重建视图」段，且敢说「旧对话不在上下文里」', () => {
    const text = composeRebuildText({
      turnText: '本轮任务：继续',
      checkpoint: { generation: 2, summary: '## 目标\n修 FR-5.6', fallback: false },
      recent: [],
    });
    expect(text).not.toContain('【重建视图');
    expect(text).toContain('窗口之外的旧对话已不在本次上下文中');
    expect(text.endsWith('【本轮任务】\n本轮任务：继续')).toBe(true);
  });

  it('兜底摘要必须点破「约束/决策两栏是空的」，别让模型当成没有约束', () => {
    const text = composeRebuildText({
      turnText: '继续',
      checkpoint: { generation: 1, summary: '## 目标\n修 FR-5.6', fallback: true },
      recent: [{ role: 'tool', content: '', toolCallId: 'c1', toolName: 'Bash' }],
    });
    expect(text).toContain('兜底');
    expect(text).toContain('「约束与偏好」「关键决策」两栏空着');
    // 正文为空但有工具元信息时，模型至少要知道这段是什么
    expect(text).toContain('工具结果 · Bash · c1');
  });
});
