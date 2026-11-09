#!/bin/sh
# 运行环境：目标 Linux 主机（需要 docker daemon、node ≥22、pi-host bundle、worker 镜像、模型凭据）；本开发机无 docker 无法执行。
# 目的：验证 B —— 单个 pi-host 下多 session 并发是否互相排队（1/2/3/4 并发矩阵）。
# 说明：B 只测「轮次调度」，所以 4 个 session 共用一个 project 目录与一个容器；
#       容器数不影响 turn 队列语义，这样每轮耗时最短（真并发时容器按任务另建，见 tech-plan §6）。
# 写入：只在 $PI_BOT_SPIKE_TMP（默认 ${TMPDIR:-/tmp}/pi-bot-spike）/b.XXXXXX 下建目录；不写仓库。
# 幂等：可反复执行；退出时 docker rm -f 自己的容器、kill 自己的 pi-host。
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SPIKE_TMP=${PI_BOT_SPIKE_TMP:-${TMPDIR:-/tmp}/pi-bot-spike}
mkdir -p "$SPIKE_TMP"
WORK=$(mktemp -d "$SPIKE_TMP/b.XXXXXX")
echo "临时目录：$WORK"

: "${PI_HOST_BIN:?需要 PI_HOST_BIN=<pi-host bundle 入口>}"
: "${PI_WORKER_IMAGE:?需要 PI_WORKER_IMAGE=<worker 镜像>}"
DRIVE=$HERE/lib/racp-drive.mjs
SPIKE_UID=${SPIKE_UID:-1001:1001}
MAXN=${MAXN:-4}
CSV=$WORK/matrix.csv
echo "n,overlaps_pct,median_first_event_ms,start_errors,all_durations_ms" > "$CSV"
FAILS=0

