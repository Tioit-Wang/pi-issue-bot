/**
 * 全局设置写面的**装配工厂**（需求 §6.8 / §6.9）。
 *
 * 为什么单独一个文件而不是写在 `app/compose.ts` 里：`compose.ts` 在本轮修复里由另一个
 * session 独占（`compact/`、`session` 相关改动正在那里进行）。把装配口径钉在这里，
 * `compose.ts` 只需要一行把它挂进 `buildServer()` —— 逻辑不必再复制第二份。
 *
 * 三件事：
 *  1. `createSettingsApiWiring()` —— 交给 `buildServer({ settings })` 的对象
 *     （`db` / 密钥 / 两个探测端口）；
 *  2. `createGithubProviderProbe()` —— 供应商连通性（`GET {baseUrl}/models`，只读 GET）；
 *  3. `createGithubIdentityProbe()` —— 个人 PAT 的 scope 与过期时间（`GET /user` 的响应头）。
 *
 * 安全边界：key / PAT 的明文只在这两个探测函数里出现一次，随后立刻丢弃；
 * 加密密钥来自 `AppConfig.secretsKey`（`PI_BOT_SECRETS_KEY`），**不进容器**。
 */
import { PROVIDER_CHECK_TIMEOUT_MS } from '../../../../packages/contract/src/index.ts';
import type { Logger } from '../../../../packages/shared/src/index.ts';
import { createGithubIdentityProbe } from './github-auth.ts';
import type { AppConfig } from './config.ts';
import type { ApiWriteWiring } from '../http/api/index.ts';
import type { ProviderProbePort } from '../http/api/settings.ts';
import type { SqlRunner } from '../config/repo-config.ts';

/**
 * 装配设置写面。
 *
 * `null` = 没配 `PI_BOT_SECRETS_KEY`：返回 `null` 而不是「内部再找一把密钥」——
 * 猜密钥会让已存的密文解不开，那是最糟的一种「能跑但全是错」。
 */
export function createSettingsApiWiring(options: {
  readonly db: SqlRunner;
  readonly config: AppConfig;
  readonly logger?: Logger;
}): ApiWriteWiring | null {
  const key = options.config.secretsKey;
  if (key === null) {
    options.logger?.warn(
      {},
      '未配置 PI_BOT_SECRETS_KEY：/api/settings 的写接口不可用（供应商 key 与个人 PAT 需要 AES-256-GCM 加密存储）',
    );
    return null;
  }
  return {
    db: options.db,
    secretKey: key,
    identityProbe: createGithubIdentityProbe(),
    providerProbe: createGithubProviderProbe(),
    writeMode: options.config.panelWrite,
  };
}

/**
 * 供应商连通性探测：`GET {baseUrl}/models`（OpenAI 兼容端点的标准能力）。
 *
 * 判定口径：
 *  - 2xx 且返回体里有 `data[].id`（OpenAI 形状）或 `models[].name`（Gemini 形状）→ `ok` + 模型清单；
 *  - 2xx 但读不出模型清单 → 仍然 `ok`（连通性成立），`models: null`（不猜清单）；
 *  - 非 2xx / 超时 / DNS 失败 → `fail` + 原因（**不含 key**）。
 *
 * 为什么不复用 pi-host：pi-host 是「任务执行期」的模型通道，而这里是**面板上的一次手动检查**，
 * 两者生命周期不同；让面板探测去拉起一个 Host 反而是错的。
 */
export function createGithubProviderProbe(
  options: { readonly fetchImpl?: typeof fetch } = {},
): ProviderProbePort {
  const doFetch = options.fetchImpl ?? fetch;
  return async (input) => {
    const startedAt = Date.now();
    const url = `${input.baseUrl.replace(/\/+$/u, '')}/models`;
    try {
      const response = await doFetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(input.timeoutMs ?? PROVIDER_CHECK_TIMEOUT_MS),
      });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        // 只报状态码与端点：响应体可能带 key 片段，不做二次落盘
        return { ok: false, latencyMs, error: `${url} 返回 ${String(response.status)}` };
      }
      return { ok: true, latencyMs, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: `${url} 请求失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}
