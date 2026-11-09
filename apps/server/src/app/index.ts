/**
 * `app/` 的公共出口（W4-P：**进程装配层**）。
 *
 * 分工：
 *  - `config.ts`      —— env → `AppConfig`（缺关键项给可读错误；缺省值不读硬编码路径）
 *  - `compose.ts`     —— `createApplication(config, overrides?)`：pool / queue / worker / http /
 *                        metrics 的接线，`start()` / `stop()` / `executeTask()`
 *  - `racp.ts`        —— 每条 run 一条 RACP 通道（`RacpClient` + `RacpOps` + 事件缓冲）
 *  - `worker-deps.ts` —— worker 端口装配、任务行读取、提示词骨架、缺件时的「明确失败」实现
 *
 * 依赖方向：`app → 所有模块`（装配层是唯一允许「认识所有人」的地方），
 * 反过来任何模块都**不**依赖 `app/`：`cli.ts` 也只是它的调用方。
 */
export {
  APP_DEFAULTS,
  APP_ENV_KEYS,
  describeAppConfig,
  readAppConfig,
  readAppConfigFromProcess,
  redactDsn,
} from './config.ts';
export type { AppConfig } from './config.ts';

export {
  APP_ERROR_CODES,
  QUEUE_STOP_TIMEOUT_MS,
  REQUIRED_TABLES,
  SHUTDOWN_STEPS,
  assertSchemaReady,
  createApplication,
  createUnavailableWebhookAck,
} from './compose.ts';
export type {
  AppQueue,
  Application,
  ApplicationAddresses,
  ApplicationOverrides,
  QueueStatsLike,
  ShutdownStep,
  TaskExecutionInput,
} from './compose.ts';

export {
  DEFAULT_RACP_HOST,
  RACP_CHANNEL_ERROR_CODES,
  createEventFeed,
  createRacpChannelFactory,
  createUnavailableRacpChannelFactory,
} from './racp.ts';
export type { CreateRacpChannelFactoryOptions, EventFeed, RacpChannel, RacpChannelFactory } from './racp.ts';

export {
  WORKER_ASSEMBLY_ERROR_CODES,
  buildTaskPrompt,
  createUnavailableGithubWriteApi,
  createUnavailableHostPort,
  createWorkerBaseDeps,
  createWorkerPorts,
  readTaskRow,
} from './worker-deps.ts';
export type {
  CreateWorkerPortsOptions,
  TaskJobRow,
  TaskPromptInput,
  WorkerBaseDeps,
  WorkerPorts,
} from './worker-deps.ts';
