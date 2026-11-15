/**
 * 模型角色解析（CFG-8.3 的**执行面**）：把「全局默认 + 项目覆盖」解析成「这一次用谁」。
 *
 * 为什么单独一层而不是让 worker 自己查库：
 *  - worker 不该认识 `model_providers` / `repo_model_roles`（那是配置层的表）；
 *  - 「项目覆盖优先、否则全局」这条规则只能有一处实现，否则 agent / format / classify /
 *    fallback 四档迟早各自漂出一个答案（这正是需求点名的问题）。
 *
 * 缓存 30 秒（`defaultTtlMs`）：一次任务可能驱动多轮 turn，而配置在面板上改不会立刻改变
 * 正在跑的任务——这与「配置即快照」（BR-8）的方向一致：**取一次、这一轮都用这一份**。
 */
import type { SqlRunner } from '../config/repo-config.ts';
import { resolveEffectiveRole } from '../config/model-settings.ts';
import type { ResolvedModelRole } from './model-env.ts';
import { MODEL_ROLE_KEYS, type ModelRoleKey } from '../../../../packages/contract/src/index.ts';

export type ModelRoleResolverOptions = {
  readonly db: SqlRunner;
  /** 缓存有效期（毫秒）；默认 30s。 */
  readonly ttlMs?: number;
  /** 时间源（注入：测试要断言缓存过期）。 */
  readonly now?: () => number;
};

/**
 * 一档角色解析器：`(repo) => ResolvedModelRole | null`。
 *
 * `repo` 为 `null` = 全局层面（例如全局设置的「检查」按钮、成本归因）；
 * 返回 `null` = 这一档没配（面板显示「未配置」，执行面退回部署级 env 三元组）。
 */
export type ModelRoleResolver = (
  role: ModelRoleKey,
  repo: string | null,
) => Promise<ResolvedModelRole | null>;

/**
 * 建一个带缓存的角色解析器（**按 repo 分别缓存**，不能合成一把 key：
 * 不同项目的覆盖不同，共用一把 key 就等于随机取一个项目的配置去跑另一个项目）。
 */
export function createDbModelRoleResolver(options: ModelRoleResolverOptions): ModelRoleResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly value: ResolvedModelRole | null }>();

  return async (role, repo) => {
    const key = `${repo ?? ''}\u0000${role}`;
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at <= ttlMs) {
      return hit.value;
    }
    const effective = await resolveEffectiveRole(options.db, repo, role);
    const value: ResolvedModelRole | null =
      effective === null
        ? null
        : {
            role,
            providerId: effective.providerId,
            model: effective.model,
            source: effective.source,
          };
    cache.set(key, { at: now(), value });
    return value;
  };
}

/**
 * 解析**全部四档**（装配层一次性取，避免四次串行查询）。
 *
 * 顺序固定为 `MODEL_ROLE_KEYS`：pi-host 的环境增量与面板的四行都按这个顺序渲染。
 */
export async function resolveAllModelRoles(
  resolve: ModelRoleResolver,
  repo: string | null,
): Promise<{ readonly role: ModelRoleKey; readonly binding: ResolvedModelRole | null }[]> {
  const items: { readonly role: ModelRoleKey; readonly binding: ResolvedModelRole | null }[] = [];
  for (const role of MODEL_ROLE_KEYS) {
    items.push({ role, binding: await resolve(role, repo) });
  }
  return items;
}
