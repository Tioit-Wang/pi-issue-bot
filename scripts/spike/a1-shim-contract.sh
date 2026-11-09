#!/bin/sh
# 运行环境：目标 Linux 主机；本开发机（Windows，无 docker）也可跑 —— 本脚本**不需要 docker**
#           （用 lib/stub-exec-proxy.mjs 顶替 bot 进程里的 exec 代理）。
# 依据：docs/tech-plan.md v1.1 §4.5（F1）—— 断言对象已从「docker exec 被调用」变成
#       「**exec 端点被调用 + 代理收到正确 argv/cwd**」。
# 目的：A 的 0 号前提自检：
#   C0/C0b/C0c  shim 形状：POSIX sh、可执行、**代码里不含 docker**（F1 的硬断言）
#   C1           端点发现 + 单帧协议（argv/cwd/clientPid/cmdId/workdir）
#   C2/C3        「上溯最多 4 层」的边界（第 4 层命中、第 5 层不命中）
#   C4           无端点 → NO_EXEC_ENDPOINT + 退出 2（不回落宿主执行）
#   C5/C5b       退出码透传（42；以及容器内 timeout 的特征码 137）
#   C6           stdout/stderr 分流正确
#   C7           容器名由代理查表（不再由路径 sha1 推导）
#   C8           cwd 不在映射内 → NO_JOB_MAPPING → 客户端退出 3
#   C9           socket 目录 0700 / socket 0600（仅 Linux）
#   C10          探针钩子字段（含 socket 路径）
#   C11          线上副本与仓库副本一致（可选，设 PI_BOT_SANDBOX_BASH）
# 写入：只在 $PI_BOT_SPIKE_TMP（默认 ${TMPDIR:-/tmp}/pi-bot-spike）/a1.XXXXXX 下；不写仓库。
# 幂等：可反复执行；每次运行重建端点并清理进程。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SPIKE_TMP=${PI_BOT_SPIKE_TMP:-${TMPDIR:-/tmp}/pi-bot-spike}
mkdir -p "$SPIKE_TMP"
WORK=$(mktemp -d "$SPIKE_TMP/a1.XXXXXX")
echo "临时目录：$WORK"

SHIM=$HERE/sandbox-bash.sh
CLIENT=$HERE/lib/exec-client.mjs
PROXY=$HERE/lib/stub-exec-proxy.mjs
FAILS=0
pass() { printf 'PASS %-4s %s\n' "$1" "$2"; }
fail() { printf 'FAIL %-4s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }
skip() { printf 'SKIP %-4s %s\n' "$1" "$2"; }

cleanup() {
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for f in "$SHIM" "$CLIENT" "$PROXY"; do [ -f "$f" ] || { echo "找不到 $f"; exit 1; }; done
command -v node >/dev/null 2>&1 || { echo "需要 node ≥18（exec-client 是 Node 写的，见 v1.1 §4.5）"; exit 1; }

# ---------- C0：shim 形状 ----------
if head -n 1 "$SHIM" | grep -qx '#!/bin/sh'; then pass C0 "shim shebang = /bin/sh"; else fail C0 "shim 首行不是 #!/bin/sh"; fi
if [ -x "$SHIM" ]; then pass C0b "shim 可执行（host-core 要求 executable file）"; else fail C0b "shim 不可执行：chmod +x"; fi
if grep -v '^[[:space:]]*#' "$SHIM" | grep -q 'docker'; then
  fail C0c "shim 的代码行里出现 docker —— v1.1 §4.5/F1 要求 shim 不接触 docker"
else
  pass C0c "shim 代码里没有 docker（只有注释声明不接触）"
fi

# ---------- 布局：一个共享端点 + 两个 job（用于验「容器名由代理查表」） ----------
POOL=$WORK/pool
J1=$POOL/job1
J2=$POOL/job2
mkdir -p "$J1" "$J2"
K1=pi-job-alpha
K2=pi-job-beta

OS=$(uname -s 2>/dev/null || echo unknown)
case "$OS" in
  Linux)
    LISTEN=$POOL/.pi-bot/exec.sock
    TRANSPORT=unix
    unset PI_BOT_EXEC_SOCK 2>/dev/null || true
    ;;
  *)
    PORT=$((20000 + ($$ % 20000)))
    LISTEN=tcp://127.0.0.1:$PORT
    TRANSPORT=tcp
    PI_BOT_EXEC_SOCK=$LISTEN
    export PI_BOT_EXEC_SOCK
    ;;
