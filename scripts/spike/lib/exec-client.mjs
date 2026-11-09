#!/usr/bin/env node
// 运行环境：目标 Linux 主机（宿主已有 Node 24，见 tech-plan v1.1 §4.5）；本开发机无 docker，只与 stub-exec-proxy 联调过。
// 依据：docs/tech-plan.md v1.1 §4.5 —— 协议是「单帧请求 + NDJSON 回传」：
//   客户端 → {"argv":["bash","-lc","<cmd>"],"cwd":"<abs>","clientPid":<pid>}
//   代理 → {"stream":"stdout"|"stderr","data":"<base64>"} … 末帧 {"exitCode":N} 或 {"error":{"code":"…"}}
// 角色：本文件是 /usr/local/lib/pi-bot/exec-client 的仓库内副本（spike 级实现，≈90 行）。
// 退出码：命令退出码原样透传；端点不可达 → 3；代理回 error → 3。找到端点后 shim 已 exec 进来，故 2 只可能来自 shim 的发现阶段。
//
// 测试用扩展（生产不用）：端点可写成 `tcp://127.0.0.1:<port>`，便于在无 unix socket 的开发机上跑通整条链。

import net from "node:net";

const [sockSpec, cwd, ...rest] = process.argv.slice(2);
if (!sockSpec || !cwd) {
  console.error("usage: exec-client <sock|tcp://host:port> <cwd> [bash args...]");
  process.exit(64);
}

const req = { argv: ["bash", ...rest], cwd, clientPid: process.pid };

let sock;
if (sockSpec.startsWith("tcp://")) {
  const u = new globalThis.URL(sockSpec);
  sock = net.connect(Number(u.port), u.hostname);
} else {
  sock = net.connect(sockSpec);
}
sock.setNoDelay(true);

let buf = "";
let exitCode = null;
let failed = null;

sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));

sock.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  for (;;) {
    const i = buf.indexOf("\n");
    if (i < 0) break;
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`pi-bot: EXEC_PROTOCOL_ERROR: 非 JSON 帧: ${line.slice(0, 200)}\n`);
      failed = "protocol";
      continue;
    }
    if (msg.stream === "stdout" || msg.stream === "stderr") {
      const data = Buffer.from(msg.data || "", "base64");
      (msg.stream === "stderr" ? process.stderr : process.stdout).write(data);
    } else if (msg.exitCode !== undefined) {
      exitCode = Number(msg.exitCode);
      sock.end();
    } else if (msg.error) {
      process.stderr.write(`pi-bot: EXEC_ERROR: ${msg.error.code || "UNKNOWN"}: ${msg.error.message || ""}\n`);
      failed = msg.error.code || "EXEC_ERROR";
      sock.end();
    } else {
      process.stderr.write(`pi-bot: EXEC_PROTOCOL_ERROR: 未知帧: ${line.slice(0, 200)}\n`);
      failed = "protocol";
    }
  }
});

sock.on("error", (e) => {
  process.stderr.write(`pi-bot: EXEC_ENDPOINT_ERROR: ${sockSpec}: ${e.message}\n`);
  failed = failed || "ENDPOINT";
});

sock.on("close", () => {
  if (failed) process.exit(3);
  process.exit(exitCode === null ? 3 : exitCode);
});
