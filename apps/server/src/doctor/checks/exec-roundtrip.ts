/**
 * `exec-roundtrip`：在临时 job 目录里建 `0600` 端点 → 起 `ExecProxy` → 客户端跑通一次 `echo ok`
 * （tech-plan §6.4 最后一项 / §4.5 的端到端自检，dev-plan §6 的 M0 ⛔「命令真的在容器里」的入口）。
 *
 * 这条检查覆盖的是**最容易悄悄坏掉的一整条链**：
 *   job 目录 → `.pi-bot/`（0700）→ 端点监听（unix socket / Windows 命名管道）
 *   → 端点描述文件（`exec.endpoint`，0600）→ 帧协议 → 代理查表 → `docker exec` → 末帧退出码。
 *
 * 三个刻意的选择：
 *  1. **用假 docker**：本检查验证的是「代理 ↔ 客户端」这一段（真容器的端到端在
 *     `test/sandbox-docker.test.ts` 里跑）。预检不该依赖某个镜像此刻可用——镜像缺失是
 *     `image` 那一条的事，这里失败会掩盖真正的原因。
 *  2. **临时目录 + 收干净**：`mkdtemp` 在系统临时目录下建，结束（含异常）一律 `rm`，
 *     不往仓库或数据目录留垃圾。
 *  3. **端点文件权限真的是 600**：POSIX 上断言 `mode & 0o777 === 0o600`。Windows 的命名管道
 *     没有 POSIX 权限位，报告里明确写「按管道判定」，不假装验过。
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { SandboxDocker } from '../../sandbox/docker.ts';
import { ExecProxy } from '../../sandbox/exec-proxy.ts';
import type { ParsedListenAddress } from '../../sandbox/exec-proxy.ts';
import { createFrameDecoder } from '../../sandbox/protocol.ts';
import { describeError } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

/** 一次往返的总预算（含监听、连接、末帧）。 */
export const ROUNDTRIP_TIMEOUT_MS = 10_000;

/** 端点文件的期望权限（§4.5）。 */
export const ENDPOINT_FILE_MODE = 0o600;

export interface RoundTripResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 假 docker：只会「把命令的输出回显出来」。`createContainer` / `inspectState` 故意抛错——
 * 这条检查不该走到它们，真走到了说明代理的行为变了，报错比静默通过好。
 */
export function createEchoDocker(stdoutChunk = 'ok\n', exitCode = 0): SandboxDocker {
  return {
    async ping(): Promise<void> {},
    async createContainer(): Promise<string> {
      throw new Error('exec-roundtrip 的假 docker 不创建容器');
    },
    async inspectState(): Promise<never> {
      throw new Error('exec-roundtrip 的假 docker 不 inspect 容器');
    },
    async execStream(request): Promise<{ exitCode: number }> {
      request.onStdout(Buffer.from(stdoutChunk, 'utf8'));
      return { exitCode };
    },
    async destroyContainer(): Promise<void> {},
  };
}

type Frame =
  | { readonly stream: 'stdout' | 'stderr'; readonly data: string }
  | { readonly exitCode: number }
  | { readonly error: { readonly code: string; readonly message?: string } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把一帧归一成三态之一；不认识的帧抛错（代理只会写自己生成的帧，读到别的说明对面不对）。 */
function toFrame(value: unknown): Frame {
  if (!isRecord(value)) {
    throw new Error(`代理回了非对象帧：${JSON.stringify(value)}`);
  }
  if (typeof value['exitCode'] === 'number') {
    return { exitCode: value['exitCode'] };
  }
  const error = value['error'];
  if (isRecord(error) && typeof error['code'] === 'string') {
    return {
      error: {
        code: error['code'],
        ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}),
      },
    };
  }
  const stream = value['stream'];
  const data = value['data'];
  if ((stream === 'stdout' || stream === 'stderr') && typeof data === 'string') {
    return { stream, data };
  }
  throw new Error(`代理回了未知帧：${JSON.stringify(value)}`);
}

/**
 * 客户端往返：一帧请求 → 若干 NDJSON 响应 → 末帧退出码。
 * 用与 `exec-client.mjs` 相同的协议（`{argv,cwd,clientPid}`），但在这里内联实现：
 * 预检要的是「协议与代理都在」，多起一个子进程只会多一条可能失败的路。
 */
