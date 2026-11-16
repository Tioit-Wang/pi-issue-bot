/**
 * 执行模型解析（CFG-8.3 的**执行面**）：把「全局默认 + 项目覆盖」解析成「这一次用谁」。
 *
 * 为什么单独一层而不是让 worker 自己查库：
 *  - worker 不该认识 `model_default` / `repo_model_override`（那是配置层的表）；
 *  - 「项目覆盖优先、否则全局」这条规则只能有一处实现，否则两处迟早各自漂出一个答案。
 *
 * 缓存 30 秒（`defaultTtlMs`）：一次任务可能驱动多轮 turn，而配置在面板上改不会立刻改变
 * 正在跑的任务——这与「配置即快照」（BR-8）的方向一致：**取一次、这一轮都用这一份**。
 */
import type { SqlRunner } from '../config/repo-config.ts';
import { resolveEffectiveModel } from '../config/model-settings.ts';

/** 一档生效绑定：谁、哪个模型、来自项目覆盖还是全局继承。 */
export type ResolvedModel = {
  readonly providerId: string;
  readonly model: string;
  /** 启动日志要能解释「为什么模型变了」。 */
  readonly source: 'repo' | 'global';
};

export type ModelResolverOptions = {
  readonly db: SqlRunner;
  /** 缓存有效期（毫秒）；默认 30s。 */
  readonly ttlMs?: number;
  /** 时间源（注入：测试要断言缓存过期）。 */
  readonly now?: () => number;
};

/**
 * 解析器：`(repo) => ResolvedModel | null`。
 *
 * `repo` 为 `null` = 全局层面（Host 启动、全局设置的「用哪个模型」）；
 * 返回 `null` = 全局与项目都没配，执行面退回部署级 env 三元组。
 */
export type ModelResolver = (repo: string | null) => Promise<ResolvedModel | null>;

/**
 * 建一个带缓存的解析器（**按 repo 分别缓存**，不能合成一把 key：
 * 不同项目的覆盖不同，共用一把 key 就等于随机取一个项目的配置去跑另一个项目）。
 */
export function createDbModelResolver(options: ModelResolverOptions): ModelResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly value: ResolvedModel | null }>();

  return async (repo) => {
    const key = repo ?? '';
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at <= ttlMs) {
      return hit.value;
    }
    const effective = await resolveEffectiveModel(options.db, repo);
    const value: ResolvedModel | null =
      effective === null
        ? null
        : { providerId: effective.providerId, model: effective.model, source: effective.source };
    cache.set(key, { at: now(), value });
    return value;
  };
}
