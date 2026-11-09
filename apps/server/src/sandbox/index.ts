/**
 * 沙箱执行面（B7）的对外出口。
 *
 * 分层（tech-plan §4.5 / §6.1 / §6.3）：
 *   - `hostconfig.ts`  纯函数：plan §8.1 → dockerode HostConfig（`/work` 作废，身份挂载）
 *   - `docker.ts`      **全机唯一**触达 docker socket 的薄封装（窄接口，测试可注入假实现）
 *   - `exec-proxy.ts`  bot 侧的 unix socket / 命名管道服务端（查表 → docker exec）
 *   - `exec-plan.ts`   命令计划：容器内 `timeout` + `PI_CMD_ID` 兜底标记（E6）
 *   - `lifecycle.ts`   保留期矩阵 + 水位清理 + **销毁前 inspect 采 OOMKilled**
 *   - `paths.ts`       宿主 ↔ 容器路径（生产恒等；Windows 开发机 `/c/...` 映射）
 *   - `protocol.ts`    线协议：只收 `{argv,cwd,clientPid}`、1 MB 输出上限
 *
 * shim（`scripts/sandbox-bash`）与客户端（`exec-client.mjs`）是独立可执行文件，
 * 不经过这个 barrel。
 */
export {
  SandboxError,
  SANDBOX_ERROR_CODES,
  EXIT_CODE_BY_ERROR_CODE,
  exitCodeForErrorCode,
  isSandboxError,
  toSandboxError,
} from './errors.ts';
export type { SandboxErrorCode } from './errors.ts';

export { NULL_LOGGER } from './types.ts';
export type { FailureClassLike, SandboxLogger } from './types.ts';

export {
  EXEC_ENDPOINT_FILENAME,
  EXEC_SOCKET_FILENAME,
  IS_WINDOWS,
  endpointDir,
  isPathInside,
  toBindSource,
  toContainerPath,
  toHostPath,
} from './paths.ts';

export {
  CMD_MARKER_PREFIX,
  EXEC_TIMEOUT_BUILD_MS,
  EXEC_TIMEOUT_DEFAULT_MS,
  buildExecPlan,
  buildFallbackKillPlan,
  classifyTimeoutMs,
} from './exec-plan.ts';
export type { BuildExecPlanInput, ExecPlan } from './exec-plan.ts';

export {
  EXEC_OUTPUT_LIMIT_BYTES,
  EXEC_REQUEST_KEYS,
  createFrameDecoder,
  createOutputBudget,
  encodeFrame,
  parseExecRequest,
} from './protocol.ts';
export type { ExecRequest, ExecResponseFrame } from './protocol.ts';

export {
  DEFAULT_CACHE_VOLUME,
  DEFAULT_NANO_CPUS,
  DEFAULT_NETWORK_MODE,
  DEFAULT_NOFILE,
  DEFAULT_PIDS_LIMIT,
  DEFAULT_TMPFS,
  DEFAULT_USER,
  MEMORY_TIER_BYTES,
  buildContainerCreateOptions,
  buildHostConfig,
  containerNameFor,
  nodeOptionsFor,
  resolveMemoryBytes,
} from './hostconfig.ts';
export type { SandboxContainerInput, SandboxContainerSpec, SandboxMemoryTier } from './hostconfig.ts';

export { createSandboxDocker, resolveDockerSocketPath } from './docker.ts';
export type {
  ContainerStateSnapshot,
  CreateSandboxDockerOptions,
  ExecStreamRequest,
  SandboxDocker,
} from './docker.ts';

export { ExecProxy, defaultListenAddress, parseListenAddress } from './exec-proxy.ts';
export type {
  EndpointKind,
  ExecProxyOptions,
  JobEndpoint,
  ListenInput,
  ParsedListenAddress,
} from './exec-proxy.ts';

export {
  DEFAULT_RETENTION_POLICY,
  LifecycleExecutor,
  classifyDestroyedState,
  collectStateBeforeDestroy,
  createLifecycleExecutor,
  planSweep,
  readDiskUsageRatio,
  retentionForOutcome,
} from './lifecycle.ts';
export type {
  ContainerDisposition,
  DisposeInput,
  DisposeResult,
  EndpointReaper,
  LifecycleExecutorOptions,
  RetentionDecision,
  RetentionPolicy,
  SweepPlan,
  SweepResult,
  TaskOutcome,
  TrackedContainer,
} from './lifecycle.ts';
