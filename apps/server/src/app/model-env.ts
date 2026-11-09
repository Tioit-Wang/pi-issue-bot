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
