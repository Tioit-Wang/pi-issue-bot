/**
 * 从 **pi-host 自己的库**（`<hostDataDir>/pi.sqlite` 的 `turns` 表）读一轮的真实用量。
 *
 * 为什么不用信封里的 `usage`：信封是 agent 自己填的，实测恒为
 * `{inputTokens:0, outputTokens:0, costUsd:0}`（模型看不到自己的计费数据）。
 * 而 pi-host 在 `turns` 里记着 provider 返回的真数：
 *   `input_tokens` / `output_tokens` / `usage_json.cacheReadTokens` / `model_id`，
 * 逐 operation 还有明细；`costStatus` 是 `unknown` —— 也就是**它不算钱，只给 token**。
 *
 * 所以这里只负责取 token，价钱由 `pricing.ts` 按 DeepSeek 官方价目算。
 *
 * 取舍：这是读宿主内部实现（sqlite 表结构），属于**已知耦合**：
 *  - 只读打开（`readOnly: true`），不写、不加锁；
 *  - 库不存在 / 表不存在 / 行还没落库 → 返回 `null`，调用方按「未知」处理，绝不抛给任务；
 *  - host 版本升级导致列名变化时，这里会退化成 `null`（面板会显示「无用量」而不是假 0）。
 */
import { DatabaseSync } from 'node:sqlite';

export type TurnUsage = {
  /** provider 报的模型名（如 `deepseek-v4.1-flash`）；取不到为 `null`。 */
  readonly modelId: string | null;
  /** 未命中缓存的输入 token */
  readonly inputTokens: number;
  /** 命中缓存的输入 token（`usage_json.cacheReadTokens`） */
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
};

export type TurnUsageReader = (turnId: string) => Promise<TurnUsage | null>;

type TurnRow = {
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  usage_json: string | null;
};

function intOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 从 `usage_json` 里取 `cacheReadTokens`（顶层聚合值）。 */
function cacheReadOf(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return 0;
    const value = (parsed as Record<string, unknown>)['cacheReadTokens'];
    return intOf(value);
  } catch {
    return 0;
  }
}

export type HostUsageReaderOptions = {
  /** pi-host 的 data dir（与 `PI_BOT_HOST_DATA_DIR` 同一个值）。 */
  readonly dataDir: string;
};

/**
 * 建一个读取器。每次调用都新开只读连接（host 可能正在写；持连接会挡住 WAL checkpoint）。
 */
export function createHostUsageReader(options: HostUsageReaderOptions): TurnUsageReader {
  const file = `${options.dataDir.replace(/[\\/]+$/, '')}/pi.sqlite`;
  return async (turnId: string): Promise<TurnUsage | null> => {
    if (turnId === '') return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const row = db
        .prepare(
          'select model_id, input_tokens, output_tokens, usage_json from turns where id = ? limit 1',
        )
        .get(turnId) as TurnRow | undefined;
      if (row === undefined) return null;
      const usage: TurnUsage = {
        modelId: typeof row.model_id === 'string' && row.model_id !== '' ? row.model_id : null,
        inputTokens: intOf(row.input_tokens),
        cacheReadTokens: cacheReadOf(row.usage_json),
        outputTokens: intOf(row.output_tokens),
      };
      if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheReadTokens === 0) {
        return null;
      }
      return usage;
    } catch {
      // 库不存在 / 被锁 / 表结构变了：都不该影响任务本身
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // 关不掉也不影响
      }
    }
  };
}
