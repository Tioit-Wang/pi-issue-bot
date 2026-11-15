/**
 * 模型端点 → pi-host 子进程环境（plan §4.4 / tech-plan §3.2）。
 *
 * 分工：**bot 把配置换算成环境变量，pi-host 自己去说 OpenAI 兼容协议**。我们不做 provider
 * 客户端、不代理 HTTP——这样 OpenAI、DeepSeek、MiMo 这类 `/v1/chat/completions` 兼容端点
 * 用同一套配置，换供应商只改 `PI_BOT_MODEL_BASE_URL` 与 `PI_BOT_MODEL_NAME`。
 *
 * 只导出这一组变量（白名单），不把整个 `process.env` 灌给子进程：plan §8.4 的「容器里没有
 * 任何凭证」讲的是沙箱；pi-host 属于可信侧、可以拿模型 key，但**仍然只给它需要的**。
 *
 * | 输出变量 | 来源 | 谁读 |
 * |---|---|---|
 * | `PI_BOT_MODEL_API_KEY` / `OPENAI_API_KEY` | `config.model.apiKey` | pi-host 与 OpenAI SDK 生态 |
 * | `PI_BOT_MODEL_BASE_URL` / `OPENAI_BASE_URL` | `config.model.baseUrl` | 同上（兼容端点） |
 * | `PI_BOT_MODEL_NAME` / `OPENAI_MODEL` | `config.model.name` | pi-host 的默认模型名 |
 *
 * 为什么同时写两份名字：宿主机上别的工具（pi-host 自身、各家 SDK）已经在读标准名
 * （`OPENAI_*`），强制改名只会让运维维护两套变量；别名让「标准端点」开箱可用。
 */
import type { AppConfig } from './config.ts';

/** 输出给 pi-host 的变量名（测试与 `deploy/*.service` 的注释共用这份常量）。 */
export const HOST_MODEL_ENV_KEYS = {
  apiKey: 'PI_BOT_MODEL_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  baseUrl: 'PI_BOT_MODEL_BASE_URL',
  openaiBaseUrl: 'OPENAI_BASE_URL',
  name: 'PI_BOT_MODEL_NAME',
  openaiModel: 'OPENAI_MODEL',
} as const;

/**
 * 生成 pi-host 的环境增量。没配的项**不出现**（不要写空字符串：空字符串会被下游当成
 * 「显式配了个空端点」，比缺省更难查）。
 */
export function hostModelEnv(config: AppConfig): Readonly<Record<string, string>> {
  const { apiKey, baseUrl, name } = config.model;
  const env: Record<string, string> = {};
  if (apiKey !== null) {
    env[HOST_MODEL_ENV_KEYS.apiKey] = apiKey;
    env[HOST_MODEL_ENV_KEYS.openaiApiKey] = apiKey;
  }
  if (baseUrl !== null) {
    env[HOST_MODEL_ENV_KEYS.baseUrl] = baseUrl;
    env[HOST_MODEL_ENV_KEYS.openaiBaseUrl] = baseUrl;
  }
  if (name !== null) {
    env[HOST_MODEL_ENV_KEYS.name] = name;
    env[HOST_MODEL_ENV_KEYS.openaiModel] = name;
  }
  return env;
}

/** 端点描述（日志/doctor 用）：`deepseek-chat @ https://api.deepseek.com/v1`。 */
export function describeModelEndpoint(config: AppConfig): string {
  const name = config.model.name ?? '<未配置模型名>';
  const base = config.model.baseUrl ?? '<pi-host 默认端点>';
  return `${name} @ ${base}`;
}

/* ── 角色四档 → pi-host 环境（CFG-8.2 / CFG-8.3 的执行面）────────────────────── */

/**
 * 四档角色在 pi-host 侧的变量名。
 *
 * 为什么要单独一组变量：`PI_BOT_MODEL_NAME` 是**执行档**（`agent`）的旧名，pi-host 只认它；
 * 其余三档（`format` / `classify` / `fallback`）pi-host 当前的 RACP 协议里没有对应槽位
 * （`session/create` 只带 `systemPrompt`，`turn/start` 只带 `input.text`），
 * 所以这三档的绑定**只落在配置与面板上**，运行期由后续协议版本消费。
 * 这里仍把四档都发出去：多给的变量不会被旧 Host 误解，而省掉它们会让
 * 「界面配置了、实际没用上」这件事永远查不出来。
 */
export const HOST_MODEL_ROLE_ENV_KEYS = {
  agent: { name: 'PI_BOT_MODEL_NAME', alias: 'OPENAI_MODEL' },
  format: { name: 'PI_BOT_MODEL_FORMAT_NAME', alias: 'PI_BOT_MODEL_FORMAT' },
  classify: { name: 'PI_BOT_MODEL_CLASSIFY_NAME', alias: 'PI_BOT_MODEL_CLASSIFY' },
  fallback: { name: 'PI_BOT_MODEL_FALLBACK_NAME', alias: 'PI_BOT_MODEL_FALLBACK' },
} as const;

/**
 * 一档角色的**生效**绑定（装配层解析好传进来，本函数不查库）。
 *
 * `providerId` / `source` 可选：Host 启动时只关心「模型名」，而项目级覆盖的解析发生在
 * 任务侧（`app/model-role-resolver.ts`）。让这两项可选，装配层才能在启动路径里只给名字。
 */
export type ResolvedModelRole = {
  readonly role: 'agent' | 'format' | 'classify' | 'fallback';
  readonly model: string;
  readonly providerId?: string;
  /** 来自项目覆盖还是全局继承（启动日志要能解释「为什么模型变了」）。 */
  readonly source?: 'repo' | 'global';
};

/**
 * 角色四档 → pi-host 环境增量（CFG-8.2 / CFG-8.3）。
 *
 * 口径与 `hostModelEnv()` 一致：没配的档**不出现**（空字符串会被下游当成「显式配了个空端点」）；
 * 执行档同时写 `PI_BOT_MODEL_NAME` 与 `OPENAI_MODEL`（宿主机上 pi-host 与各 SDK 读标准名）。
 * 端点级的 key / base URL 仍由 `hostModelEnv()` / `hostEndpointEnv()` 给，本函数只管模型名。
 */
export function hostModelRoleEnv(
  roles: readonly ResolvedModelRole[],
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const role of roles) {
    const keys = HOST_MODEL_ROLE_ENV_KEYS[role.role];
    env[keys.name] = role.model;
    env[keys.alias] = role.model;
  }
  return env;
}

/**
 * 供应商端点 → pi-host 环境增量（CFG-8.1「OpenAI 兼容的自建端点按同一行填写」）。
 *
 * 为什么角色换模型时端点也要跟着换：只换模型名不换端点 = 把国内模型的请求打到 api.openai.com。
 * 返回 `{}` 表示「与部署级 endpoint 一致，不需要覆盖」。
 */
export function hostEndpointEnv(input: {
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
}): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  if (input.apiKey !== null && input.apiKey !== '') {
    env[HOST_MODEL_ENV_KEYS.apiKey] = input.apiKey;
    env[HOST_MODEL_ENV_KEYS.openaiApiKey] = input.apiKey;
  }
  if (input.baseUrl !== null && input.baseUrl !== '') {
    env[HOST_MODEL_ENV_KEYS.baseUrl] = input.baseUrl;
    env[HOST_MODEL_ENV_KEYS.openaiBaseUrl] = input.baseUrl;
  }
  return env;
}
