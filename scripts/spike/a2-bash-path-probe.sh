#!/bin/sh
# 运行环境：目标 Linux 主机（需要 docker daemon、node ≥18、pi-host bundle、worker 镜像、模型凭据）；本开发机无 docker 无法执行。
# 依据：docs/tech-plan.md v1.1 §4.5（F1）+ §4.7（F3）。断言对象是：
#   ① shim 只连 exec 端点（不碰 docker）；② 代理收到正确 argv/cwd 并查表得到容器；③ 命令确实跑在容器里；
#   ④ 单命令超时由**容器内** timeout 生效，宿主侧只留 cmdId 兜底。
# 目的：验证 A —— 前台命令 / 后台任务 / 超时 kill 三条路径都经过覆盖点，且都在容器内执行。
# 写入：只在 $PI_BOT_SPIKE_TMP（默认 ${TMPDIR:-/tmp}/pi-bot-spike）/a2.XXXXXX 下；不写仓库、不碰用户数据目录。
# 幂等：可反复执行；退出时 docker rm -f 自己的容器、kill 自己的 pi-host 与代理。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SPIKE_TMP=${PI_BOT_SPIKE_TMP:-${TMPDIR:-/tmp}/pi-bot-spike}
mkdir -p "$SPIKE_TMP"
WORK=$(mktemp -d "$SPIKE_TMP/a2.XXXXXX")
echo "临时目录：$WORK"

