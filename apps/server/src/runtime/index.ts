/**
 * `runtime/` 的公开出口：pi-host 监督 + 引导配对 + 令牌加密 + 自动审批 + 轮次驱动（tech-plan §8.2）。
 *
 * 依赖方向：`worker → runtime → racp-client`（`shared` 任何模块可用）。
 * 本目录**不** import `worker/` `http/` `queries/` `sandbox/` `git/` `github/` `queue/`（eslint 卡住），
 * 所以「怎么进容器」「怎么推分支」这些都不在这里：本目录只负责把 Host 拉起来、把一个 turn 跑完。
 *
 * 三个装配入口（其余都是它们的零件）：
 * | 场景 | 入口 |
 * |---|---|
 * | `pi-bot bootstrap-host`（一次性配对） | `bootstrapHost` + `createRacpBootstrapClient` + `createSqlHostCredentialStore` |
 * | `pi-bot serve`（常驻，接任务） | `HostSupervisor` + `driveTurn`（`ops` 传 `RacpOps`） |
 * | `pi-bot doctor`（预检） | `verifyPin` + `parseHostReadyLine` / `parseHostPairingTokenLine` |
 */

// ── PIN 钉扎（§2.2） ────────────────────────────────────────────────────────
export {
  PIN_ERROR_CODES,
  PIN_FILE_NAME,
  assertHostVersionMatches,
  bundleBinaryPath,
  parsePinFile,
  verifyPin,
} from './pin.ts';
export type { PinFile, PinReadFile, PinVerification, PinVerifiedFile, VerifyPinOptions } from './pin.ts';

// ── 令牌加密（§7.2 / §10.4） ───────────────────────────────────────────────
export {
  AES_KEY_BYTES,
  CRYPTO_ERROR_CODES,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  TOKEN_CIPHER_VERSION,
  assertSecretKey,
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  looksEncrypted,
  secretKeyFromBase64,
  secretKeyFromHex,
  sha256Hex,
} from './crypto.ts';
export type { DecryptSecretOptions, EncryptSecretOptions } from './crypto.ts';

// ── 子进程监督（§3.4 / §4.2） ─────────────────────────────────────────────
export {
  DEFAULT_HOST_BACKOFF_MS,
  DEFAULT_MAX_RESTARTS_PER_WINDOW,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_RESTART_WINDOW_MS,
  DEFAULT_STOP_GRACE_MS,
  HOST_SUPERVISOR_ERROR_CODES,
  HostSupervisor,
  PI_HOST_PAIRING_TOKEN_PREFIX,
  PI_HOST_READY_PREFIX,
  buildHostArgs,
  createNodeHostSpawn,
  parseHostPairingTokenLine,
  parseHostReadyLine,
} from './host-supervisor.ts';
export type {
  HostChildProcess,
  HostPairingInfo,
  HostProcessExit,
  HostReadyInfo,
  HostRuntimeInfo,
  HostSpawn,
  HostSpawnCommand,
  HostSupervisorOptions,
  HostSupervisorStatus,
} from './host-supervisor.ts';

// ── 引导（§4.2 六步） ─────────────────────────────────────────────────────
export {
  BOOTSTRAP_ERROR_CODES,
  BOOTSTRAP_STEPS,
  DEFAULT_CREDENTIAL_VERSION,
  bootstrapHost,
  createRacpBootstrapClient,
  createSqlHostCredentialStore,
  readDeviceToken,
} from './bootstrap.ts';
export type {
  BootstrapClient,
  BootstrapClientFactory,
  BootstrapHostOptions,
  BootstrapHostResult,
  BootstrapInitializeResult,
  BootstrapPairResult,
  BootstrapStep,
  HostCredentialRow,
  HostCredentialStore,
  SqlExecutorLike,
} from './bootstrap.ts';

// ── 自动审批（§4.6） ──────────────────────────────────────────────────────
export {
  APPROVAL_RULES,
  INPUT_UNAVAILABLE_ANSWER,
  PATH_INPUT_KEYS,
  READ_ONLY_TOOLS,
  SANDBOXED_TOOLS,
  WRITE_TOOLS,
  answerInputRequest,
  decideApproval,
  extractTargetPath,
  isPathInsideWorktree,
  racpDecisionFor,
} from './approval-policy.ts';
export type {
  AnswerInputRequestParams,
  ApprovalAudit,
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRule,
  DecideApprovalParams,
  InputAnswerResult,
  InputQuestionLike,
} from './approval-policy.ts';

// ── 轮次驱动（§4.3 / §4.7） ───────────────────────────────────────────────
export {
  DEFAULT_TURN_TIMEOUT_MS,
  REVIEW_PR_TURN_TIMEOUT_MS,
  TERMINAL_TURN_EVENT_KINDS,
  TURN_DRIVER_ERROR_CODES,
  driveTurn,
  extractApprovalRequest,
  extractInputRequest,
  isTurnTimeout,
} from './turn-driver.ts';
export type {
  ApprovalRequestPayload,
  InputRequestPayload,
  TerminalTurnEventKind,
  TurnDriveResult,
  TurnDriverOps,
  TurnDriverParams,
} from './turn-driver.ts';