esac
PI_BOT_EXEC_CLIENT=$CLIENT
export PI_BOT_EXEC_CLIENT
echo "传输：$TRANSPORT  端点：$LISTEN"

proxy_start() { # $1=标签，其余参数原样拼给代理
  tag=$1
  shift
  PROXY_LOG=$WORK/proxy-$tag.jsonl
  PROXY_ERR=$WORK/proxy-$tag.err
  : > "$PROXY_LOG"
  node "$PROXY" --log "$PROXY_LOG" --listen "$LISTEN" --map "$J1=$K1" --map "$J2=$K2" "$@" \
    >"$WORK/proxy-$tag.out" 2>"$PROXY_ERR" &
  PROXY_PID=$!
  i=0
  while [ "$i" -lt 80 ]; do
    if grep -q 'PROXY_READY' "$WORK/proxy-$tag.out" 2>/dev/null; then return 0; fi
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then echo "代理启动失败（$tag）"; sed -n '1,20p' "$PROXY_ERR"; exit 1; fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "代理未就绪（$tag）"
  sed -n '1,20p' "$PROXY_ERR"
  exit 1
}

proxy_stop() {
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  PROXY_PID=
}

# ---------- C1：端点发现 + 单帧协议 ----------
proxy_start c1 --echo-argv
rc=0
out=$(cd "$J1" && "$SHIM" -lc 'echo hi' 2>"$WORK/c1.err") || rc=$?
if [ "$rc" -eq 0 ]; then pass C1a "命令经端点执行成功（exit 0）"; else fail C1a "命令失败 exit=$rc（$(cat "$WORK/c1.err")）"; fi
case "$out" in
  *STUB-EXEC*) pass C1b "代理把执行结果回传给 shim（stdout 有 STUB-EXEC）" ;;
  *) fail C1b "stdout 里没有代理回传内容：$out" ;;
esac
if grep -q '"kind":"request"' "$PROXY_LOG"; then pass C1c "代理收到请求（单帧）"; else fail C1c "代理没收到请求"; fi
if grep -q '"argv":\["bash","-lc","echo hi"\]' "$PROXY_LOG"; then
  pass C1d 'argv = ["bash","-lc","echo hi"]（与 v1.1 §4.5 的帧格式一致）'
else
  fail C1d "argv 不符：$(grep '"kind":"request"' "$PROXY_LOG" | head -n 1)"
fi
if grep -q '"argv0":"bash"' "$PROXY_LOG"; then pass C1e "argv[0] = bash"; else fail C1e "argv[0] 不是 bash"; fi
if grep -q '"clientPid":[1-9]' "$PROXY_LOG"; then pass C1f "带上客户端 pid"; else fail C1f "没有 clientPid"; fi
if grep -q '"cmdId":"PI_CMD_ID=' "$PROXY_LOG"; then pass C1g "代理为该命令生成 PI_CMD_ID（F3 兜底的前提）"; else fail C1g "没有 cmdId"; fi
if grep -q '"cwd":"[^"]*job1"' "$PROXY_LOG"; then pass C1h "cwd 传对了（job1）"; else fail C1h "cwd 不对"; fi
if grep -q '"workdir":"[^"]*job1"' "$PROXY_LOG"; then pass C1i "workdir = cwd（落在 job 内，无需回退）"; else fail C1i "workdir 不对"; fi
proxy_stop