cleanup() {
  [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null || true
  [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null || true
  [ -n "${CONTAINER:-}" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# ---------------- 准备 ----------------
JOB=$WORK/job
mkdir -p "$JOB"
git -C "$JOB" init -q
printf 'spike concurrency fixture\n' > "$JOB/README.md"
git -C "$JOB" add -A
git -C "$JOB" -c user.email=spike@local -c user.name=spike commit -qm 'spike fixture'
JOB=$(cd "$JOB" && pwd -P)
CONTAINER=pi-job-spike-b-$$        # spike 自己指定；生产由 bot 建容器时写入内存映射（v1.1 §4.5）
docker run -d --init --rm --name "$CONTAINER" --user "$SPIKE_UID" \
  --read-only --tmpfs /tmp:rw,size=512m,noexec,nosuid \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 512 --memory 2g --memory-swap 2g --cpus 2 \
  -v "$JOB:$JOB:rw" -w "$JOB" "$PI_WORKER_IMAGE" sleep infinity >/dev/null

# exec 代理（v1.1 §4.5：全机唯一的 docker 入口；shim 只连它的 socket）
PROXY_LOG=$WORK/proxy.jsonl
: > "$PROXY_LOG"
node "$HERE/lib/stub-exec-proxy.mjs" --mode docker --listen "$JOB/.pi-bot/exec.sock" \
  --map "$JOB=$CONTAINER" --cmd-timeout-s "${PI_BOT_CMD_TIMEOUT_S:-120}" --log "$PROXY_LOG" \
  >"$WORK/proxy.out" 2>"$WORK/proxy.err" &
PROXY_PID=$!
j=0
while [ "$j" -lt 80 ]; do
  if grep -q 'PROXY_READY' "$WORK/proxy.out" 2>/dev/null; then break; fi
  if ! kill -0 "$PROXY_PID" 2>/dev/null; then echo "代理启动失败"; sed -n '1,20p' "$WORK/proxy.err"; exit 1; fi
  sleep 0.25
  j=$((j + 1))
done

: > "$WORK/probe.jsonl"
PI_DESKTOP_BASH=$HERE/sandbox-bash.sh
PI_BOT_EXEC_CLIENT=$HERE/lib/exec-client.mjs
PI_BOT_PROBE_LOG=$WORK/probe.jsonl
export PI_DESKTOP_BASH PI_BOT_EXEC_CLIENT PI_BOT_PROBE_LOG
HOST_LOG=$WORK/host.log
"$PI_HOST_BIN" --data-dir "$WORK/host" --port 0 --pair >>"$HOST_LOG" 2>&1 &
HOST_PID=$!
i=0
while [ "$i" -lt 120 ]; do
  if grep -q 'PI_HOST_READY' "$HOST_LOG" && grep -q 'PI_HOST_PAIRING_TOKEN' "$HOST_LOG"; then break; fi
  kill -0 "$HOST_PID" 2>/dev/null || { echo "pi-host 启动即退出（见 $HOST_LOG）"; sed -n '1,40p' "$HOST_LOG"; exit 1; }
  sleep 0.5; i=$((i + 1))
done
PORT=$(sed -n 's/.*"port":[ ]*\([0-9][0-9]*\).*/\1/p' "$HOST_LOG" | head -n 1)
PPT=$(sed -n 's/.*"token":[ ]*"\([^"]*\)".*/\1/p' "$HOST_LOG" | head -n 1)
HOST_VERSION=$(sed -n 's/.*"version":[ ]*"\([^"]*\)".*/\1/p' "$HOST_LOG" | head -n 1)
[ -n "$PORT" ] && [ -n "$PPT" ] || { echo "解析 PI_HOST_READY 失败，见 $HOST_LOG"; exit 1; }
URL="ws://127.0.0.1:$PORT/racp"
echo "pi-host v$HOST_VERSION port=$PORT"

PDT=$(node "$DRIVE" pair --url "$URL" --token "$PPT" --out "$WORK/pdt.txt" --log "$WORK/racp-pair.jsonl" 2>"$WORK/pair.err")
[ -n "$PDT" ] || { echo "配对失败，见 $WORK/pair.err"; exit 1; }

# 每轮都让模型做同一件便宜的事：一次 echo + 一次短 sleep，足够拉出「同时 running」的区间
PROMPT=$(cat <<'EOF'
只做一件事：用 Bash 工具执行 `sleep 8; echo TURN-DONE`，把输出原样贴出来。不要做别的，不要改文件。
EOF
)

# ---------------- 矩阵 ----------------
BASE_MED=""
n=1
while [ "$n" -le "$MAXN" ]; do
  echo
  echo "=== 并发度 n=$n ==="
  out=$WORK/n$n.out
  rc=0
  node "$DRIVE" concurrent --url "$URL" --token "$PDT" --project "$JOB" --prompt "$PROMPT" \
    --n "$n" --label "B$n" --log "$WORK/racp-B$n.jsonl" > "$out" 2>"$WORK/n$n.err" || rc=$?
  summary=$(grep -m 1 '^SUMMARY_JSON ' "$out" | sed 's/^SUMMARY_JSON //') || true
  if [ -z "$summary" ]; then
    echo "  驱动没有产出 SUMMARY_JSON（rc=$rc），见 $WORK/n$n.err"
    echo "$n,ERR,ERR,driver-failed," >> "$CSV"
    FAILS=$((FAILS + 1))
    n=$((n + 1))
    continue
  fi
  ov=$(printf '%s' "$summary" | sed -n 's/.*"overlapsPct":\([^,}]*\).*/\1/p')
  med=$(printf '%s' "$summary" | sed -n 's/.*"medianFirstEventMs":\([^,}]*\).*/\1/p')
  errs=$(printf '%s' "$summary" | sed -n 's/.*"errors":\(\[[^]]*\]\).*/\1/p')
  durs=$(printf '%s' "$summary" | sed -n 's/.*"durationMs":\([^,}]*\).*/\1/p' | tr '\n' ' ')
  echo "  overlaps=$ov%  medianFirstEventMs=$med  errors=$errs"
  printf '%s\n' "$summary" | sed 's/^/  /'
  echo "$n,$ov,$med,$errs,\"$durs\"" >> "$CSV"
  [ -n "$BASE_MED" ] || BASE_MED=$med

  # ---- 判定（阈值见 docs/spec/b0-spike.md §4.2）----
  case "$errs" in
    *QUEUE_FULL*|*TURN_RUNNING*|*"tool capacity"*|*"capacity"*)
      echo "  判定：被排队 / 被全局限流 —— 记录错误码，按 §4.4 退路处理" ;;
    *)
      awk -v ov="$ov" -v med="$med" -v base="$BASE_MED" -v n="$n" 'BEGIN{
        if (ov+0 >= 60 && (base=="" || base+0==0 || med+0 <= base*1.5)) printf "  判定：可并行（重叠 %s%%，首事件时延 %s ms ≤ 基线 1.5 倍）\n", ov, med;
        else if (ov+0 >= 60) printf "  判定：部分并行（重叠够，但首事件时延 %s ms 超过基线的 1.5 倍）\n", med;
        else printf "  判定：被排队（重叠只有 %s%%）\n", ov;
      }' ;;
  esac

  # 可选：sqlite 直查（只读），给结论表补一份「库内事实」
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "  -- turns 表快照 --"
    sqlite3 -readonly "$WORK/host/pi.sqlite" \
      "select session_id, status, count(*) from turns group by session_id, status;" 2>/dev/null | sed 's/^/    /' || \
      echo "    （读不到 turns 表：可能库文件名不同，按 tech-plan §4.2 的 data-dir 布局确认）"
  fi
  n=$((n + 1))
done

# ---------------- 汇总 ----------------
echo
echo "=== 矩阵结果（CSV：$CSV）==="
cat "$CSV"
echo
echo "  基线（n=1）medianFirstEventMs = ${BASE_MED:-?}"
echo "  探针日志（每个命令一次）：$WORK/probe.jsonl（$(wc -l < "$WORK/probe.jsonl" | tr -d ' ') 条）"
echo "  帧日志：$WORK/racp-B*.jsonl"
echo
echo "提醒：结论只对 pi-host v${HOST_VERSION:-?} 成立；内存预算按 tech-plan §3.5（每个 pi-host 栈 0.5–1.0 GB）折算。"
if [ "$FAILS" -eq 0 ]; then
  echo "矩阵跑完，把「判定」行抄进 docs/spec/b0-spike.md 的结论记录表。"
  exit 0
fi
echo "有 $FAILS 轮驱动失败：先修驱动/凭据，再重跑（矩阵必须全套有效才可判 R2）。"
exit 1
