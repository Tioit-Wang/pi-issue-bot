/**
 * 模型参数（上下文窗口 / 单次输出上限）的来源与匹配（`CFG-8.1`「该家可用的 model 列表」扩展）。
 *
 * 两个来源，按可信度排序：
 *
 *   1. **联网**：OpenRouter 公共模型库（`GET https://openrouter.ai/api/v1/models`，无需 key）。
 *      一条模型给 `context_length` 与 `top_provider.max_completion_tokens`——这正是面板上
 *      要填的那两个数字，且是「谁在跑这个模型」自己报的，比按名字猜准得多。
 *   2. **内置兜底表**（`KNOWN_MODEL_PARAMETERS`）：当前**只覆盖 DeepSeek v4 系与 MiMo v2.6 系**
 *      （产品范围就这两族）。值取自 2026-11-16 的同一份公共库，目的是断网时也能填上，
 *      并在结果里用 `source: 'table'` 明说「这不是刚查到的」。
 *
 * 两处都没有 → 不写（`undefined`），面板显示「未知」。**绝不猜一个数字**：
 * 猜大了压缩不触发 → provider 400；猜小了每轮都压缩（`compact/window.ts` 的老图就是后者：
 * 它把 `deepseek` 全族按 64K 算，而实测 deepseek-v4.1-flash 是 1M 上下文 / 393K 输出）。
 *
 * 纯函数、零 I/O：取数在 `http/api/settings.ts` 里注入（`fetch` 或测试假件），
 * 匹配与解析在这里，能被单测逐个钉住。
 */

/**
 * 内置兜底表的一行。
 *
 * `pattern` 匹配**归一化后的模型名**（去掉 `vendor/` 前缀、小写）。只写确定的事实：
 * 不确定的家族宁可不在表里（结果显示「未知」），也不要写一个猜的数字。
 */
export type KnownModelParameterRule = {
  readonly pattern: RegExp;
  /** 上下文窗口（token）。 */
  readonly contextWindow: number;
  /** 单次输出上限（token）。 */
  readonly maxOutputTokens: number;
  /** 便于日志与测试断言的家族名。 */
  readonly family: string;
};

/**
 * 兜底表：只覆盖当前产品范围内的两族最新（DeepSeek v4 系 / MiMo v2.6 系）。
 *
 * 值与 OpenRouter 公共库 2026-11 一致：
 *  - `deepseek/deepseek-v4.1-flash` → ctx 1,048,576 / maxOut 393,216
 *  - `deepseek/deepseek-v4-pro`     → ctx 1,048,576 / maxOut 393,216
 *  - `xiaomi/mimo-v2.6-pro`         → ctx 1,050,000 / maxOut 131,072
 *
 * 为什么 `deepseek-v4` 用 1M 而不是官方文档常写的 128K/64K：那份是 chat/r1 老系列的窗口，
 * v4 系（含 v4.1-flash）是 1M。混写会把预算压到真实能力的 1/16。
 */
export const KNOWN_MODEL_PARAMETERS: readonly KnownModelParameterRule[] = [
  {
    pattern: /^deepseek-v4(?:[.-]\d)?(?:-(?:flash|pro|latest))*$/i,
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    family: 'deepseek-v4',
  },
  {
    pattern: /^mimo-v2\.6(?:-(?:pro|flash|ultraspeed))*$/i,
    contextWindow: 1_050_000,
    maxOutputTokens: 131_072,
    family: 'mimo-v2.6',
  },
];

/** OpenRouter 的一条模型（只留本模块需要的字段；其余字段解析时丢掉）。 */
export type CatalogEntry = {
  /** 外部 id，形如 `deepseek/deepseek-v4.1-flash`。 */
  readonly id: string;
  readonly contextLength: number | null;
  readonly maxCompletionTokens: number | null;
};

/** 一条查询结果（与契约 `ModelParameterLookup` 同形；本模块不反向依赖契约层）。 */
export type ModelParameterResult = {
  readonly model: string;
  readonly found: boolean;
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly source: 'openrouter' | 'table' | 'none';
  readonly matchedId: string | null;
  readonly error: string | null;
};

/** 模型名归一化：去掉 `vendor/` 前缀与 `:batch` 之类的尾部变体标记，再小写。 */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const withoutVariant = trimmed.split(':')[0] ?? trimmed;
  const slash = withoutVariant.lastIndexOf('/');
  return slash === -1 ? withoutVariant : withoutVariant.slice(slash + 1);
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

