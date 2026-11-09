#!/usr/bin/env node
// 运行环境：目标 Linux 主机（node ≥22）；本开发机无 docker，本脚本未用于实测。
// 作用：B0 spike 的最小 RACP 驱动 —— 配对、建 session、跑一个 turn、并发跑 N 个 turn 并算重叠度。
//
// 为什么自带 WebSocket 帧层：RACP 要求 `Authorization: Bearer <令牌>` 头，而 node 内置的全局
// WebSocket（undici）不支持自定义头，仓库又不允许装依赖。所以这里只实现握手 + 文本帧（含 ping/pong/close）。
//
// 契约边界（重要）：RACP 的权威契约是 packages/shared/fixtures/racp.schema.json。
//   本脚本对字段名采取「先精确取值、取不到就深搜同义键」的宽容策略，并把**每一帧原文**写进 --log JSONL。
//   一旦找不到必需值，会打印 SCHEMA_SUSPECT + 原始帧，然后退出 —— 不猜、不静默。
//
// 用法：
//   node racp-drive.mjs pair       --url ws://127.0.0.1:<port>/racp --token ppt1.… [--out token.txt]
//   node racp-drive.mjs run        --url … --token pdt1.… --project <dir> --prompt <text> [--label A1]
//   node racp-drive.mjs concurrent --url … --token pdt1.… --project <dir> --prompt <text> --n 4 [--label B4]
// 公共参数：--log <jsonl>（默认 $PI_BOT_SPIKE_TMP/racp-<label|cmd>.jsonl）、
//          --subprotocol <name>（或 env RACP_SUBPROTOCOL）、--wait-ms <默认 600000>、--poll-ms <默认 2000>

import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const CMD = argv[0];
function arg(name, dflt = undefined) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}
const LABEL = arg("label", CMD);
const URL_RAW = arg("url");
const TOKEN = arg("token");
const SUBPROTO = arg("subprotocol", process.env.RACP_SUBPROTOCOL || "");
const WAIT_MS = Number(arg("wait-ms", 600000));
const POLL_MS = Number(arg("poll-ms", 2000));
const LOG_PATH =
  arg("log") ||
  path.join(process.env.PI_BOT_SPIKE_TMP || path.join(process.env.TMPDIR || "/tmp", "pi-bot-spike"), `racp-${LABEL}.jsonl`);

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
function rec(o) {
  const line = JSON.stringify({ t: Date.now(), label: LABEL, ...o });
  fs.appendFileSync(LOG_PATH, line + "\n");
  process.stderr.write(line + "\n");
}