# ---------- C2：第 4 层仍命中 ----------
if [ "$TRANSPORT" = "unix" ]; then
  proxy_start c2 --echo-argv
  DEEP=$J1/a/b/c
  mkdir -p "$DEEP"
  rc=0
  out=$(cd "$DEEP" && "$SHIM" -lc 'echo deep' 2>"$WORK/c2.err") || rc=$?
  if [ "$rc" -eq 0 ]; then pass C2 "第 4 层子目录仍命中端点（exit 0）"; else fail C2 "第 4 层没命中：exit=$rc（$(cat "$WORK/c2.err")）"; fi
  if grep -q '"cwd":"[^"]*job1/a/b/c"' "$PROXY_LOG"; then pass C2b "代理收到的 cwd 是深层子目录（不是 job 根）"; else fail C2b "cwd 不是深层子目录"; fi
  proxy_stop
else
  skip C2 "非 Linux（$OS）没有 unix socket 语义，发现逻辑留给目标主机"
fi

# ---------- C3：第 5 层不命中 ----------
if [ "$TRANSPORT" = "unix" ]; then
  IDEEP=$J1/a/b/c/d
  mkdir -p "$IDEEP"
  rc=0
  err=$(cd "$IDEEP" && "$SHIM" -lc 'echo too-deep' 2>&1 >/dev/null) || rc=$?
  if [ "$rc" -eq 2 ]; then
    case "$err" in
      *NO_EXEC_ENDPOINT*) pass C3 "第 5 层不命中：退 2 + NO_EXEC_ENDPOINT" ;;
      *) fail C3 "退 2 但文案不对：$err" ;;
    esac
  else
    fail C3 "第 5 层应退 2，实得 $rc（$err）"
  fi
else
  skip C3 "非 Linux（$OS）"
fi

# ---------- C4：完全无端点 ----------
unset PI_BOT_EXEC_SOCK 2>/dev/null || true
mkdir -p "$WORK/lonely"
rc=0
err=$(cd "$WORK/lonely" && "$SHIM" -lc 'echo nowhere' 2>&1 >/dev/null) || rc=$?
if [ "$rc" -eq 2 ]; then
  case "$err" in
    *NO_EXEC_ENDPOINT*) pass C4 "无端点 → NO_EXEC_ENDPOINT + 退出 2（不回落宿主执行）" ;;
    *) fail C4 "退出码对但文案不对：$err" ;;
  esac
else
  fail C4 "无端点时应退 2，实得 $rc（$err）"
fi
if [ "$TRANSPORT" = "tcp" ]; then PI_BOT_EXEC_SOCK=$LISTEN; export PI_BOT_EXEC_SOCK; fi

# ---------- C5：退出码透传 ----------
proxy_start c5 --exit 42
rc=0
(cd "$J1" && "$SHIM" -lc 'exit 42') || rc=$?
if [ "$rc" -eq 42 ]; then pass C5 "退出码透传（42）"; else fail C5 "退出码未透传，期望 42 实得 $rc"; fi
proxy_stop

proxy_start c5b --exit 137
rc=0
(cd "$J1" && "$SHIM" -lc 'sleep 999') || rc=$?
if [ "$rc" -eq 137 ]; then pass C5b "容器内 timeout 的特征码 137 透传"; else fail C5b "137 未透传，实得 $rc"; fi
proxy_stop

# ---------- C6：stdout/stderr 分流 ----------
proxy_start c6 --echo-argv --stderr 'PI:STDERR-MARKER'
rc=0
o=$(cd "$J1" && "$SHIM" -lc 'echo hi' 2>"$WORK/c6.err") || rc=$?
if grep -q 'PI:STDERR-MARKER' "$WORK/c6.err"; then pass C6a "stderr 走 stderr 通道"; else fail C6a "stderr 内容丢失（$(cat "$WORK/c6.err")）"; fi
case "$o" in
  *STDERR-MARKER*) fail C6b "stderr 内容混进了 stdout（分流坏了）" ;;
  *) pass C6b "stdout 里没有 stderr 内容（分流正确）" ;;
esac
proxy_stop

