#!/bin/sh
# 运行环境：目标 Linux 主机；本开发机无 docker 无法执行（无 docker 也能与本仓库的 stub-exec-proxy 联调）。
# 位置：线上 /usr/local/lib/pi-bot/sandbox-bash（0755）；本文件是仓库内副本，两者必须逐字节一致。
# 依据：docs/tech-plan.md v1.1 §4.5（F1）——**本脚本不接触 docker**。
#       它只把 host-core 的 `bash -lc <cmd>` 交给本任务的 exec 端点：
#       从 $PWD 上溯最多 4 层，取最近的 <dir>/.pi-bot/exec.sock；找不到即 NO_EXEC_ENDPOINT，退出 2（不回落宿主执行）。
# 依赖：/bin/sh、dirname；socket 客户端 = exec-client（Node，随 bundle 发货，见 v1.1 §4.5）。
set -eu

CLIENT=${PI_BOT_EXEC_CLIENT:-/usr/local/lib/pi-bot/exec-client}   # spike 用它指到 scripts/spike/lib/exec-client.mjs
TEST_SOCK=${PI_BOT_EXEC_SOCK:-}                                   # 仅本机无 unix socket 时用于验证链路；生产不设
here=$(pwd -P)
sock=$TEST_SOCK
d=$here
i=0
while [ -z "$sock" ] && [ "$i" -le 4 ]; do
  if [ -S "$d/.pi-bot/exec.sock" ]; then sock="$d/.pi-bot/exec.sock"; break; fi
  [ "$d" = "/" ] && break
  d=$(dirname "$d"); i=$((i + 1))
done

# 探针钩子：仅 B0 spike 用；生产不设 PI_BOT_PROBE_LOG 时零成本跳过。
if [ -n "${PI_BOT_PROBE_LOG:-}" ]; then
  printf '{"ts":%s,"pid":%s,"cwd":"%s","socket":"%s","argv":"%s"}\n' \
    "$(date +%s%3N)" "$$" "$here" "${sock:-}" "$(printf '%s\x1f' "$@" | sed 's/"/\\"/g')" \
    >> "$PI_BOT_PROBE_LOG"
fi

if [ -z "$sock" ]; then
  printf 'pi-bot: NO_EXEC_ENDPOINT: 向上 4 层内找不到 .pi-bot/exec.sock（cwd=%s）\n' "$here" >&2
  exit 2
fi

exec "$CLIENT" "$sock" "$here" "$@"
