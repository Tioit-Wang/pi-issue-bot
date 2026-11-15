/**
 * 单价解析器（CFG-8.2 的落点）：把 DB 里的供应商模型目录变成 `PriceResolver`。
 *
 * 为什么单独一个文件：`cost/pricing.ts` 是**纯函数**（不许 I/O，单测逐条钉住公式），
 * 而单价的事实源已经从「代码里的官方价目表」变成「全局设置里的模型目录」。
 * 两者之间的桥就是这里——读一次目录、缓存几秒、产出 `(model) => price | null`。
 *
 * 三条口径：
 *  1. **按模型名查，不按角色查**：项目级覆盖换了模型之后单价仍然对得上。
 *  2. **查不到返回 `null`**，由 `estimateDeepSeekCostUsd()` 退回代码兜底表；
 *     绝不返回 0 —— 0 会把「单价未知」伪装成「这次没花钱」。
 *  3. **失败不抛**：价格读不出来不该让一次成功的 turn 变成失败（用量已经产出了）；
 *     退回兜底表 + 在结果里标 `pricingSource: 'static'` 就是「说清楚」的方式。
 */
import type { SqlRunner } from '../config/repo-config.ts';
import { listProviders } from '../config/model-settings.ts';
import type { ConfigPrice, PriceResolver } from './pricing.ts';

export type PriceResolverOptions = {
  /** 缓存有效期（毫秒）。默认 30s：价格表在面板上改，运行中的 turn 不必逐次查库。 */
  readonly ttlMs?: number;
  /** 时间源（注入：测试要断言「缓存过期后重查」）。 */
  readonly now?: () => number;
};

/** 缓存条数的上限：一家供应商 × 目录最多这么多模型，够真实规模用。 */
const MAX_CACHED = 5_000;

/**
 * 建一个「模型名 → 单价」的解析器（带 TTL 缓存）。
 *
 * 同名模型出现在两家供应商时**先到先得**：模型名本身不唯一（`gpt-4o-mini` 国产兼容端点也叫这个），
 * 按名查是成本归集口径的既有事实（`usage_costs.model` 也只存名字）。要区分得改用量口径，
 * 那是另一件事——这里只保证「查得到就用配置价、查不到就明说用了兜底表」。
 */
export function createConfigPriceResolver(
  db: SqlRunner,
  options: PriceResolverOptions = {},
): PriceResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  let loadedAt = 0;
  let table: ReadonlyMap<string, ConfigPrice> = new Map();
  let loaded = false;

  const refresh = async (): Promise<void> => {
    loadedAt = now();
    loaded = true;
    try {
      const providers = await listProviders(db);
      const next = new Map<string, ConfigPrice>();
      for (const provider of providers) {
        for (const entry of provider.models) {
          if (next.size >= MAX_CACHED) break;
          if (next.has(entry.model)) continue;
          next.set(entry.model, {
            input_usd_per_mtok: entry.price.input_usd_per_mtok,
            output_usd_per_mtok: entry.price.output_usd_per_mtok,
          });
        }
      }
      table = next;
    } catch {
      // 读不到就保持上一份（首次失败则空表 → 全部退回兜底表）。
      // 吞掉是刻意的：价格读不出来不该让已经跑完的 turn 判成失败。
      table = loaded ? table : new Map();
    }
  };

  // 预热一次：第一次调用计价时通常已经在跑任务，别把一次往返塞进关键路径。
  void refresh();

  return (model: string): ConfigPrice | null => {
    if (!loaded || now() - loadedAt > ttlMs) {
      // 同步接口里没法 await：过期就先用旧值，同时触发一次后台刷新
      void refresh();
    }
    return table.get(model) ?? null;
  };
}
