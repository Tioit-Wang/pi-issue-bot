#!/usr/bin/env node
// 运行环境：目标 Linux 主机（--mode docker 需要 docker + 真实容器）；本开发机无 docker，只用 --mode stub 联调过。
// 依据：docs/tech-plan.md v1.1 §4.5（F1/F3）—— 这是「bot 进程里的 exec 代理」的最小桩：
//   - 在 <job_dir>/.pi-bot/exec.sock 监听（目录 0700、socket 0600，退出时 unlink）；
//   - 按「job → 容器名」映射表查容器（**不再由路径 sha1 推导**）；
//   - 收单帧请求 {"argv":["bash","-lc","<cmd>"],"cwd":"<abs>","clientPid":N}，
//     回 NDJSON：{"stream":"stdout"|"stderr","data":"<base64>"} … 末帧 {"exitCode":N} 或 {"error":{"code":"…"}}；
//   - docker 模式按 v1.1 §4.5 执行：docker exec -i -e PI_CMD_ID=<uuid> -w <cwd|job_dir> <c> timeout -s KILL <n> bash -lc "<cmd>"，
//     并在超时后走 §4.7 的宿主侧兜底。
//
// 用法：
//   node stub-exec-proxy.mjs --mode stub   --listen <sock|tcp://127.0.0.1:PORT> --map <job_dir>=<容器名> [--exit N] [--echo-argv] [--log f]
//   node stub-exec-proxy.mjs --mode docker --listen … --map … [--cmd-timeout-s 120] [--pkill-fallback] [--log f]
// 写入：只写 --log 指定的 JSONL 与 socket 本身（及其 `<job>/.pi-bot/` 目录）。stub 模式不接触 docker。

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);

// 路径归一化：v1.1 里两侧都是 Linux 绝对路径，本无需处理；但 cwd 由 shim 的 `pwd -P` 提供，
// 不同 shell/平台上分隔符与尾斜杠写法可能不同（本仓库的 a1 在 Windows/MSYS 上就踩到过：\ 与 / 混用），
// 所以比较前统一成 `/` 分隔、去尾斜杠，**不做 path.resolve**（避免把 `/c/...` 之类的真实路径改写）。
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

const MODE = opt("mode", "stub");
const LISTEN = opt("listen");
const LOG = opt("log");
const EXIT_CODE = Number(opt("exit", "0"));
const ECHO_ARGV = flag("echo-argv");
const STDERR_LINE = opt("stderr", "");
const SLEEP_MS = Number(opt("sleep-ms", "0"));
const CMD_TIMEOUT_S = Number(opt("cmd-timeout-s", "120"));
const PKILL_FALLBACK = flag("pkill-fallback");

// --map job_dir=container（可重复）
const MAP = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--map" && argv[i + 1]) {
    const [dir, container] = argv[i + 1].split("=");
    if (dir && container) MAP.push({ dir, normDir: norm(dir), container });
  }
}
if (!LISTEN) {
  console.error("需要 --listen <sock|tcp://127.0.0.1:PORT>");
  process.exit(64);
}
if (MAP.length === 0) {
  console.error("需要至少一个 --map <job_dir>=<容器名>");
  process.exit(64);
}

function log(o) {
  const line = JSON.stringify({ t: Date.now(), mode: MODE, ...o });
  if (LOG) fs.appendFileSync(LOG, line + "\n");
  process.stderr.write(line + "\n");
}

function resolve(cwd) {
  const ncwd = norm(cwd);
  let best = null;
  for (const m of MAP) {
    if (ncwd === m.normDir || ncwd.startsWith(m.normDir + "/")) {
      if (!best || m.normDir.length > best.normDir.length) best = m;
    }
  }
  if (!best) return null;
  const workdir = ncwd === best.normDir ? cwd : cwd;
  return { container: best.container, jobDir: best.dir, workdir };
}

function openServer(onConn) {
  if (!LISTEN.startsWith("tcp://")) {
    const dir = path.dirname(LISTEN);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.unlinkSync(LISTEN);
    } catch {}
  }
  const server = net.createServer(onConn);
  server.on("error", (e) => {
    console.error(`stub-exec-proxy: listen 失败 ${LISTEN}: ${e.message}`);
    process.exit(1);
  });
  if (LISTEN.startsWith("tcp://")) {
    const u = new URL(LISTEN);
    server.listen(Number(u.port), u.hostname, () => {
      log({ kind: "listening", transport: "tcp", addr: LISTEN });
      console.log("PROXY_READY " + JSON.stringify({ mode: MODE, listen: LISTEN }));
    });
  } else {
    server.listen(LISTEN, () => {
      try {
        fs.chmodSync(LISTEN, 0o600);
      } catch {}
      log({ kind: "listening", transport: "unix", addr: LISTEN });
      console.log("PROXY_READY " + JSON.stringify({ mode: MODE, listen: LISTEN }));
    });
  }
  return server;
}