function die(msg, extra) {
  console.error(`\n[warn] ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(2);
}

// ---------------- 最小 WebSocket（客户端） ----------------
function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(6);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(8);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(14);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81; // FIN + text
  const mask = crypto.randomBytes(4);
  mask.copy(head, head.length - 4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, body]);
}

class WsClient {
  constructor({ url, token, subprotocol, onText, onClose }) {
    const u = new globalThis.URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || 80);
    this.reqPath = u.pathname + (u.search || "");
    this.token = token;
    this.subprotocol = subprotocol;
    this.onText = onText;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frag = Buffer.alloc(0);
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const lines = [
        `GET ${this.reqPath} HTTP/1.1`,
        `Host: ${this.host}:${this.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Authorization: Bearer ${this.token}`,
      ];
      if (this.subprotocol) lines.push(`Sec-WebSocket-Protocol: ${this.subprotocol}`);
      const req = lines.join("\r\n") + "\r\n\r\n";

      this.sock = net.connect(this.port, this.host, () => this.sock.write(req));
      this.sock.setNoDelay(true);
      this.sock.on("error", (e) => {
        rec({ dir: "sys", kind: "socket-error", message: String(e && e.message) });
        reject(e);
      });
      this.sock.on("close", () => {
        this.closed = true;
        rec({ dir: "sys", kind: "socket-close" });
        this.onClose && this.onClose();
      });
      this.sock.on("data", (chunk) => (this.handshaken ? this._frames(chunk) : this._handshake(chunk, resolve, reject)));
      this.sock.on("timeout", () => reject(new Error("socket timeout")));
      this.sock.setTimeout(15000);
    });
  }

  _handshake(chunk, resolve, reject) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const end = this.buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = this.buf.subarray(0, end).toString("latin1");
    const rest = this.buf.subarray(end + 4);
    this.buf = Buffer.alloc(0);
    const status = head.split("\r\n")[0] || "";
    rec({ dir: "sys", kind: "handshake", status, headers: head.split("\r\n").slice(1) });
    if (!/ 101 /.test(status)) {
      this.sock.destroy();
      return reject(new Error(`WebSocket 握手被拒：${status.trim()}（检查 Authorization / 子协议 / 端口）`));
    }
    this.handshaken = true;
    this.sock.setTimeout(0);
    resolve(head);
    if (rest.length) this._frames(rest);
  }

  _frames(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x9) {
        this.sock.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0])); // pong
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x8) {
        rec({ dir: "sys", kind: "ws-close", code: payload.length >= 2 ? payload.readUInt16BE(0) : null });
        this.sock.end();
        return;
      }
      if (opcode === 0x0) {
        this.frag = Buffer.concat([this.frag, payload]);
        if (fin) {
          const t = this.frag.toString("utf8");
          this.frag = Buffer.alloc(0);
          this.onText(t);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (!fin) {
          this.frag = payload;
          continue;
        }
        this.onText(payload.toString("utf8"));
      }
    }
  }

  send(text) {
    if (this.closed) throw new Error("socket 已关闭");
    this.sock.write(encodeTextFrame(text));
  }

  close() {
    try {
      this.sock.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      this.sock.end();
    } catch {}
  }
}

// ---------------- RACP 客户端 ----------------
const TERMINAL = /"(completed|failed|cancelled|canceled|interrupted|errored)"/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 6) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

class Racp {
  constructor(url, token) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.rpcErrors = [];
    this.ws = new WsClient({
      url,
      token,
      subprotocol: SUBPROTO,
      onText: (t) => this._onFrame(t),
      onClose: () => {
        for (const [, p] of this.pending) p.reject(new Error("HOST_DISCONNECTED"));
        this.pending.clear();
      },
    });
  }

  async open() {
    await this.ws.connect();
    rec({ dir: "sys", kind: "connected", url: URL_RAW, subprotocol: SUBPROTO || null });
  }

  _onFrame(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      rec({ dir: "in", kind: "non-json", raw: text.slice(0, 400) });
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        this.rpcErrors.push({ id: msg.id, error: msg.error });
        rec({ dir: "in", kind: "error", id: msg.id, error: msg.error });
        p.reject(Object.assign(new Error(`RACP error ${msg.error.code}: ${msg.error.message}`), { rpc: msg.error }));
      } else {
        rec({ dir: "in", kind: "result", id: msg.id, result: msg.result });
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.error) this.rpcErrors.push({ error: msg.error });
    this.events.push({ t: Date.now(), msg, raw: text });
    rec({ dir: "in", kind: "notification", msg });
  }

  call(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    rec({ dir: "out", kind: "request", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RACP 调用超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

// ---------------- 流程 ----------------
async function doPair() {
  const r = new Racp(URL_RAW, TOKEN);
  await r.open();
  try {
    const init = await r.call("connection/initialize", {
      clientInfo: { name: "pi-issue-bot-b0-spike", version: "0.0.0" },
      capabilities: {},
    });
    rec({ kind: "step", step: "initialize", ok: true, result: init });
  } catch (e) {
    rec({ kind: "step", step: "initialize", ok: false, message: String(e.message) });
    die("connection/initialize 失败：客户端信息字段可能不合 schema，请对照 racp.schema.json 改本脚本", e.rpc || e.message);
  }
  let paired;
  try {
    paired = await r.call("connection/pair", {});
  } catch (e) {
    die("connection/pair 失败（令牌可能已被消费，--pair 的令牌是一次性的）", e.rpc || e.message);
  }
  const raw = JSON.stringify(paired);
  const m = raw.match(/pdt1\.[A-Za-z0-9._-]+/);
  if (!m) die("配对结果里没找到 pdt1. 设备令牌：字段名与 schema 不符，把这段原文交给开发对着 fixture 改", paired);
  const out = arg("out");
  if (out) fs.writeFileSync(out, m[0] + "\n", { mode: 0o600 });
  rec({ kind: "step", step: "pair", ok: true, deviceTokenPrefix: m[0].slice(0, 12) });
  console.log(m[0]);
  r.close();
}

async function openSession(r, projectPath) {
  let projectId;
  try {
    const reg = await r.call("project/register", { path: projectPath });
    projectId = deepFind(reg, ["projectId", "id"]);
    rec({ kind: "step", step: "project/register", ok: true, projectId });
  } catch (e) {
    rec({ kind: "step", step: "project/register", ok: false, message: String(e.message) });
    throw e;
  }
  if (projectId === undefined) die("project/register 返回里找不到 projectId", projectId);
  const s = await r.call("session/create", { projectId, permissionMode: "ask", mode: "agent" });
  const sessionId = deepFind(s, ["sessionId", "id"]);
  if (!sessionId) die("session/create 返回里找不到 sessionId", s);
  rec({ kind: "step", step: "session/create", ok: true, sessionId });
  try {
    await r.call("events/subscribe", { sessionId, after: 0 });
  } catch (e) {
    rec({ kind: "step", step: "events/subscribe", ok: false, message: String(e.message) });
    die("events/subscribe 失败：没有事件流就没有「首事件时间戳」，B 的判定需要它", e.rpc || e.message);
  }
  return { sessionId };
}

function firstEventTs(r, sessionId, sinceTs, needle) {
  const hit = r.events.find((e) => e.t >= sinceTs && JSON.stringify(e.msg).includes(sessionId) && (!needle || e.raw.includes(needle)));
  return hit ? hit.t : null;
}

async function runTurn(r, sessionId, prompt, tag) {
  const tStart = Date.now();
  let turnId;
  try {
    const res = await r.call("turn/start", { sessionId, input: { messageId: `${tag}-${tStart}`, text: prompt } });
    turnId = deepFind(res, ["turnId", "id"]);
    rec({ kind: "step", step: "turn/start", ok: true, tag, sessionId, turnId });
  } catch (e) {
    rec({ kind: "step", step: "turn/start", ok: false, tag, sessionId, message: String(e.message), rpc: e.rpc });
    return { tag, sessionId, tStart, tEnd: Date.now(), status: "start-error", error: String(e.message) };
  }
  let status = "unknown";
  const deadline = tStart + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    try {
      const g = await r.call("turn/get", { turnId });
      const s = JSON.stringify(g);
      const m = s.match(TERMINAL);
      if (m) {
        status = m[1];
        break;
      }
    } catch (e) {
      rec({ kind: "poll-error", tag, message: String(e.message) });
    }
  }
  const tEnd = status === "unknown" ? null : Date.now();
  return {
    tag,
    sessionId,
    turnId,
    tStart,
    tFirstEvent: firstEventTs(r, sessionId, tStart, null),
    tFirstTool: firstEventTs(r, sessionId, tStart, "tool"),
    tEnd,
    status,
  };
}

function overlapPct(turns) {
  const spans = turns.filter((t) => t.tStart && t.tEnd).map((t) => [t.tStart, t.tEnd]);
  if (spans.length < 2) return null;
  const minStart = Math.min(...spans.map((s) => s[0]));
  const maxEnd = Math.max(...spans.map((s) => s[1]));
  const unionLen = maxEnd - minStart;
  if (unionLen <= 0) return 0;
  // 采样法：每 100ms 统计同时 running 的数量
  let samples = 0;
  let concurrent = 0;
  for (let t = minStart; t < maxEnd; t += 100) {
    samples++;
    const running = spans.filter(([a, b]) => t >= a && t < b).length;
    if (running >= 2) concurrent++;
  }
  return Math.round((concurrent / samples) * 100);
}

async function doRun(n) {
  const project = arg("project");
  const prompt = arg("prompt");
  if (!project || !prompt) die("需要 --project <dir> 与 --prompt <text>");
  const r = new Racp(URL_RAW, TOKEN);
  await r.open();
  const sessions = [];
  for (let i = 0; i < n; i++) sessions.push(await openSession(r, project));
  rec({ kind: "step", step: "sessions-ready", n, sessions: sessions.map((s) => s.sessionId) });

  const turns = await Promise.all(
    sessions.map((s, i) => runTurn(r, s.sessionId, prompt, `${LABEL}-s${i + 1}`)),
  );

  const lat = turns.map((t) => (t.tFirstEvent && t.tStart ? t.tFirstEvent - t.tStart : null)).filter((x) => x !== null).sort((a, b) => a - b);
  const summary = {
    label: LABEL,
    n,
    overlapsPct: overlapPct(turns),
    medianFirstEventMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    errors: r.rpcErrors.map((e) => `${e.error && e.error.code}:${e.error && e.error.message}`),
    turns: turns.map((t) => ({
      tag: t.tag,
      sessionId: t.sessionId,
      turnId: t.turnId,
      tStart: t.tStart,
      tFirstEventMs: t.tFirstEvent ? t.tFirstEvent - t.tStart : null,
      tFirstToolMs: t.tFirstTool ? t.tFirstTool - t.tStart : null,
      durationMs: t.tEnd ? t.tEnd - t.tStart : null,
      status: t.status,
      error: t.error || null,
    })),
  };
  rec({ kind: "summary", ...summary });
  console.log("SUMMARY_JSON " + JSON.stringify(summary));
  r.close();
  const bad = summary.turns.some((t) => t.status === "start-error" || t.status === "unknown");
  process.exit(bad ? 1 : 0);
}

// ---------------- main ----------------
if (!URL_RAW || !TOKEN) die("需要 --url 与 --token（--pair 阶段用 ppt1.…，之后用 pdt1.…）");
if (CMD === "pair") await doPair();
else if (CMD === "run") await doRun(1);
else if (CMD === "concurrent") await doRun(Number(arg("n", 4)));
else die("子命令必须是 pair | run | concurrent");
