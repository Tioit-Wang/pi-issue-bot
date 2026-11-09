/**
 * 命令执行计划：把 `{argv, cwd}` 变成一个 `docker exec` 的 `Cmd` 数组。
 *
 * 这一层存在的唯一原因是 tech-plan §4.5 与 §4.7 的两条硬要求：
 *
 * 1. **超时必须下沉进容器**（F3）：`timeout` 是 `docker exec` 的**参数**，不是宿主侧包在外面的
 *    一道超时。宿主侧 `timeout` 只杀本地的 `docker exec` 客户端，容器里的 `pnpm test` 会继续跑，
 *    于是「agent 以为超时了、发出下一条命令、两条命令同写一个 worktree」。
 * 2. **兜底标记必须写在命令行里**（E6）：`pkill -f` 只读 `/proc/<pid>/cmdline`，注入环境变量等于
 *    没有兜底。所以把 `# PI_CMD_ID=<uuid>` 作为注释拼进 `bash -lc` 的脚本文本，
 *    宿主侧 `pkill -KILL -f "PI_CMD_ID=<uuid>"` 才命中；`-e PI_CMD_ID=<uuid>` 只作辅助。
 *
 * 形状固定为：
 *   `Cmd = ["timeout","-s","KILL","<n>","bash","-lc","<cmd>\n# PI_CMD_ID=<uuid>"]`
 *
 * 注意**没有任何字符串拼接进 argv**：`<cmd>` 来自客户端 argv 的最后一项，原样作为 `-lc` 的
 * 单个参数传给容器（`bash -lc` 这条约定本身来自 host-core 的 `bash -lc <cmd>`，§4.5）。
 */
import { randomUUID } from 'node:crypto';

import { SandboxError } from './errors.ts';

/** 命令级超时默认值（§4.7：单条命令 120s，install/build 300s）。 */
export const EXEC_TIMEOUT_DEFAULT_MS = 120_000;
export const EXEC_TIMEOUT_BUILD_MS = 300_000;

/** 兜底标记的前缀（`pkill -f` 与容器内注释共用同一个串，避免两处写歪）。 */
export const CMD_MARKER_PREFIX = 'PI_CMD_ID=';

/**
 * 判定「这条命令可能是 install / build / test」→ 放宽到 300s。
 *
 * 故意做成**宽松的保守升级**（多给时间不会错，少给时间会把正常构建判成超时），
 * 且只看命令文本，不看任务类型——任务类型的分档在 §3.6（内存）那一层。
 */
const BUILD_LIKE = /\b(install|i|ci|add|build|compile|rebuild|test|vitest|jest|tsc|prepare|bootstrap)\b/;

export function classifyTimeoutMs(
  argv: readonly string[],
  options: { defaultMs?: number; buildMs?: number } = {},
): number {
  const defaultMs = options.defaultMs ?? EXEC_TIMEOUT_DEFAULT_MS;
  const buildMs = options.buildMs ?? EXEC_TIMEOUT_BUILD_MS;
  const command = argv.at(-1) ?? '';
  return BUILD_LIKE.test(command) ? buildMs : defaultMs;
}

export interface ExecPlan {
  /** 直接交给 `docker exec` 的 `Cmd`（数组，无 shell 插值）。 */
  readonly cmd: string[];
  /** `docker exec -w`：容器内工作目录（身份挂载下与宿主 cwd 相同）。 */
  readonly workdir: string;
  /** `docker exec -e`：只有兜底标记，**不透传任何客户端 env**（§4.5）。 */
  readonly env: string[];
  /** 容器内 `timeout` 的秒数（向上取整，至少 1 秒）。 */
  readonly timeoutSeconds: number;
  /** 本次命令的唯一标记（E6）。 */
  readonly cmdId: string;
}

export interface BuildExecPlanInput {
  readonly argv: readonly string[];
  readonly workdir: string;
  readonly timeoutMs: number;
  /** 不传则生成 uuid；测试注入固定值。 */
  readonly cmdId?: string;
}

/** 构造 `docker exec` 计划。argv 最后一项就是宿主要跑的那条 `bash -lc <cmd>` 文本。 */
export function buildExecPlan(input: BuildExecPlanInput): ExecPlan {
  const command = input.argv.at(-1);
  if (command === undefined || command.trim().length === 0) {
    throw new SandboxError('argv 最后一项为空：没有可执行的命令', {
      code: 'BAD_REQUEST',
      details: { argvLength: input.argv.length },
    });
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new SandboxError(`timeoutMs 非法：${String(input.timeoutMs)}`, { code: 'BAD_REQUEST' });
  }
  const cmdId = input.cmdId ?? randomUUID();
  const timeoutSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  // 标记写成**独立注释行**：`<cmd>` 结束后换行，`#` 才确定是注释而不是上一个词的尾巴。
  const script = `${command}\n# ${CMD_MARKER_PREFIX}${cmdId}`;
  return {
    cmd: ['timeout', '-s', 'KILL', String(timeoutSeconds), 'bash', '-lc', script],
    workdir: input.workdir,
    env: [`${CMD_MARKER_PREFIX}${cmdId}`],
    timeoutSeconds,
    cmdId,
  };
}

/**
 * 宿主侧兜底：`docker exec <c> pkill -KILL -f "PI_CMD_ID=<uuid>"`（§4.7）。
 *
 * 这道兜底只对付「自己 `daemonize` 掉、逃出 `timeout` 进程组」的进程；
 * 匹配串必须唯一（`PI_CMD_ID=<uuid>`），不能写成 `-f "pnpm"` 这种模糊匹配。
 */
export function buildFallbackKillPlan(input: { cmdId: string }): { cmd: string[] } {
  if (input.cmdId.trim().length === 0) {
    throw new SandboxError('cmdId 不能为空：模糊匹配会杀掉别的命令', { code: 'BAD_REQUEST' });
  }
  return { cmd: ['pkill', '-KILL', '-f', `${CMD_MARKER_PREFIX}${input.cmdId}`] };
}
