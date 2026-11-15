/**
 * 两档临边提醒（FR-5.6「触发」末条）：临近边界时提前提醒模型收尾，每档只响一次。
 *
 * 两档的措辞不同，因为模型要做的动作不同：
 *  - 第一档 `room`：告诉它「还能用多少」——目的只是让它别再无谓地全文件重读、赶紧收敛；
 *  - 第二档 `save-now`：逼近自动压缩线，这时唯一的正确动作是**把必须留存的写下来**
 *    （精确路径、函数名、报错原文、未完成项、下一步）。写下来的东西进摘要，没写下来的
 *    只能靠摘要去猜——这正是 FR-5.6 保留策略那段「摘要一旦漏掉一段报错原文，模型只能
 *    重新读文件重跑命令」要避免的事。
 *
 * 为什么两档都在自动压缩线（0.9×hardLimit）**以下**：提醒要在压缩之前到达模型手里，
 * 与压缩同一轮到达时它已经没机会「先把内容写下来」了。
 *
 * 为什么「每档只响一次」需要一个台账而不是每次现算：这是**跨轮次**的事实（这一档以前响过没有），
 * 而阈值判定是单轮的。台账默认放内存（`createReminderLedger()`）：
 *  - 它只承载一段**建议性文案**的去重，不是副作用幂等（重复一次提醒的代价 = 模型多收一段提醒，
 *    与 AGENTS §9 禁止的「队列内存去重表」不是同一类东西）；
 *  - 代价是进程重启后同一档可能再响一次，可接受。
 * TODO(FR-5.6): 若要求「重启后也绝不重复」，需要在 `agent_compactions` 同批迁移里加一列
 * `reminders text[]`（属 schema 工作包的范围，本包不改 schema）。
 *
 * 纯函数 + 一个可注入的小状态对象：提醒口径必须能被单测逐个阈值钉住。
 */

/** 两档的触发比例（相对硬边界 `hardLimit`）。 */
export const REMINDER_RATIOS = {
  /** 第一档：还能用多少 */
  room: 0.75,
  /** 第二档：现在就把必须留存的写下来（仍低于自动压缩线 0.9） */
  saveNow: 0.85,
} as const;

/** 台账里最多记多少条（会话永久存在，必须给上界，否则长跑进程会无限涨）。 */
export const REMINDER_LEDGER_LIMIT = 4_096;

export type ReminderTier = 'room' | 'save-now';

export type ReminderTierDecision = ReminderTier | 'none';

/**
 * 这一轮的用量落在哪一档。
 *
 * 判定顺序是**从高到低**：已过第二档就不能只报第一档（那会让模型以为还很宽裕）。
 * `hardLimit <= 0`（配置异常）一律不提醒——提醒里要写「还剩多少」，算不出剩余量就不该说。
 */
export function planReminderTier(currentTokens: number, hardLimit: number): ReminderTierDecision {
  if (!Number.isFinite(hardLimit) || hardLimit <= 0) {
    return 'none';
  }
  if (!Number.isFinite(currentTokens) || currentTokens <= 0) {
    return 'none';
  }
  if (currentTokens >= Math.trunc(REMINDER_RATIOS.saveNow * hardLimit)) {
    return 'save-now';
  }
  if (currentTokens >= Math.trunc(REMINDER_RATIOS.room * hardLimit)) {
    return 'room';
  }
  return 'none';
}

/** 提醒文案要用的两个数字（都由调用方从 `planCompaction` 的结果里取，不自己重算口径）。 */
export type ReminderFacts = {
  /** 当前已用（估算）token */
  readonly currentTokens: number;
  /** 硬边界（安全预算）token */
  readonly hardLimit: number;
};

/** 剩余可用量（夹到 0：过线之后「还剩负数」没有意义）。 */
export function remainingTokens(facts: ReminderFacts): number {
  return Math.max(0, Math.trunc(facts.hardLimit) - Math.trunc(facts.currentTokens));
}

