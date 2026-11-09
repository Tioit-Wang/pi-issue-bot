#!/usr/bin/env node
/**
 * exec-client：把 host-core 的 `bash -lc <cmd>` 转成 exec 代理的一帧请求，再把结果打回标准流。
 * 这是 shim（`scripts/sandbox-bash`）唯一会 `exec` 的东西——**客户端不碰 docker**。
 *
 * 用法：
 *   exec-client <endpoint> <cwd> [argv...]
 *
 * `<endpoint>` 可以是（三种形态都是为了 Windows 命名管道，生产只走第一种）：
 *   1. `<job_dir>/.pi-bot/exec.endpoint` 描述文件：内容是 `unix:/abs/exec.sock` 或 `pipe:\\.\pipe\pi-bot-<id>`
 *   2. 直接给 `unix:<abs>` / `pipe:<name>`
 *   3. 裸的 socket 文件路径或管道名
 *
 * 退出码（dev-plan §11 E7 的裁定，必须与 `errors.ts` 的 `EXIT_CODE_BY_ERROR_CODE` 一致）：
 *   0   命令跑完且退出码为 0
 *   1   命令跑完但退出码非 0，或代理报其他错误（EXEC_FAILED / BAD_REQUEST …）
 *   2   NO_EXEC_ENDPOINT：端点找不到 / 连不上
 *   3   CWD_OUTSIDE_JOB：cwd 不在该 job 目录内
 */
import fs from 'node:fs';
import net from 'node:net';
import process from 'node:process';

const EXIT_BY_CODE = {
  NO_EXEC_ENDPOINT: 2,
  CWD_OUTSIDE_JOB: 3,
};

function writeErr(text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(code, message) {
  writeErr(`pi-bot: ${code}: ${message}`);
  process.exitCode = EXIT_BY_CODE[code] ?? 1;
  process.exit(process.exitCode);
}

/** 把「端点参数」归一成 `{kind, target}`。读不到描述文件就当作裸地址。 */
function resolveEndpoint(raw) {
  let text = raw;
  try {
    const stats = fs.statSync(raw, { throwIfNoEntry: false });
    if (stats && stats.isFile()) {
      text = fs.readFileSync(raw, 'utf8').trim();
    }
  } catch {
    // 描述文件读不了：按裸地址处理，让后面 connect 给出真实错误
  }
  if (text.startsWith('unix:')) {
    return { kind: 'unix', target: text.slice('unix:'.length) };
  }
  if (text.startsWith('pipe:')) {
    return { kind: 'pipe', target: text.slice('pipe:'.length) };
  }
  if (text.startsWith('\\\\') || text.startsWith('//./pipe')) {
    return { kind: 'pipe', target: text };
  }
  return { kind: 'unix', target: text };
}

function main() {
  const [endpointArg, cwd, ...argv] = process.argv.slice(2);
  if (!endpointArg) {
    fail('NO_EXEC_ENDPOINT', '缺少端点参数（用法：exec-client <endpoint> <cwd> <argv...>）');
  }
  if (!cwd) {
    fail('BAD_REQUEST', '缺少 cwd 参数');
  }
  if (argv.length === 0) {
    fail('BAD_REQUEST', '缺少要执行的命令');
  }
  const endpoint = resolveEndpoint(endpointArg);
  const request = { argv, cwd, clientPid: process.pid };

  const socket = net.connect(endpoint.target);
  socket.setNoDelay(true);
  let buffer = '';
  let finished = false;

  const finish = (code) => {
    if (finished) {
      return;
    }
    finished = true;
    socket.end();
    process.exitCode = code;
    process.exit(code);
  };

  socket.on('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.length === 0) {
        continue;
      }
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        fail('EXEC_FAILED', `代理回了非法帧：${line.slice(0, 200)}`);
      }
      if (frame.stream === 'stdout') {
        process.stdout.write(Buffer.from(frame.data, 'base64'));
      } else if (frame.stream === 'stderr') {
        process.stderr.write(Buffer.from(frame.data, 'base64'));
      } else if (typeof frame.exitCode === 'number') {
        if (frame.truncated === true) {
          writeErr('pi-bot: WARN: 输出超过 1 MB 已被截断（truncated）');
        }
        finish(frame.exitCode);
        return;
      } else if (frame.error && typeof frame.error.code === 'string') {
        writeErr(`pi-bot: ${frame.error.code}: ${frame.error.message ?? ''}`);
        finish(EXIT_BY_CODE[frame.error.code] ?? 1);
        return;
      }
    }
  });
  socket.on('error', (error) => {
    // 连接阶段失败 = 端点不存在（shim 的 NO_EXEC_ENDPOINT 语义）；已连上后失败 = 跑挂了。
    const connectPhase = !socket.remoteAddress && !finished;
    if (connectPhase || error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
      fail('NO_EXEC_ENDPOINT', `连不上端点 ${endpointArg}（${error.code ?? error.message}）`);
    }
    fail('EXEC_FAILED', `端点连接中断：${error.message}`);
  });
  socket.on('close', () => {
    if (!finished) {
      // 代理没给末帧就断了：不能假装成功
      fail('EXEC_FAILED', '代理在给出退出码之前就断开了连接');
    }
  });
}

main();