export function roundTrip(
  address: ParsedListenAddress,
  cwd: string,
  argv: readonly string[] = ['echo', 'ok'],
  timeoutMs: number = ROUNDTRIP_TIMEOUT_MS,
): Promise<RoundTripResult> {
  return new Promise<RoundTripResult>((resolve, reject) => {
    const socket = net.connect(address.path);
    const decode = createFrameDecoder();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error: Error | undefined, value?: RoundTripResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value ?? { exitCode: -1, stdout, stderr });
    };

    const timer = setTimeout(() => {
      finish(new Error(`往返超时（${String(timeoutMs)}ms）：${address.canonical}`));
    }, timeoutMs);
    timer.unref?.();

    socket.setNoDelay(true);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ argv: [...argv], cwd, clientPid: process.pid })}\n`);
    });
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = decode(chunk);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const raw of frames) {
        let frame: Frame;
        try {
          frame = toFrame(raw);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if ('stream' in frame) {
          const text = Buffer.from(frame.data, 'base64').toString('utf8');
          if (frame.stream === 'stdout') {
            stdout += text;
          } else {
            stderr += text;
          }
          continue;
        }
        if ('exitCode' in frame) {
          finish(undefined, { exitCode: frame.exitCode, stdout, stderr });
          return;
        }
        finish(new Error(`代理报错 ${frame.error.code}：${frame.error.message ?? ''}`));
        return;
      }
    });
    socket.on('error', (error: Error) => {
      finish(error);
    });
    socket.on('close', () => {
      if (!settled) {
        finish(new Error('代理在给出退出码之前就断开了连接'));
      }
    });
  });
}

export const execRoundtripCheck: CheckDefinition = {
  id: 'exec-roundtrip',
  title: '临时 job 目录 0600 端点 + exec 代理往返',
  async run(ctx) {
    const started = ctx.elapsed();
    let jobDir: string;
    try {
      jobDir = await ctx.fs.mkdtemp(path.join(os.tmpdir(), 'pi-bot-doctor-'));
    } catch (error) {
      return {
        status: 'fail',
        detail: `建临时 job 目录失败：${describeError(error)}`,
        fixHint: '确认 TMPDIR（或系统临时目录）可写；doctor 需要在里面建 0700 目录与 0600 端点',
      };
    }

    const jobId = `doctor-${String(process.pid)}-${Date.now().toString(36)}`;
    const proxy = new ExecProxy({
      docker: ctx.roundtripDocker ?? createEchoDocker(),
      platform: ctx.platform,
      defaultTimeoutMs: 5_000,
    });

    try {
      const endpoint = await proxy.listen({ jobId, jobDir, containerId: `${jobId}-container` });

      if (ctx.platform !== 'win32') {
        const info = await ctx.fs.stat(endpoint.endpointFile);
        const mode = info.mode & 0o777;
        if (mode !== ENDPOINT_FILE_MODE) {
          return {
            status: 'fail',
            detail: `${endpoint.endpointFile} 权限是 ${mode.toString(8).padStart(3, '0')}，不是 600（§4.5 要求 0600）`,
            fixHint: '端点描述文件必须是 0600：它决定「谁能把命令接到这个 job 的容器上」',
          };
        }
      }

      const result = await roundTrip(endpoint.address, jobDir);
      const elapsedMs = Math.max(0, Math.round(ctx.elapsed() - started));
      if (result.exitCode !== 0) {
        return {
          status: 'fail',
          detail: `往返完成但退出码 ${String(result.exitCode)}（stdout=${JSON.stringify(result.stdout)}）`,
          fixHint: '代理的末帧退出码没有透传；看 sandbox/exec-proxy.ts 与 protocol.ts',
        };
      }
      if (result.stdout.trim() !== 'ok') {
        return {
          status: 'fail',
          detail: `往返输出不对：期望 "ok"，实到 ${JSON.stringify(result.stdout)}`,
          fixHint: '帧解码或 stdout 流式回传有问题（sandbox/protocol.ts 的 createFrameDecoder）',
        };
      }

      const modeNote =
        ctx.platform === 'win32' ? 'Windows 命名管道（无 POSIX 权限位）' : '端点文件 0600';
      return {
        status: 'ok',
        detail:
          `${modeNote}；${endpoint.address.canonical} 往返 echo ok → exit 0（${String(elapsedMs)}ms；` +
          `临时目录 ${jobDir}）`,
      };
    } catch (error) {
      return {
        status: 'fail',
        detail: `端点/往返失败：${describeError(error)}`,
        fixHint:
          '确认平台端点可用（Linux unix socket / Windows 命名管道），' +
          '且临时目录路径不含 UNC 段（sandbox/paths.ts 会拒）',
      };
    } finally {
      // 收干净：端点、映射、临时目录都不留给下一次检查（异常路径也要走到）
      try {
        await proxy.destroyAll();
      } catch {
        // 销毁失败不该把「检查结果」改写成另一个错误
      }
      try {
        await ctx.fs.rm(jobDir);
      } catch {
        // 同上
      }
    }
  },
};