/**
 * 渲染提醒块。
 *
 * 为什么把「安全预算」这个词也写进去：模型看到的具体数字如果和它自己算的不一致（token 估算
 * 差几个百分点是常态），至少能知道这是宿主侧的估算，而不是它的错。
 */
export function renderReminder(tier: ReminderTier, facts: ReminderFacts): string {
  const remaining = remainingTokens(facts);
  const used = Math.trunc(facts.currentTokens);
  const limit = Math.trunc(facts.hardLimit);

  if (tier === 'save-now') {
    return [
      '【上下文预算提醒 · 末档】',
      `本会话已用约 ${String(used)} token，距安全预算（${String(limit)}）只剩约 ${String(remaining)} token。`,
      '现在就把必须留存的写下来，别再做探索性操作：',
      '1. 已确认的精确文件路径、函数名、行号、报错原文（照抄，不要概括）；',
      '2. 已完成 / 进行中 / 受阻分别是什么，卡在哪一步；',
      '3. 下一步要做什么，以及为什么这么定（含已否决的方案）。',
      '超出安全预算后本会话会自动压缩：写下来的会进摘要，没写下来的会丢。',
    ].join('\n');
  }

  return [
    '【上下文预算提醒】',
    `本会话已用约 ${String(used)} token，距安全预算（${String(limit)}）还剩约 ${String(remaining)} token。`,
    '请开始收尾：优先复用已知信息，不要重复整文件读取或重跑同一条命令；',
    '需要保留的事实请写进正文（精确路径、函数名、报错原文照抄），不要只留在推理里。',
  ].join('\n');
}

/**
 * 「这一档响过没有」的台账。
 *
 * `claim(key)` 语义：**第一次见到这个 key 返回 true**（= 该响），之后返回 false。
 * 刻意做成「claim 即记账」而不是「查一次 + 记一次」两个方法：两步之间夹一次异步就能
 * 同一档响两次，而这里的正确性完全建立在「判定与记账是同一步」上。
 */
export type ReminderLedger = {
  claim(key: string): boolean;
  /** 已记多少条（观测与测试用） */
  readonly size: number;
};

/** 提醒台账的 key（会话 + 档位；会话永久存在，所以「只响一次」就是字面意思）。 */
export function reminderKey(sessionId: string, tier: ReminderTier): string {
  return `${sessionId}:${tier}`;
}

/** 默认台账：有界 FIFO（超上限就丢最老的，宁可多响一次也不无限涨内存）。 */
export function createReminderLedger(limit: number = REMINDER_LEDGER_LIMIT): ReminderLedger {
  const max = Math.max(1, Math.trunc(limit));
  // Set 的插入序即迭代序：第一个元素就是最老的那条
  const seen = new Set<string>();

  return {
    claim(key: string): boolean {
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      if (seen.size > max) {
        const oldest = seen.values().next();
        if (oldest.done !== true) {
          seen.delete(oldest.value);
        }
      }
      return true;
    },
    get size(): number {
      return seen.size;
    },
  };
}

/**
 * 这一轮该不该提醒、提醒什么。
 *
 * 台账在这里被消费（`claim`），所以调用方只需把返回值拼进提示词 —— 把「判定 + 记账 + 渲染」
 * 合成一个函数，是为了避免「判定过了但忘了记账」导致每轮都响。
 * `allow=false`（例如这一轮不打算发提醒）时**不**占用台账，避免白白消耗掉唯一一次机会。
 */
export function takeReminder(input: {
  readonly sessionId: string;
  readonly facts: ReminderFacts;
  readonly ledger: ReminderLedger;
  readonly allow?: boolean;
}): { readonly tier: ReminderTier; readonly text: string } | null {
  if (input.allow === false) {
    return null;
  }
  const tier = planReminderTier(input.facts.currentTokens, input.facts.hardLimit);
  if (tier === 'none') {
    return null;
  }
  if (!input.ledger.claim(reminderKey(input.sessionId, tier))) {
    return null;
  }
  return { tier, text: renderReminder(tier, input.facts) };
}