: "${PI_HOST_BIN:?需要 PI_HOST_BIN=<pi-host bundle 入口>}"
: "${PI_WORKER_IMAGE:?需要 PI_WORKER_IMAGE=<worker 镜像，例 pi-worker:pnpm-node22>}"
DRIVE=$HERE/lib/racp-drive.mjs
SHIM=$HERE/sandbox-bash.sh
CLIENT=$HERE/lib/exec-client.mjs
PROXY=$HERE/lib/stub-exec-proxy.mjs
PROBE_LOG=$WORK/probe.jsonl
PROXY_LOG=$WORK/proxy.jsonl
SPIKE_UID=${SPIKE_UID:-1001:1001}
CMD_TIMEOUT=${PI_BOT_CMD_TIMEOUT_S:-10}   # 命令级上限；spike 压到 10s，生产默认 120/300（tech-plan §4.7）
FAILS=0
pass() { printf 'PASS %-4s %s\n' "$1" "$2"; }
fail() { printf 'FAIL %-4s %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

cleanup() {
  if [ -n "${HOST_PID:-}" ]; then kill "$HOST_PID" 2>/dev/null || true; wait "$HOST_PID" 2>/dev/null || true; fi
  if [ -n "${PROXY_PID:-}" ]; then kill "$PROXY_PID" 2>/dev/null || true; wait "$PROXY_PID" 2>/dev/null || true; fi
  if [ -n "${CONTAINER:-}" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

# ---------------- 准备：worktree + 容器（身份挂载）+ 真代理 ----------------
JOB=$WORK/job
mkdir -p "$JOB"
git -C "$JOB" init -q
printf 'spike fixture\n' > "$JOB/README.md"
git -C "$JOB" add -A
git -C "$JOB" -c user.email=spike@local -c user.name=spike commit -qm 'spike fixture'
JOB=$(cd "$JOB" && pwd -P)
CONTAINER=pi-job-spike-$$        # spike 里由脚本自己指定；生产由 bot 在建容器时写入内存映射
echo "worktree=$JOB  container=$CONTAINER"

docker run -d --init --rm \
  --name "$CONTAINER" \
  --user "$SPIKE_UID" \
  --read-only --tmpfs /tmp:rw,size=512m,noexec,nosuid \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory 2g --memory-swap 2g --cpus 2 \
  -v "$JOB:$JOB:rw" -w "$JOB" \
  "$PI_WORKER_IMAGE" sleep infinity >/dev/null
echo "容器已起（身份挂载 $JOB:$JOB；plan §8.1 的 /work 映射作废，见 tech-plan §4.5 勘误）"

start_proxy() { # $1=额外参数（可空）
  : > "$PROXY_LOG"
  node "$PROXY" --mode docker --listen "$JOB/.pi-bot/exec.sock" --map "$JOB=$CONTAINER" \
    --cmd-timeout-s "$CMD_TIMEOUT" --pkill-fallback --log "$PROXY_LOG" "$@" \
    >"$WORK/proxy.out" 2>"$WORK/proxy.err" &
  PROXY_PID=$!
  i=0
  while [ "$i" -lt 80 ]; do
    if grep -q 'PROXY_READY' "$WORK/proxy.out" 2>/dev/null; then echo "exec 代理就绪：$JOB/.pi-bot/exec.sock（mode=docker, cmd-timeout=${CMD_TIMEOUT}s）"; return 0; fi
    if ! kill -0 "$PROXY_PID" 2>/dev/null; then echo "代理启动失败"; sed -n '1,20p' "$WORK/proxy.err"; exit 1; fi
    sleep 0.25
    i=$((i + 1))
  done
  echo "代理未就绪"; sed -n '1,20p' "$WORK/proxy.err"; exit 1
}

# pi-host 启停：环境里只放 shim 与端点客户端，**不放 docker 相关任何东西**
export PI_DESKTOP_BASH=$SHIM
export PI_BOT_EXEC_CLIENT=$CLIENT
export PI_BOT_PROBE_LOG=$PROBE_LOG
start_host() { # $1=data-dir $2=logfile
  : > "$2"
  "$PI_HOST_BIN" --data-dir "$1" --port 0 --pair >>"$2" 2>&1 &
  HOST_PID=$!
  i=0
  while [ "$i" -lt 120 ]; do
    if grep -q 'PI_HOST_READY' "$2" && grep -q 'PI_HOST_PAIRING_TOKEN' "$2"; then break; fi
    if ! kill -0 "$HOST_PID" 2>/dev/null; then echo "pi-host 启动即退出（见 $2）"; sed -n '1,40p' "$2"; exit 1; fi
    sleep 0.5
    i=$((i + 1))
  done
  if [ "$i" -ge 120 ]; then echo "等 PI_HOST_READY/PAIRING_TOKEN 超时（60s），见 $2"; sed -n '1,40p' "$2"; exit 1; fi
  PORT=$(sed -n 's/.*"port":[ ]*\([0-9][0-9]*\).*/\1/p' "$2" | head -n 1)
  PPT=$(sed -n 's/.*"token":[ ]*"\([^"]*\)".*/\1/p' "$2" | head -n 1)
  HOST_VERSION=$(sed -n 's/.*"version":[ ]*"\([^"]*\)".*/\1/p' "$2" | head -n 1)
  if [ -z "$PORT" ] || [ -z "$PPT" ]; then echo "解析 PI_HOST_READY/PAIRING_TOKEN 失败，见 $2"; sed -n '1,10p' "$2"; exit 1; fi
  URL="ws://127.0.0.1:$PORT/racp"
  echo "pi-host v$HOST_VERSION pid=$HOST_PID port=$PORT"
}

stop_host() { kill "$HOST_PID" 2>/dev/null || true; wait "$HOST_PID" 2>/dev/null || true; HOST_PID=; }

pair_host() { # $1=标签
  node "$DRIVE" pair --url "$URL" --token "$PPT" --out "$WORK/pdt.txt" --log "$WORK/racp-pair-$1.jsonl" \
    >"$WORK/pair-$1.out" 2>"$WORK/pair-$1.err" || {
    echo "connection/pair 失败，见 $WORK/racp-pair-$1.jsonl 与 $WORK/pair-$1.err"; exit 1; }
  PDT=$(cat "$WORK/pdt.txt")
}

drive() { # $1=label $2=prompt
  rc=0
  node "$DRIVE" run --url "$URL" --token "$PDT" --project "$JOB" --prompt "$2" --label "$1" \
    --log "$WORK/racp-$1.jsonl" >"$WORK/$1.out" 2>"$WORK/$1.err" || rc=$?
  echo "  turn[$1] driver rc=$rc"
  return 0
}

cmd_id_of() { # $1=标记（命令里出现的字样）→ 从代理日志取该命令的 cmdId
  grep "\"kind\":\"request\"" "$PROXY_LOG" | grep "$1" | head -n 1 | sed -n 's/.*"cmdId":"\(PI_CMD_ID=[^"]*\)".*/\1/p'
}

# ---------------- 阶段 1：负向探针（覆盖点是否说了算） ----------------
echo
echo "=== 阶段 1：负向探针 —— PI_DESKTOP_BASH 指向不存在的可执行文件 ==="
start_proxy
PI_DESKTOP_BASH=$WORK/pi-bot-probe-does-not-exist
export PI_DESKTOP_BASH
start_host "$WORK/host-neg" "$WORK/host-neg.log"
pair_host neg
P_NEG=$(cat <<'EOF'
只做一件事：用 Bash 工具执行 `printf 'MARKER-A1NEG %s\n' "$PWD"`，然后把原始输出原样贴出来。不要做别的事，不要改文件。
EOF
)
drive A1NEG "$P_NEG"
if grep -q 'MARKER-A1NEG' "$WORK/racp-A1NEG.jsonl" 2>/dev/null; then
  fail A0 "负向探针下命令仍然执行成功 —— PI_DESKTOP_BASH 覆盖没生效，A 全部作废"
else
  pass A0 "覆盖点生效：坏路径下命令未执行（错误见 $WORK/racp-A1NEG.jsonl）"
  grep -o 'PI_DESKTOP_BASH[^"\\]*' "$WORK/racp-A1NEG.jsonl" | head -n 2 || true
fi
stop_host

# ---------------- 阶段 2：正向探针（三条路径） ----------------
echo
echo "=== 阶段 2：正向探针 —— shim 只连端点，代理负责进容器 ==="
: > "$PROBE_LOG"
PI_DESKTOP_BASH=$SHIM
export PI_DESKTOP_BASH
start_host "$WORK/host-pos" "$WORK/host-pos.log"
pair_host pos

echo "-- A1 前台命令 --"
P_A1=$(cat <<'EOF'
只做一件事：用 Bash 工具执行下面这行命令，然后把它的原始输出原样贴出来（用 ``` 包住）。不要做别的事，不要修改任何文件：
printf 'MARKER-A1 '; printf '%s\n' "$PWD"; ls -l /.dockerenv 2>&1; hostname; head -n 3 /proc/self/cgroup 2>/dev/null
EOF
)
drive A1 "$P_A1"
if grep -q 'MARKER-A1' "$WORK/racp-A1.jsonl"; then pass A1 "工具输出里有 MARKER-A1"; else fail A1 "工具输出里没有 MARKER-A1"; fi
if grep -q '/.dockerenv' "$WORK/racp-A1.jsonl"; then
  pass A1c "输出里有 /.dockerenv（容器内特征；宿主没有这个文件）"
else
  fail A1c "输出里没有 /.dockerenv —— 命令很可能在宿主执行"
fi
if grep -q 'MARKER-A1' "$PROBE_LOG"; then pass A1s "探针日志有 A1 记录（经过 shim）"; else fail A1s "探针日志没有 A1 记录"; fi
if grep -q '"kind":"docker-exec"' "$PROXY_LOG"; then pass A1p "代理确实发出了 docker exec"; else fail A1p "代理没有执行 docker exec"; fi
if grep -q '"container":"'"$CONTAINER"'"' "$PROXY_LOG"; then
  pass A1m "容器名来自代理的映射表（不是路径 sha1）"
else
  fail A1m "代理日志里没有该容器名"
fi

echo "-- A2 后台任务 --"
P_A2=$(cat <<'EOF'
只做一件事：用 Bash 工具**在后台**启动下面这条命令（用工具的后台/background 参数，不要用 `&` 自己 fork），
启动后立刻结束本轮，不要等它跑完，也不要再调用任何工具：
sh -c 'echo MARKER-A2 > /tmp/pi-bot-spike-A2; sleep 60'
EOF
)
drive A2 "$P_A2"
if grep -q 'MARKER-A2' "$PROBE_LOG"; then
  pass A2s "探针日志有 A2 记录（后台任务也经过 shim）"
  if docker exec "$CONTAINER" sh -c 'test -f /tmp/pi-bot-spike-A2' 2>/dev/null; then
    pass A2c "容器内 /tmp 有标记文件（宿主 /tmp 里没有）"
  else
    fail A2c "容器内 /tmp 没有标记文件 —— 后台任务没在容器里跑"
  fi
else
  fail A2s "探针日志没有 A2 记录 —— 后台任务路径绕过覆盖点（D5 破口）"
fi

echo "-- A3 超时 kill（F3：超时下沉进容器） --"
P_A3=$(cat <<'EOF'
只做一件事：用 Bash 工具执行 `sleep 400; echo MARKER-A3-DONE`，不要做别的。它会在 10 秒左右被杀掉，这是预期的。
EOF
)
drive A3 "$P_A3"
A3CMD=$(cmd_id_of 'sleep 400')
if grep -q 'sleep 400' "$PROBE_LOG"; then pass A3s "探针日志有 A3 记录（超时路径也经过 shim）"; else fail A3s "探针日志没有 A3 记录"; fi
if grep -q 'MARKER-A3-DONE' "$WORK/racp-A3.jsonl"; then
  fail A3c "超时没生效：命令跑完了（检查代理的 --cmd-timeout-s=$CMD_TIMEOUT）"
else
  pass A3c "命令被中断（没有完成标记）"
fi
# A3t：代理拼出的 exec 命令行必须把 timeout 放进容器内，并注入 cmdId
if grep '"kind":"docker-exec"' "$PROXY_LOG" | grep -q '"timeout","-s","KILL","'"$CMD_TIMEOUT"'","bash","-lc"'; then
  pass A3t "超时下沉进容器：docker exec … timeout -s KILL $CMD_TIMEOUT bash -lc <cmd>"
else
  fail A3t "代理的 exec 命令行里没有容器内 timeout，或超时值不是 $CMD_TIMEOUT：$(grep '"kind":"docker-exec"' "$PROXY_LOG" | tail -n 1)"
fi
if [ -n "$A3CMD" ]; then
  pass A3i "代理为该命令生成了 $A3CMD（宿主侧兜底的匹配键）"
  if grep '"kind":"docker-exec"' "$PROXY_LOG" | grep -q '"-e","'"$A3CMD"'"'; then
    pass A3e "cmdId 经 -e 注入容器（env 可见）"
  else
    fail A3e "docker exec 命令行里没有 -e $A3CMD"
  fi
else
  fail A3i "代理日志里找不到该命令的 cmdId"
fi
sleep 2
resid=$(docker exec "$CONTAINER" sh -c \
  'for p in /proc/[0-9]*; do c=$(tr "\000" " " < "$p/cmdline" 2>/dev/null); case "$c" in *"sleep 400"*) echo "残留: $p $c";; esac; done' 2>/dev/null || true)
if [ -z "$resid" ]; then pass A3k "超时后容器内无残留进程（容器内 timeout 生效）"; else fail A3k "仍有残留进程：$resid"; fi

# A3f：兜底策略有效性 —— v1.1 §4.7 字面写 `pkill -KILL -f "PI_CMD_ID=<uuid>"`，
#      但 cmdId 是经 -e 注入 env 的，pkill -f 只匹配 cmdline。这里用一个受控进程把两种做法都测一遍。
MARK=PI_CMD_ID=spike-probe-$$
docker exec -d "$CONTAINER" sh -c "$MARK sleep 30" >/dev/null 2>&1 || true
sleep 1
hit_env=$(docker exec "$CONTAINER" sh -c 'for p in /proc/[0-9]*; do grep -qa "$1" "$p/environ" 2>/dev/null && echo hit; done' sh "$MARK" 2>/dev/null | head -n 1)
pkill_rc=0
docker exec "$CONTAINER" pkill -0 -f "$MARK" >/dev/null 2>&1 || pkill_rc=$?
docker exec "$CONTAINER" pkill -KILL -f "$MARK" >/dev/null 2>&1 || true
if [ "$hit_env" = "hit" ]; then
  pass A3f "env 扫 /proc/*/environ 能命中 $MARK（兜底可改成这个策略）"
else
  fail A3f "env 扫也命中不到 $MARK —— cmdId 兜底彻底失效"
fi
if [ "$pkill_rc" -ne 0 ]; then
  pass A3f2 "pkill -f \"PI_CMD_ID=…\" 命中不到（复现了 v1.1 §4.7 的字面缺陷：-f 不看 env）"
else
  fail A3f2 "pkill -f 竟然命中了 —— 说明 cmdId 也出现在 cmdline 里，请确认实现细节后更新本节判定"
fi
docker exec "$CONTAINER" sh -c 'pkill -KILL -f "PI_CMD_ID=spike-probe" 2>/dev/null; true' >/dev/null 2>&1 || true

stop_host

# ---------------- 汇总 ----------------
echo
echo "=== A 的证据位置（可直接贴进 docs/spec/b0-spike.md 的结论表）==="
echo "  探针日志（shim 侧）: $PROBE_LOG"
echo "  代理日志（端点侧）: $PROXY_LOG"
echo "  各 turn 帧日志: $WORK/racp-A*.jsonl"
echo "  pi-host 日志: $WORK/host-pos.log / $WORK/host-neg.log"
echo "  host 侧对照: hostname=$(hostname)  /.dockerenv=$([ -e /.dockerenv ] && echo 存在 || echo 不存在)"
echo
if [ "$FAILS" -eq 0 ]; then
  echo "A 全部通过。注意：结论只对本机 pi-host v${HOST_VERSION:-?} 与本次代理实现成立。"
  exit 0
fi
echo "A 有 $FAILS 项失败：按 docs/spec/b0-spike.md §3 的「失败意味着什么 / 退路」逐条处理。"
exit 1
