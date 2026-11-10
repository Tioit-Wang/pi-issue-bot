/**
 * 端口适配层：把 `sandbox/` 与 `runtime/` 的实现接成 worker 的窄接口。
 *
 * 这里只做**形状转换**，不含任何策略：`ExecProxy` 自己管监听与映射表、
 * `LifecycleExecutor` 自己管「销毁前先 inspect」、`HostSupervisor` 自己管退避重启。
 * worker 拿不到 `ChildProcess` 或 docker 客户端，也就没法绕过它们的规矩。
 *
 * 唯一的例外是 `createUnavailableWorktreePort()`：它是**故意的失败实现**。
 * 真实检出（clone 缓存 + `git worktree add`）归 `git/` owner（W4-N），
 * 在那之前必须让「没有 worktree」表现为一次明确的失败（`WORKTREE_UNAVAILABLE`），
 * 而不是悄悄拿一个别的目录去跑任务。
 */
import type { HostSupervisor } from '../runtime/host-supervisor.ts';
import type { ExecProxy, LifecycleExecutor } from '../sandbox/index.ts';
import { AppError } from './deps.ts';
import type {
  ExecProxyPort,
  HostPort,
  LifecycleDisposer,
  TargetContextPort,
  WorktreePort,
  WriteTargetContext,
} from './types.ts';

/** `WorktreePort` 未装配时的错误码（W4-N 接上 `git/` 之后这个错误就不再出现）。 */
export const WORKTREE_UNAVAILABLE = 'WORKTREE_UNAVAILABLE';

/**
 * 默认的 worktree 端口：**抛错**。
 *
 * 为什么不是 `os.tmpdir()` 里随便建一个目录：那样 agent 会在一个空的、与仓库无关的
 * 目录里「跑测试并通过」，产出的结论是假的；而 `workspace/diff` 与写回闸门
 * （`declared ∩ actual`）都会失去意义（tech-plan §5.6 的整段理由）。
 */
export function createUnavailableWorktreePort(): WorktreePort {
  return {
    create: async (input) => {
      throw new AppError(
        'worktree 端口未装配：真实检出归 git/ owner（W4-N），本切片只有窄接口',
        {
          code: WORKTREE_UNAVAILABLE,
          failureClass: 'sandbox',
          retriable: false,
          details: { taskId: input.taskId, repo: input.repo },
        },
      );
    },
  };
}

/** `sandbox/exec-proxy.ts` → `ExecProxyPort`。 */
export function createExecProxyPort(proxy: ExecProxy): ExecProxyPort {
  return {
    async listen(input) {
      const endpoint = await proxy.listen({
        jobId: input.jobId,
        jobDir: input.jobDir,
        containerId: input.containerId,
      });
      return {
        address: endpoint.address.canonical,
        ...(endpoint.socketPath === undefined ? {} : { socketPath: endpoint.socketPath }),
      };
    },
    async destroy(target) {
      await proxy.destroy({ jobId: target.jobId });
    },
  };
}

/** `sandbox/lifecycle.ts::LifecycleExecutor` → `LifecycleDisposer`。 */
export function createLifecycleDisposer(executor: LifecycleExecutor): LifecycleDisposer {
  return {
    async dispose(input) {
      return executor.dispose({
        jobId: input.jobId,
        containerId: input.containerId,
        jobDir: input.jobDir,
        outcome: input.outcome,
      });
    },
  };
}

/**
 * `runtime/host-supervisor.ts::HostSupervisor` → `HostPort`。
 *
 * `token` 是**设备令牌**（`PI_BOT_HOST_TOKEN` / `host_credentials` 解出来的 `pdt1.…`）：
 * 常驻 Host 不用 `--pair` 启动，`info.pairing` 永远是 `undefined`，
 * 所以「连上去用什么令牌」必须由装配层显式传入，不能指望从 READY 行里拿到。
 */
export function createSupervisorHostPort(
  supervisor: HostSupervisor,
  options: { readonly token?: string | undefined } = {},
): HostPort {
  return {
    async ready() {
      const info = supervisor.info ?? (await supervisor.start());
      const token = options.token ?? (info.pairing === undefined ? undefined : info.pairing.token);
      return {
        hostId: info.hostId,
        port: info.port,
        version: info.version,
        ...(token === undefined || token === '' ? {} : { token }),
      };
    },
    async stop() {
      await supervisor.stop();
    },
  };
}

/**
 * 空的「目标现状」端口：标签集为空、去重键未命中、今日未创建。
 *
 * 它是**保守**的默认值（不是「随机值」）：标签动作为空集合 → 只加不减；
 * `create_issue` 会按「未命中 + 未超配额」执行，因此生产装配必须接真实实现
 * （`issue_states` / `issue_fingerprints` / `bot_labels` 的 owner 提供）。
 */
export function createEmptyTargetContextPort(): TargetContextPort {
  return {
    load: async (): Promise<WriteTargetContext> => ({}),
  };
}
