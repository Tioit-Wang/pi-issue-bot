#!/bin/sh
# 运行环境：目标 Linux 主机；本开发机无 docker 无法执行。
# 目的：把 a2 / b 需要的环境一次性点清，缺什么就明确说缺什么（对应 docs/spec/b0-spike.md §1 前置准备）。
# 写入：只读为主；不建目录、不落文件（除 docker 查询本身）。
# 幂等：可反复执行；有 FAIL 即非零退出。
set -u

FAILS=0
WARNS=0
ok()   { printf 'ok    %-22s %s\n' "$1" "$2"; }
warn() { printf 'warn  %-22s %s\n' "$1" "$2"; WARNS=$((WARNS + 1)); }
bad()  { printf 'FAIL  %-22s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

echo "== 1. 必需环境变量 =="
[ -n "${PI_HOST_BIN:-}" ]     && ok PI_HOST_BIN "$PI_HOST_BIN"     || bad PI_HOST_BIN "未设置（pi-host bundle 入口，例：/opt/pi-host/bin/pi-host）"
[ -n "${PI_WORKER_IMAGE:-}" ] && ok PI_WORKER_IMAGE "$PI_WORKER_IMAGE" || bad PI_WORKER_IMAGE "未设置（例：pi-worker:pnpm-node22）"
[ -n "${RACP_SUBPROTOCOL:-}" ] && ok RACP_SUBPROTOCOL "$RACP_SUBPROTOCOL" || warn RACP_SUBPROTOCOL "未设置：RACP 子协议名待补（tech-plan §4.2 引用了一个不存在的 §14a）"
[ -n "${PI_BOT_SANDBOX_BASH:-}" ] && ok PI_BOT_SANDBOX_BASH "$PI_BOT_SANDBOX_BASH" || warn PI_BOT_SANDBOX_BASH "未设置：跳过线上副本一致性校验"

echo "== 2. 工具链 =="
command -v docker >/dev/null 2>&1 && ok docker "$(command -v docker)" || bad docker "docker CLI 缺失"
if docker info >/dev/null 2>&1; then ok docker-daemon "可达"; else bad docker-daemon "daemon 不可达（a2 的容器证据无法采集）"; fi
if command -v node >/dev/null 2>&1; then
  ok node "$(node -v)"
  node -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' 2>/dev/null \
    && ok node-version "≥18（驱动自带 WS 帧层，不依赖全局 WebSocket）" \
    || bad node-version "node 版本 <18（驱动需要 ≥18）"
else
  bad node "node 缺失（驱动需要 node ≥18）"
fi
command -v sha1sum >/dev/null 2>&1 && ok sha1sum "可用（容器名推导）" || bad sha1sum "coreutils 缺失"
command -v timeout >/dev/null 2>&1 && ok timeout "可用（shim 兜底）" || bad timeout "coreutils 缺失"
command -v git >/dev/null 2>&1 && ok git "$(git --version)" || bad git "缺失（造 worktree 用）"
command -v sqlite3 >/dev/null 2>&1 && ok sqlite3 "$(sqlite3 --version | cut -d' ' -f1)" || warn sqlite3 "缺失：跳过 B 的 turns/turn_queue 直查证据"

echo "== 3. pi-host bundle =="
if [ -n "${PI_HOST_BIN:-}" ]; then
  [ -f "$PI_HOST_BIN" ] && ok pi-host-file "$PI_HOST_BIN" || bad pi-host-file "不是普通文件"
  [ -x "$PI_HOST_BIN" ] && ok pi-host-exec "可执行" || bad pi-host-exec "不可执行（chmod +x）"
  if timeout 20 "$PI_HOST_BIN" --help >/dev/null 2>&1; then
    ok pi-host-help "响应 --help"
  else
    warn pi-host-help "响应 --help 非零或超时（不致命，但说明 bundle 可能不完整）"
  fi
  case "$PI_HOST_BIN" in
    *pi-host*) ok pi-host-name "路径含 pi-host" ;;
    *) warn pi-host-name "路径不含 pi-host，确认这是 bundle 入口而不是别的可执行文件" ;;
  esac
fi

echo "== 4. worker 镜像 =="
if [ -n "${PI_WORKER_IMAGE:-}" ] && docker info >/dev/null 2>&1; then
  if docker image inspect "$PI_WORKER_IMAGE" >/dev/null 2>&1; then
    ok worker-image "$PI_WORKER_IMAGE 存在"
    if docker run --rm --network none "$PI_WORKER_IMAGE" sh -c 'command -v bash && command -v git' >/dev/null 2>&1; then
      ok worker-toolchain "镜像内有 bash 与 git"
    else
      bad worker-toolchain "镜像内缺 bash 或 git（shim 转发的是 bash）"
    fi
  else
    bad worker-image "$PI_WORKER_IMAGE 不存在（a2 会 docker run 失败）"
  fi
fi

echo "== 5. PI_DESKTOP_BASH 落位 =="
DEPLOYED=${PI_BOT_SANDBOX_BASH:-/usr/local/lib/pi-bot/sandbox-bash}
if [ -f "$DEPLOYED" ]; then
  ok shim-file "$DEPLOYED"
  [ -x "$DEPLOYED" ] && ok shim-exec "可执行" || bad shim-exec "不可执行：host-core 会直接报 \"PI_DESKTOP_BASH points to '...', which is not an executable file.\""
  grep -q 'exec.sock' "$DEPLOYED" && ok shim-content "内容像 exec 端点客户端（v1.1 §4.5）" || warn shim-content "内容里没有 exec.sock 字样，确认没放错文件"
  if grep -v '^[[:space:]]*#' "$DEPLOYED" | grep -q 'docker'; then
    bad shim-docker "shim 代码里出现 docker —— v1.1 §4.5/F1 要求 shim 不接触 docker"
  else
    ok shim-docker "shim 代码里没有 docker（F1）"
  fi
else
  warn shim-file "$DEPLOYED 不存在（a2 会用仓库副本 scripts/spike/sandbox-bash.sh）"
fi

echo "== 6. 模型凭据（pi-host 跑 turn 的前提）=="
if [ -n "${PI_MODEL_KEY_PRESENT:-}" ]; then
  ok model-cred "调用方已确认凭据存在（本脚本不复述 key）"
else
  warn model-cred "未通过 PI_MODEL_KEY_PRESENT=1 自报：pi-host 没有模型凭据时 turn/start 会失败，A/B 都得不出结论"
fi

echo "----"
echo "FAIL=$FAILS WARN=$WARNS"
[ "$FAILS" -eq 0 ] || { echo "前置准备未满足：修掉上面的 FAIL 再来。"; exit 1; }
echo "前置准备通过。建议顺序：./a1-shim-contract.sh → ./a2-bash-path-probe.sh → ./b-concurrency-matrix.sh"
