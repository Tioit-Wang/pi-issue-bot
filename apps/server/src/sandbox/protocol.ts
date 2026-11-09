/**
 * exec 代理的线协议（tech-plan §4.5「协议（极简，单向流）」）。
 *
 * 请求帧（客户端 → 代理，**一帧即止**）：
 *   `{"argv":["bash","-lc","<cmd>"],"cwd":"<abs>","clientPid":123}`
 *
 * 响应帧（代理 → 客户端，NDJSON，一行一帧）：
 *   `{"stream":"stdout"|"stderr","data":"<base64>"}` …
 *   末帧 `{"exitCode":N}` 或 `{"error":{"code":"…"}}`
 *
 * 三条硬规定（同一节 + dev-plan §11 E3/E7）：
 *   1. **只接受 `argv` + `cwd`（+ `clientPid`）**：不收 shell 字符串、不收容器名、不透传 env。
 *      实现方式是白名单：出现任何其他键就 `BAD_REQUEST`，而不是「忽略未知键」——
 *      静默忽略会让「谁传了什么」从审计里消失。
 *   2. `argv` 必须是字符串数组，**至少一项**；代理只取最后一项当 shell 命令（§4.5）。
 *   3. 输出合计上限 1 MB，超出截断并在末帧标 `truncated`。
 */
import { SandboxError } from './errors.ts';

/** stdout/stderr 合计默认上限：1 MB（§4.5）。 */
export const EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024;

export interface ExecRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly clientPid?: number;
}

export type ExecResponseFrame =
  | { readonly stream: 'stdout' | 'stderr'; readonly data: string }
  | { readonly exitCode: number; readonly truncated?: boolean }
  | { readonly error: { readonly code: string; readonly message?: string } };

/** 请求帧允许出现的键（白名单）。 */
export const EXEC_REQUEST_KEYS: readonly string[] = Object.freeze(['argv', 'cwd', 'clientPid']);

function badRequest(message: string, details?: Record<string, unknown>): SandboxError {
  return new SandboxError(message, { code: 'BAD_REQUEST', details });
}

/**
 * 严格校验请求帧。**故意写成白名单**：`{argv, cwd, shell: "..."}`、`{container: "pi-job-x"}`
 * 这类「顺手多传一个字段」必须报错，否则能力边界会一点点被扩大（§4.5 E3）。
 */
export function parseExecRequest(value: unknown): ExecRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('请求帧必须是 JSON 对象');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!EXEC_REQUEST_KEYS.includes(key)) {
      throw badRequest(`请求帧不接受字段「${key}」（只允许 argv / cwd / clientPid）`, { key });
    }
  }
  const { argv, cwd, clientPid } = record;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string')) {
    throw badRequest('argv 必须是非空的字符串数组');
  }
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw badRequest('cwd 必须是非空字符串');
  }
  if (clientPid !== undefined && (typeof clientPid !== 'number' || !Number.isInteger(clientPid))) {
    throw badRequest('clientPid 必须是整数');
  }
  return { argv: argv.map((item) => String(item)), cwd, clientPid };
}

/** 一帧的线上表示：单行 JSON（NDJSON）。 */
export function encodeFrame(frame: ExecResponseFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 增量解码器：TCP / 命名管道的 chunk 边界和帧边界无关，必须自己攒 buffer。
 * 畸形行直接抛 `BAD_REQUEST`——代理只会往这条连接上写自己生成的帧，读到垃圾说明对面不对。
 */
export function createFrameDecoder(): (chunk: Buffer | string) => unknown[] {
  let buffer = '';
  return (chunk: Buffer | string): unknown[] => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const frames: unknown[] = [];
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          frames.push(JSON.parse(line));
        } catch (cause) {
          throw badRequest('响应帧不是合法 JSON', { line: line.slice(0, 200), cause });
        }
      }
      index = buffer.indexOf('\n');
    }
    return frames;
  };
}

/** 输出记账：超上限后只记账不再转发，末帧用 `truncated` 告知客户端「你看到的是残的」。 */
export function createOutputBudget(limitBytes: number = EXEC_OUTPUT_LIMIT_BYTES): {
  take(bytes: number): number;
  readonly truncated: boolean;
  readonly sent: number;
} {
  let sent = 0;
  let truncated = false;
  return {
    /** 返回本次允许转发的字节数（0 表示已超限）。 */
    take(bytes: number): number {
      const remaining = limitBytes - sent;
      if (remaining <= 0) {
        truncated = true;
        return 0;
      }
      const allowed = Math.min(bytes, remaining);
      sent += allowed;
      if (allowed < bytes) {
        truncated = true;
      }
      return allowed;
    },
    get truncated(): boolean {
      return truncated;
    },
    get sent(): number {
      return sent;
    },
  };
}