function onConn(sock) {
  let buf = "";
  let resolved = null;
  let req = null;
  const cmdId = `PI_CMD_ID=${crypto.randomUUID()}`;

  const send = (o) => sock.write(JSON.stringify(o) + "\n");
  const sendStream = (stream, chunk) => send({ stream, data: Buffer.from(chunk).toString("base64") });

  sock.on("error", (e) => log({ kind: "conn-error", message: e.message }));

  sock.on("data", (chunk) => {
    if (req) return; // v1.1：单帧请求，之后不再读 stdin（Bash 工具没有交互 stdin）
    buf += chunk.toString("utf8");
    const i = buf.indexOf("\n");
    if (i < 0) return;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log({ kind: "protocol-error", raw: line.slice(0, 300) });
      send({ error: { code: "BAD_REQUEST", message: "frame is not JSON" } });
      return sock.end();
    }
    req = msg;
    const cwd = String(msg.cwd || "");
    resolved = resolve(cwd);
    log({
      kind: "request",
      argv: msg.argv,
      argv0: Array.isArray(msg.argv) ? msg.argv[0] : null,
      cmd: Array.isArray(msg.argv) ? msg.argv[2] : null,
      cwd,
      clientPid: msg.clientPid,
      cmdId,
      resolve: resolved,
    });
    if (!resolved) {
      send({ error: { code: "NO_JOB_MAPPING", message: `cwd 不在任何 job 映射内: ${cwd}` } });
      return sock.end();
    }
    if (MODE === "stub") return runStub(sock, send, sendStream);
    return runDocker(sock, send, sendStream, cmdId);
  });

  function runStub(sock, send, sendStream) {
    const payload = JSON.stringify({ argv: req.argv, cwd: req.cwd, container: resolved.container });
    if (ECHO_ARGV) sendStream("stdout", `STUB-EXEC ${payload}\n`);
    if (STDERR_LINE) sendStream("stderr", `${STDERR_LINE}\n`);
    const done = () => {
      log({ kind: "result", exitCode: EXIT_CODE, stub: true });
      send({ exitCode: EXIT_CODE });
      sock.end();
    };
    if (SLEEP_MS > 0) setTimeout(done, SLEEP_MS);
    else done();
  }

  function runDocker(sock, send, sendStream, cmdId) {
    const cmd = Array.isArray(req.argv) ? req.argv[req.argv.length - 1] : "";
    const execArgv = [
      "exec",
      "-i",
      "-e",
      cmdId,
      "-w",
      resolved.workdir,
      resolved.container,
      "timeout",
      "-s",
      "KILL",
      String(CMD_TIMEOUT_S),
      "bash",
      "-lc",
      cmd,
    ];
    log({ kind: "docker-exec", argv: execArgv, container: resolved.container, timeoutS: CMD_TIMEOUT_S, cmdId });
    const child = spawn("docker", execArgv, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => sendStream("stdout", c));
    child.stderr.on("data", (c) => sendStream("stderr", c));
    child.on("error", (e) => {
      log({ kind: "spawn-error", message: e.message });
      send({ error: { code: "DOCKER_SPAWN_FAILED", message: e.message } });
      sock.end();
    });
    child.on("close", (code, signal) => {
      const exitCode = signal ? 128 + (osSignalNumber(signal) || 0) : code ?? 1;
      log({ kind: "result", exitCode, signal, container: resolved.container, cmdId });
      // v1.1 §4.7 的宿主侧兜底：超时（137）时清一次残留。
      if (PKILL_FALLBACK && exitCode === 137) {
        sweepResidual(cmdId, resolved.container, sock, send, () => {
          send({ exitCode });
          sock.end();
        });
        return;
      }
      send({ exitCode });
      sock.end();
    });
  }

  // 兜底：v1.1 字面写的是 `pkill -KILL -f "PI_CMD_ID=<uuid>"`，但 uuid 只经 `-e` 注入环境变量，
  // 而 pkill -f 只匹配 /proc/<pid>/cmdline，**匹配不到 env**。这里按 environ 扫，并把两种做法的差异记进日志。
  function sweepResidual(cmdId, container, sock, send, done) {
    const script =
      'for p in /proc/[0-9]*; do if grep -qa "$1" "$p/environ" 2>/dev/null; then kill -KILL "${p#/proc/}" 2>/dev/null && echo "killed ${p#/proc/}"; fi; done';
    log({ kind: "pkill-fallback", strategy: "proc-environ", note: "pkill -f 匹配不到 env 注入的 PI_CMD_ID", container, cmdId });
    const p = spawn("docker", ["exec", container, "sh", "-c", script, "sh", cmdId], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => done());
    p.on("close", () => {
      log({ kind: "pkill-result", container, cmdId, killed: out.trim() });
      done();
    });
  }
}

function osSignalNumber(name) {
  return { SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGSEGV: 11 }[name] || 0;
}

const server = openServer(onConn);
const shutdown = () => {
  try {
    server.close();
  } catch {}
  if (!LISTEN.startsWith("tcp://")) {
    try {
      fs.unlinkSync(LISTEN);
    } catch {}
  }
  log({ kind: "shutdown" });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