# ---------- C7：容器名由代理查表 ----------
proxy_start c7 --echo-argv
rc=0
o1=$(cd "$J1" && "$SHIM" -lc 'echo one' 2>/dev/null) || rc=$?
o2=$(cd "$J2" && "$SHIM" -lc 'echo two' 2>/dev/null) || rc=$?
case "$o1" in *"$K1"*) pass C7a "job1 → $K1" ;; *) fail C7a "job1 映射不对：$o1" ;; esac
case "$o2" in *"$K2"*) pass C7b "job2 → $K2（同一端点、不同 job 拿到不同容器）" ;; *) fail C7b "job2 映射不对：$o2" ;; esac
if grep -q 'sha1\|sha256' "$PROXY_LOG"; then fail C7c "日志里出现哈希推导痕迹"; else pass C7c "没有路径哈希推导（映射只来自代理的表）"; fi
proxy_stop

# ---------- C8：cwd 不在映射内 ----------
proxy_start c8
rc=0
err=$(cd "$POOL" && "$SHIM" -lc 'echo orphan' 2>&1 >/dev/null) || rc=$?
if [ "$rc" -eq 3 ]; then
  case "$err" in
    *NO_JOB_MAPPING*) pass C8 "cwd 不在映射内 → NO_JOB_MAPPING → 客户端退 3" ;;
    *) fail C8 "退 3 但文案不对：$err" ;;
  esac
else
  fail C8 "应退 3（代理错误帧），实得 $rc（$err）"
fi
proxy_stop

# ---------- C9：socket 权限（仅 Linux） ----------
if [ "$TRANSPORT" = "unix" ]; then
  proxy_start c9
  dmode=$(stat -c '%a' "$POOL/.pi-bot" 2>/dev/null || echo '?')
  smode=$(stat -c '%a' "$POOL/.pi-bot/exec.sock" 2>/dev/null || echo '?')
  if [ "$dmode" = "700" ]; then pass C9a "socket 目录 0700"; else fail C9a "socket 目录权限是 $dmode（应 700）"; fi
  if [ "$smode" = "600" ]; then pass C9b "socket 0600"; else fail C9b "socket 权限是 $smode（应 600）"; fi
  proxy_stop
else
  skip C9 "非 Linux（$OS）：socket 权限无法在此校验"
fi

# ---------- C10：探针钩子 ----------
PROBE_LOG=$WORK/probe.jsonl
: > "$PROBE_LOG"
proxy_start c10
(cd "$J1" && PI_BOT_PROBE_LOG=$PROBE_LOG "$SHIM" -lc 'echo probe' >/dev/null 2>&1) || true
n=$(wc -l < "$PROBE_LOG" | tr -d ' ')
rec=$(cat "$PROBE_LOG")
ok_sock=no
case "$rec" in *'"socket":"'*'exec.sock"'*) ok_sock=yes ;; *'"socket":"tcp://'*) ok_sock=yes ;; esac
case "$rec" in
  *'echo probe'*)
    if [ "$n" = "1" ] && [ "$ok_sock" = "yes" ]; then pass C10 "探针 JSONL：ts/pid/cwd/socket/argv 齐全"
    else fail C10 "探针记录不符（n=$n，socket=$ok_sock）：$rec"; fi
    ;;
  *) fail C10 "探针没记录本次调用（n=$n）：$rec" ;;
esac
proxy_stop

# ---------- C11：仓库副本 vs 线上副本 ----------
if [ -n "${PI_BOT_SANDBOX_BASH:-}" ]; then
  if [ -f "$PI_BOT_SANDBOX_BASH" ] && cmp -s "$SHIM" "$PI_BOT_SANDBOX_BASH"; then
    pass C11 "线上副本与仓库副本逐字节一致"
  else
    fail C11 "线上副本与仓库副本不一致：$PI_BOT_SANDBOX_BASH"
  fi
else
  skip C11 "未设置 PI_BOT_SANDBOX_BASH"
fi

echo "----"
echo "证据：代理日志 $WORK/proxy-*.jsonl ，探针 $PROBE_LOG"
if [ "$FAILS" -eq 0 ]; then
  echo "A0 前提（shim → exec 端点 → 代理 的链路契约）全部通过。下一步：00-preflight.sh → a2-bash-path-probe.sh"
  exit 0
fi
echo "A0 前提有 $FAILS 项失败：先修 shim/客户端/协议，再去跑 a2（否则 A1/A2/A3 的结论无效）"
exit 1