/**
 * OpenRouter `/models` 响应 → 条目数组。
 *
 * 逐条**只认**能解析成形状的：一条坏数据不该让整次查询失败（与 `parseModelCatalog()` 同一条原则）。
 * 缺 `context_length` 的条目仍然保留（`contextLength: null`）——它至少能证明「这个模型在库里」，
 * 面板可以说「查到了模型但没有窗口字段」，那比「查不到」更有用。
 */
export function parseOpenRouterPayload(payload: unknown): CatalogEntry[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const entries: CatalogEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'] : null;
    if (id === null || id === '') continue;
    const topProvider = record['top_provider'];
    const maxOut =
      typeof topProvider === 'object' && topProvider !== null
        ? positiveInt((topProvider as Record<string, unknown>)['max_completion_tokens'])
        : null;
    entries.push({
      id,
      contextLength: positiveInt(record['context_length']),
      maxCompletionTokens: maxOut,
    });
  }
  return entries;
}

/**
 * 在库里找这个模型。
 *
 * 三段式（都由 `normalizeModelName` 归一化后比较）：
 *  1. **完全相等** —— 唯一可信的匹配；
 *  2. 候选以我们的名字**开头**（`deepseek-v4.1-flash` → `deepseek-v4.1-flash-1017`，
 *     OpenRouter 给带日期的快照另开一条）；多个候选取**最短**的那个（最接近原始名）；
 *  3. 都没有 → `null`（不猜）。
 *
 * 为什么不反向 `includes`：`mimo-v2.5` 会命中 `mimo-v2.5-pro`，把 pro 的窗口安到标准版上。
 */
export function matchCatalogEntry(
  entries: readonly CatalogEntry[],
  modelName: string,
): CatalogEntry | null {
  const target = normalizeModelName(modelName);
  if (target === '') return null;

  let exact: CatalogEntry | null = null;
  let prefix: CatalogEntry | null = null;
  for (const entry of entries) {
    const candidate = normalizeModelName(entry.id);
    if (candidate === target) {
      exact = entry;
      break;
    }
    if (candidate.startsWith(target) && (prefix === null || candidate.length < normalizeModelName(prefix.id).length)) {
      prefix = entry;
    }
  }
  return exact ?? prefix;
}

/** 内置表里找这个模型（归一化后整串匹配：表里的正则写死了具体家族，不做前缀扩散）。 */
export function matchKnownParameters(modelName: string): KnownModelParameterRule | null {
  const target = normalizeModelName(modelName);
  if (target === '') return null;
  for (const rule of KNOWN_MODEL_PARAMETERS) {
    if (rule.pattern.test(target)) return rule;
  }
  return null;
}

/**
 * 单个模型的参数解析：联网命中优先，其次内置表，再次「未知」。
 *
 * `payload` 为 `null` 表示**联网失败**（不是「库里没有」）——这两件事必须能区分：
 * 联网失败时表命中要给 `source: 'table'` 并带上原因，面板才有办法说「这组数字不新鲜」。
 */
export function resolveModelParameters(
  modelName: string,
  payload: unknown | null,
): ModelParameterResult {
  const model = modelName.trim();
  const entry = payload === null ? null : matchCatalogEntry(parseOpenRouterPayload(payload), model);

  if (entry !== null) {
    if (entry.contextLength === null && entry.maxCompletionTokens === null) {
      return {
        model,
        found: false,
        contextWindow: null,
        maxOutputTokens: null,
        source: 'none',
        matchedId: entry.id,
        error: '模型在公共库里，但这条没有窗口 / 输出上限字段',
      };
    }
    return {
      model,
      found: true,
      contextWindow: entry.contextLength,
      maxOutputTokens: entry.maxCompletionTokens,
      source: 'openrouter',
      matchedId: entry.id,
      error: null,
    };
  }

  const known = matchKnownParameters(model);
  if (known !== null) {
    return {
      model,
      found: true,
      contextWindow: known.contextWindow,
      maxOutputTokens: known.maxOutputTokens,
      source: 'table',
      matchedId: null,
      error:
        payload === null
          ? '联网查询失败，用了内置表（DeepSeek v4 / MiMo v2.6）'
          : '公共库里没有这一条，用了内置表（DeepSeek v4 / MiMo v2.6）',
    };
  }

  return {
    model,
    found: false,
    contextWindow: null,
    maxOutputTokens: null,
    source: 'none',
    matchedId: null,
    error: payload === null ? '联网查询失败，且内置表里没有这个模型' : '公共库与内置表里都没有这个模型',
  };
}

/** 批量解析（面板「查参数」用）。 */
export function lookupModelParameters(
  models: readonly string[],
  payload: unknown | null,
): ModelParameterResult[] {
  return models.map((model) => resolveModelParameters(model, payload));
}
