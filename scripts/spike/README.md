# scripts/spike —— B0 验证性 spike 脚本

**运行环境：目标 Linux 主机。本开发机（Windows，无 docker）能跑 `a1` / `00`；`a2` / `b` 需要 docker 与真实 pi-host，跑不了。**

机制依据 `docs/tech-plan.md` **v1.1 §4.5（F1）+ §4.7（F3）**：shim **不碰 docker**，只连本任务的 `<job>/.pi-bot/exec.sock`；超时下沉进容器。判定标准、通过/失败含义与退路全部写在 [`docs/spec/b0-spike.md`](../../docs/spec/b0-spike.md)，本文件只是索引。

## 顺序

```sh
# 1) 链路契约自检（不需要 docker：用 lib/stub-exec-proxy.mjs --mode stub 顶替 bot 的 exec 代理）
./a1-shim-contract.sh

# 2) 前置准备逐项自检
PI_HOST_BIN=/opt/pi-host/bin/pi-host \
PI_WORKER_IMAGE=pi-worker:pnpm-node22 \
PI_MODEL_KEY_PRESENT=1 \
RACP_SUBPROTOCOL=<PM 提供的子协议名> \
  ./00-preflight.sh

# 3) 验证 A：前台命令 / 后台任务 / 超时 kill 三段证据
PI_HOST_BIN=/opt/pi-host/bin/pi-host PI_WORKER_IMAGE=pi-worker:pnpm-node22 \
  ./a2-bash-path-probe.sh

# 4) 验证 B：1/2/3/4 并发矩阵
PI_HOST_BIN=/opt/pi-host/bin/pi-host PI_WORKER_IMAGE=pi-worker:pnpm-node22 \
  ./b-concurrency-matrix.sh
```

## 链路（v1.1）

```
host-core ─spawn─> sandbox-bash.sh ──找 <job>/.pi-bot/exec.sock──> exec-client.mjs ──单帧──> exec 代理
                                                                                        └─> docker exec … timeout -s KILL <n> bash -lc
```

- `sandbox-bash.sh`：线上 `/usr/local/lib/pi-bot/sandbox-bash`。上溯 ≤4 层找端点；找不到 `NO_EXEC_ENDPOINT` 退 2。
- `lib/exec-client.mjs`：线上 `/usr/local/lib/pi-bot/exec-client`。单帧 `{argv,cwd,clientPid}` + NDJSON 回传。
- `lib/stub-exec-proxy.mjs`：**spike 用的代理桩**。`--mode stub` 不碰 docker（验契约）；`--mode docker` 真跑 `docker exec … timeout`，并按 §4.7 做 cmdId 兜底。

## 约束

- **只往 `$PI_BOT_SPIKE_TMP`（默认 `${TMPDIR:-/tmp}/pi-bot-spike`）下写**，每个脚本用自己的 `mktemp -d`；不写仓库、不碰 `~/.pi-desktop`。
- 幂等：`a2`/`b` 退出时 `docker rm -f` 自己的容器、`kill` 自己的 pi-host 与代理。
- 任何一步失败即停并打印原因；`a1` 汇总所有 FAIL 后退出。
- 非 Linux 上 `a1` 会自动切 `tcp://` 旁路传输并跳过 C2/C3/C9（socket 语义与权限只在 Linux 可验）。
- `PI_BOT_CMD_TIMEOUT_S=10` 只是把命令级上限压短以便快速观察，生产是 120/300（tech-plan §4.7）。
- `*.sh` / `*.mjs` 必须保持 LF（见 `.gitattributes`）；仓库 `core.autocrlf=true` 会检出成 CRLF，CRLF 的 POSIX 脚本在 Linux 上 `bad interpreter: /bin/sh^M`。

## 环境变量速查

| 变量 | 用于 | 说明 |
|---|---|---|
| `PI_HOST_BIN` | a2 / b / 00 | pi-host bundle 入口 |
| `PI_WORKER_IMAGE` | a2 / b / 00 | worker 镜像（**需含 `bash`、`git`、`timeout`、`pkill`**） |
| `PI_BOT_SPIKE_TMP` | 全部 | 临时根目录（自建，脚本只往这里写） |
| `PI_BOT_SANDBOX_BASH` | a1 / 00 | 线上 shim 路径；给了就校验与仓库副本逐字节一致 |
| `PI_MODEL_KEY_PRESENT=1` | 00 | 自报「pi-host 已有模型凭据」 |
| `PI_BOT_CMD_TIMEOUT_S` | a2 / b | 命令级超时（秒），spike 用 10 |
| `SPIKE_UID` | a2 / b | 容器用户，默认 `1001:1001`（plan §8.1）；与 worktree 属主不一致时用 `$(id -u):$(id -g)` |
| `RACP_SUBPROTOCOL` | 驱动 | RACP 子协议名；**v1.1 §4.2 引用的 §14a 不存在，字面量必须由 PM 提供** |
| `MAXN` | b | 矩阵上限，默认 4 |

## 仅测试用的两个口子（生产不要设）

| 变量 / 参数 | 作用 |
|---|---|
| `PI_BOT_EXEC_CLIENT` | 把 shim 里的 `/usr/local/lib/pi-bot/exec-client` 指到仓库副本 |
| `PI_BOT_EXEC_SOCK` | 旁路端点发现（指向 `tcp://127.0.0.1:<port>`），仅在无 unix socket 的开发机上验证链路用 |
