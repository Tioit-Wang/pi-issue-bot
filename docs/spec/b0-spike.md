# B0 验证性 spike：命令真的进容器吗（R1）· 单 pi-host 并发上限（R2）

- **状态：待执行。** 脚本与判定标准已就绪；本开发机没有 `docker`，因此**本文不含任何实测结论**，§5 的结论表全部为空。
- **依据版本**：`docs/tech-plan.md` **v1.1**。A 系列机制**依据 v1.1 §4.5（F1）+ §4.7（F3）**，与 v1.0 的「shim 直连 `docker exec`」已不是一回事。
- **归属**：M0，对应 tech-plan §11 的 R1 / R2、§12 的 M0 验收项「R1/R2 两个风险有实测结论」。
- **事实源**：`docs/plan.md` v0.4（唯一事实源）、`docs/tech-plan.md` v1.1（§4.5 / §4.7 / §11 / §12）。
- **文件所有权**：本文件 + `scripts/spike/`。

---

## 0. 一句话（已按 v1.1 改写）

> **A**：把 `PI_DESKTOP_BASH` 指向 shim，shim 只做一件事 —— 从 `$PWD` 上溯找 `<job>/.pi-bot/exec.sock` 并把 argv/cwd 交给 exec 代理。于是三条路径（前台命令 / 后台任务 / 超时 kill）都要满足**三段证据**：① 探针日志里有这次的 shim 调用；② 代理日志里有对应请求（argv 正确、cwd 正确、**容器名来自代理的映射表**）；③ 命令表现出「在容器里」的可观察差异。任何一段缺失，D5 就破。
> **B**：同一个 pi-host 上 1/2/3/4 个 session 各起一个 `turn/start`，看 running 区间是否重叠、首事件时延是否随并发劣化、是否出现 `TURN_RUNNING` / `QUEUE_FULL` / `host tool capacity`。

两条都要钉住 **pi-host 版本**（`PI_HOST_READY.version`）：结论只对该版本成立。

---

## 1. 前置准备（需要项目经理在目标主机上备齐）

目标形态：一台 Linux 主机（Ubuntu 22.04+/Debian 12+，x86_64），能跑 `docker`，能出公网。

| # | 需要什么 | 怎么来 / 落位 | 校验方式 |
|---|---|---|---|
| P1 | docker daemon 可用，执行用户在 `docker` 组 | 主机自带 | `docker info` |
| P2 | worker 镜像（含 `bash`、`git`、`timeout`、`pkill`；**F3 之后需要在容器内跑 `timeout`**） | 由 `images/` 构建（tech-plan §6.1） | `docker run --rm <img> sh -c 'command -v bash timeout pkill'` |
| P3 | pi-host bundle 入口（`PI_HOST_BIN`） | 现成 bundle 解包到 `/opt/pi-host/` | 可执行；`--help` 有响应 |
| P4 | host-core 二进制 | 通常随 bundle；如需指定用 `--host-core <bin>` | `PI_HOST_READY.version` 打印出来 |
| P5 | **shim 落位** | `install -m 0755 -o root -g root scripts/spike/sandbox-bash.sh /usr/local/lib/pi-bot/sandbox-bash`；**必须 LF 行尾** | 可执行；与仓库副本 `cmp`；代码行里**不含 `docker`**（F1） |
| P6 | **exec-client 落位** | `/usr/local/lib/pi-bot/exec-client`（v1.1 §4.5 指定 Node 实现；仓库副本 `scripts/spike/lib/exec-client.mjs`） | 可执行；`node <client>` 能起 |
| P7 | **RACP 子协议名（必须由 PM 提供）** | v1.1 §4.2 引用了「§14a」，但全文没有给出字面量 —— 这是**真缺口**，不是笔误。缺它握手可能直接被拒 | 脚本按 `RACP_SUBPROTOCOL=<名字>` 注入；未注入时会打印 warn 并尝试不带子协议 |
| P8 | RACP 令牌 | 启动时加 `--pair`，读 stdout 第二行 `PI_HOST_PAIRING_TOKEN {token,expiresAt}` 得 `ppt1.…`（一次性、默认 10 分钟）；脚本用它调 `connection/pair` 换 `pdt1.…` | 脚本自动；失败重启 pi-host 重新 `--pair` |
| P9 | **模型凭据** | pi-host 必须能连模型。本仓库尚未固化注入方式，需 PM 确认 | 手工跑一次 `turn/start` 能拿到首个事件 |
| P10 | node ≥18（宿主已有 Node 24，见 v1.1 §4.5） | 主机自带或从 bundle 取 | `node -v` |
| P11 | `git`、coreutils（`mktemp`/`timeout`/`stat`/`base64`） | 主机自带 | `00-preflight.sh` |
| P12 | `sqlite3`（可选，只读直查 `turns`/`turn_queue`） | `apt install sqlite3` | `sqlite3 --version` |
| P13 | 磁盘 ≥20 GB（plan §8.5 硬下限；spike 自身 <1 GB） | — | `df -h` |

一键自检：`scripts/spike/00-preflight.sh`（逐项 `ok/warn/FAIL`，有 FAIL 非零退出）。

> **P7 与 P9 是两条硬前置**：缺 P7 握手可能失败，缺 P9 根本跑不出 turn。这两条不解决，A/B 都出不了结论。

---

## 2. 已确认的事实 vs 待判定的假设（证据等级要分清）

| 事实 / 假设 | 来源 | 等级 |
|---|---|---|
| pi-host CLI：`--data-dir` / `--port`（0=随机）/ `--host-core` / `--sidecar` / `--pair` / `--pairing-lifetime-ms` / `--log-level`；env：`PI_HOST_PORT` / `PI_HOST_BIND`（默认 `127.0.0.1`，非 loopback 拒绝）/ `PI_DESKTOP_DATA_DIR` / `PI_DESKTOP_BASH` | tech-plan §4.2（对 `apps/pi-host/src/cli.ts` 已核对） | 事实 |
| stdout 首行 `PI_HOST_READY {hostId,host,port,version}`；带 `--pair` 时第二行 `PI_HOST_PAIRING_TOKEN {token,expiresAt}`；**`--pair` 不会在配对后退出** | 同上 | 事实 |
| host-core 解析 bash 的第一优先级是 `PI_DESKTOP_BASH`（`shell.rs::find_bash()`；规范 `03-tools-and-permissions.md:681`） | tech-plan §4.5 引文 | 引文事实（本次未复核源码） |
| 覆盖点在出厂二进制里存在，且**会校验目标是不是可执行的普通文件**：含字面量 `PI_DESKTOP_BASH` 与错误串 `PI_DESKTOP_BASH points to '{path}', which is not an executable file.` | **本机复核**：`C:\Program Files\PI-Desktop\resources\bin\pi-desktop-host-core.exe`（PI-Desktop **0.22.0**，Windows 构建） | 旁证（证明存在+有校验，**不证明优先级**，也不能代替 Linux 构建） |
| 轮次队列是**会话级**的：`turn_queue(id, session_id, …, position, priority)`，`position` 按 `session_id` 递增，有 `QUEUE_FULL`、`IDEMPOTENCY_CONFLICT` | 同上二进制里的 SQL 字面量（`turn_queue.rs`） | 旁证（先验倾向「不全局排队」，仍需 B 实测） |
| 每 session 至多一个 running turn：`CREATE UNIQUE INDEX idx_turns_one_running_session … WHERE status='running'`；有 `TURN_RUNNING` 错误码 | 同上 | 旁证 |
| 存在**宿主级**工具预算：`tool_budget.rs`，报错串 `host tool capacity is exhausted; bounded queue is full (N queued)` | 同上 | 旁证。**这是 4 并发最可能撞到的闸**，与 turn 队列是两件事 |
| 后台任务有宿主级 + 会话级上限：`the host is already running its maximum of N background tasks across all sessions` / `this session already runs N background tasks (limit M)` | 同上（`background_tasks.rs`） | 旁证。A2 只起 1 个，不会撞上限 |
| shim 不碰 docker；端点 `<job>/.pi-bot/exec.sock`（0600，属主 `pi`，父目录 0700）；上溯 ≤4 层；找不到即 `NO_EXEC_ENDPOINT` 退 2 | tech-plan v1.1 §4.5（F1） | 事实（设计定稿） |
| 代理执行 `docker exec -i -w <cwd\|job_dir> <c> timeout -s KILL <n> bash -lc "<cmd>"`；宿主侧只留 `pkill -KILL -f "PI_CMD_ID=<uuid>"` | tech-plan v1.1 §4.5 / §4.7（F3） | 事实（设计定稿）；**但见 §8 的第 1 条缺陷** |
| 身份挂载优先，plan §8.1 的 `-v …:/work` **作废**（记为勘误） | PM 口述 + v1.1 §4.5 | 事实 |
| 版本漂移：本机 PI-Desktop 0.22.0，tech-plan §3.5 的内存实测基准是 PI SDK 0.21.0 | 本机版本信息 | 提醒：结论与内存预算都按实测版本重记 |

**A / B 的待判定项见 §3、§4。** 上面所有「旁证」只用来决定「看什么信号」，不作为判定依据。

---

## 3. 验证 A：命令真的进容器吗（依据 tech-plan v1.1 §4.5 / §4.7）

### 3.1 链路与断言的对应关系

```
host-core ──spawn──> sandbox-bash (shim)          ← 断言 A0/A1s/A2s/A3s：覆盖点被调、探针留痕
                          │ 上溯找 .pi-bot/exec.sock
                          ▼
                     exec-client ──单帧 {argv,cwd,clientPid}──> exec 代理（bot 进程）
                                                                    │ 断言 A1m/A1p：按映射表查容器
                                                                    ▼
                                                  docker exec … timeout -s KILL <n> bash -lc
                                                                    │ 断言 A1c/A2c/A3c/A3k：容器内特征
                                                                    ▼
                                                                 容器
```

**断言对象从「docker exec 被调用」变成「exec 端点被调用 + 代理收到正确 argv/cwd/容器」**。因此证据必须同时来自两侧日志（shim 探针 + 代理日志）与容器内部，缺一侧就只能记「部分」。

### 3.2 断言与判定方式

| ID | 断言 | 判定方式（一句话） | 通过标准 |
|---|---|---|---|
| **A0** | 覆盖点优先级真的生效 | `PI_DESKTOP_BASH` 指向不存在的路径，命令必须执行失败 | 失败且错误里提到 `PI_DESKTOP_BASH`/不可执行；若照样成功 → 覆盖没生效，A 全部作废 |
| **A1** | 前台命令经端点、在容器内 | 探针有记录 **且** 代理日志有 `request`（argv 正确）+ `docker-exec`（容器名来自映射）**且** 输出里有 `/.dockerenv` | 三段都满足 |
| **A1i** | shim 看到的 cwd 就是任务 worktree | 代理日志的 `cwd` == 任务 worktree 绝对路径 | 相等 |
| **A2** | 后台任务经端点、在容器内 | 探针有记录 **且** 容器内 `/tmp` 有标记文件（宿主 `/tmp` 没有） | 两条都满足 |
| **A3** | 超时 kill 走下新机制（F3） | 见 §3.3 的 A3 子项：容器内 `timeout` 生效 + cmdId 注入 + 无残留 + 兜底可匹配 | 子项全满足；只缺「兜底可匹配」记部分 |
| **A4** | shim/端点/协议契约 | `a1-shim-contract.sh` 的 C0–C10（无需 docker，宿主可跑） | 全 PASS |
| **A5** | 线上副本与仓库副本一致 | `cmp` | 逐字节相等 |

### 3.3 A 系列的操作步骤与判定

统一前置（除 A4 外都要）：

```sh
export PI_BOT_SPIKE_TMP=$HOME/pi-bot-spike          # 自建临时根目录，脚本只往这里写
# 1) 造 job worktree（脚本自动 git init + 一次 commit）
# 2) 起容器（身份挂载：宿主路径 == 容器路径；plan §8.1 的 /work 作废）
docker run -d --init --rm --name pi-job-spike \
  --user 1001:1001 --read-only --tmpfs /tmp:rw,size=512m,noexec,nosuid \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 512 \
  --memory 2g --memory-swap 2g --cpus 2 \
  -v <JOB>:<JOB>:rw -w <JOB> pi-worker:<toolchain> sleep infinity
# 3) 起 exec 代理（v1.1 §4.5；全机唯一的 docker 入口是 bot，spike 里由桩代演）
node scripts/spike/lib/stub-exec-proxy.mjs --mode docker \
  --listen <JOB>/.pi-bot/exec.sock --map <JOB>=pi-job-spike \
  --cmd-timeout-s 10 --pkill-fallback --log <tmp>/proxy.jsonl
# 4) 起 pi-host：env 里只放 shim 与端点客户端，不放任何 docker 相关变量
PI_DESKTOP_BASH=/usr/local/lib/pi-bot/sandbox-bash \
PI_BOT_EXEC_CLIENT=/usr/local/lib/pi-bot/exec-client \
PI_BOT_PROBE_LOG=<tmp>/probe.jsonl \
  pi-host --data-dir <tmp>/host --port 0 --pair
# 5) 读前两行 → port + ppt1. → connection/pair 换 pdt1. → 建 session → 发 turn
```

> spike 用 `stub-exec-proxy.mjs` 代演 bot 进程里的代理（会真跑 `docker exec`）；生产里这一步由 bot 自己做，协议与命令行一致（v1.1 §4.5）。

#### A0 —— 负向探针（证明「这个开关说了算」）

- **操作**：`PI_DESKTOP_BASH=/nonexistent/pi-bot-probe` 起 pi-host（独立 data-dir），发一条 turn 执行 `printf 'MARKER-A1NEG %s\n' "$PWD"`。
- **证据**：工具结果里出现 `PI_DESKTOP_BASH` 相关错误；**没有** `MARKER-A1NEG`。
- **通过标准**：命令没执行成功。
- **失败意味着什么**：覆盖点优先级不成立 → 整套 shim 方案前提崩掉。
- **退路**：走 tech-plan §11 R1 的两条：`tools/advertise` relay（规范 §9.4 未实现）或「每任务一个 pi-host + 容器内 agent」，接受 plan §4.3 的代价。

#### A1 —— 前台命令

- **操作**：`PI_DESKTOP_BASH` 指向 shim、探针打开、代理就绪，发一条 turn 执行：
  `printf 'MARKER-A1 '; printf '%s\n' "$PWD"; ls -l /.dockerenv 2>&1; hostname; head -n 3 /proc/self/cgroup`
- **证据**（三段）：
  1. `probe.jsonl` 有一条记录，`argv` 含 `MARKER-A1`、`cwd` == JOB、`socket` == `<JOB>/.pi-bot/exec.sock`；
  2. `proxy.jsonl` 有一条 `request`（`argv = ["bash","-lc",<cmd>]`、`cwd`、`clientPid`、生成的 `cmdId`）与一条 `docker-exec`（容器名来自映射表）；
  3. turn 的工具输出里 `/.dockerenv` 存在、`hostname` 是容器 ID；宿主侧对照为「不存在/不是」。
- **通过标准**：三段齐。
- **失败意味着什么**：①有 ②无 → shim 调了端点但请求没到/字段错（协议或客户端问题）；②有 ③无 → 代理查到了容器但命令实际在宿主跑（`docker exec` 参数拼错、容器名映射错）；①无 ②有 → 存在**第二条执行路径**，D5 的「唯一通道」不成立；①有 ②无 ③无 → agent 没调用 Bash（prompt/审批/凭据）。
- **退路**：协议/客户端问题按 §8 的契约修；出现第二条执行路径则记 R1 失败，走 A0 的退路。

#### A2 —— 后台任务

- **操作**：发一条 turn，让 agent **用工具的后台参数**（不是自己 `&`）启动：
  `sh -c 'echo MARKER-A2 > /tmp/pi-bot-spike-A2; sleep 60'`，随后立刻结束本轮。
- **证据**：探针有 `MARKER-A2` 记录；`docker exec <c> test -f /tmp/pi-bot-spike-A2` 成功，**宿主 `test -f` 失败**（容器 `/tmp` 是 tmpfs）。
- **通过标准**：两条齐。
- **失败意味着什么**：后台任务由另一个 spawn 点实现（`background_tasks.rs` 里绕过 `find_bash()`），D5 在「agent 用后台命令跑长任务」这条路上破 —— 而这正是 `/review-pr` 会踩的路径。
- **退路**：①自动审批策略 deny 后台任务（最小权限，靠三层时间闸兜）；②把「后台」改成控制面实现（代理侧 `docker exec -d` + job 句柄，工作量大但不依赖 Host 行为）。

#### A3 —— 超时 kill（**按 v1.1 §4.7 F3 重写**）

机制已变：宿主侧不再有 `timeout`；**超时由代理拼进容器内**，宿主侧只留 cmdId 兜底，任务取消/超时则销毁容器。因此判定拆成 8 个子项：

| 子项 | 断言 | 判定方式 | 通过标准 |
|---|---|---|---|
| **A3s** | 超时路径也经过覆盖点 | 探针日志有该命令记录 | 有 |
| **A3t** | 超时**在容器内**生效 | 代理日志的 `docker-exec` argv 里出现 `timeout -s KILL <n> bash -lc`，且 `<n>` == 配置的命令级上限 | 形状与数值都对 |
| **A3c** | 命令被中断 | turn 输出里没有完成标记（`MARKER-A3-DONE`） | 没有 |
| **A3k** | 容器内无残留进程 | 命令结束后 `docker exec <c>` 扫 `/proc/*/cmdline` 找不到 `sleep 400` | 找不到 |
| **A3i** | 代理生成了 cmdId | 代理日志里该命令的 `cmdId` 形如 `PI_CMD_ID=<uuid>` | 有 |
| **A3e** | cmdId 注入进了容器环境 | `docker-exec` argv 里有 `-e PI_CMD_ID=<uuid>` | 有 |
| **A3f** | 兜底**策略**可匹配 | 在容器里起一个 `PI_CMD_ID=… sleep 30`，扫 `/proc/*/environ` 能命中 | 命中 |
| **A3f2** | 复现 v1.1 字面缺陷 | 同一条命令上 `pkill -0 -f "PI_CMD_ID=…"` | **预期命中不到**（见 §8 第 1 条） |

- **操作**：`--cmd-timeout-s 10` 起代理，发 turn 执行 `sleep 400; echo MARKER-A3-DONE`。
- **通过标准**：A3s/A3t/A3c/A3k/A3i/A3e/A3f 全满足；A3f2 若**真**命中了，说明实现把 cmdId 也写进了 cmdline（那样 v1.1 字面就成立），此时应把 A3f 的结论改成「两种做法都行」。
- **失败意味着什么**：
  - A3t 失败 → 超时仍在宿主侧（回到 v1.0 的洞：容器里进程继续跑、agent 下一条命令与它同写一个 worktree）。
  - A3k 失败 → 容器内 `timeout` 没杀掉进程树（改用 `timeout --kill-after` 或 `setsid` 包一层）。
  - A3f 失败 → **cmdId 兜底彻底失效**：宿主侧只剩「销毁容器」一条路，任何「命令级超时但任务继续」的场景都会留残留。
- **退路（按代价）**：
  1. 容器内改用 `exec timeout --kill-after=5 -s KILL <n> bash -lc "<cmd>"`（进程树更彻底）；
  2. 兜底改成「扫 `/proc/*/environ` 找 cmdId」（A3f 已验证可匹配），或把 cmdId 同时以注释形式写进 cmdline 让 `pkill -f` 也能命中；
  3. 单命令超时即销毁容器（最干净，代价是丢掉依赖缓存，每次重建 +1–2 s）；
  4. 只靠任务级销毁（最省事、最不严谨）：必须在 tech-plan §4.5/§4.7 写明「命令级超时可能留残留」。

#### A4 —— 契约自检（不需要 docker）

`a1-shim-contract.sh` 用 `lib/stub-exec-proxy.mjs --mode stub` 顶替代理，验 C0–C10：shim 形状与「代码里不含 docker」（F1 硬断言）、端点发现、上溯 4 层边界（第 4 层命中 / 第 5 层不命中）、无端点退 2、退出码透传（42/137）、stdout/stderr 分流、**容器名由代理查表**（两个 job 同一端点拿到不同容器）、`NO_JOB_MAPPING` 退 3、socket 权限、探针字段。**这一步在任意有 node 的 Linux 上都能跑，建议每次改 shim 都跑**。

---

## 4. 验证 B：单 pi-host 多 session 的并发矩阵

### 4.1 断言

| ID | 断言 | 判定方式 | 通过标准 |
|---|---|---|---|
| **B1** | 4 个 session 的 turn 能同时 running | 4 个 turn 的 `[tStart, tEnd]` 区间重叠 | ≥60% 采样时刻有 ≥2 个 turn 在跑 |
| **B2** | 并发不引入额外排队时延 | 首事件时延与 1 并发基线比 | 4 并发的中位数 ≤1.5× 基线 |
| **B3** | 不触发 turn 级互斥 | 收集 `turn/start` 错误码 | 无 `TURN_RUNNING`、无 `QUEUE_FULL` |
| **B4** | 不触发宿主级工具预算限流 | 事件流/错误里搜 `host tool capacity` | 一次都没有 |

B3 与 B4 必须分开记：**turn 没排队 ≠ 工具没被限流**。旁证显示 `turn_queue` 按 session 分，但 `tool_budget` 是宿主级共享，最可能的实测结果是「B1–B3 通过、B4 部分触发」。

### 4.2 怎么造多 session

- 同一个 pi-host（一个 `--data-dir`）：`project/register {path: <job worktree>}` → `session/create {projectId, permissionMode:"ask", mode:"agent"}` **四次**；
- 每个 session 先 `events/subscribe {sessionId, after:0}`，再并发 `turn/start`；
- 4 个 turn 的 prompt 一致且便宜（脚本用 `sleep 8; echo TURN-DONE`）；
- 轮次之间不复用 hot session（避免上下文影响时延）。

> B 只测调度，所以 4 个 session 共用一个 project 与一个容器；真实形态一任务一容器（tech-plan §6）。

### 4.3 看什么证据（四类，缺一类不算结论）

| 证据 | 采集点 | 关注什么 |
|---|---|---|
| `turn/start` 返回 | RACP 调用结果 | `turnId` 是否立即返回；是否有 `queued` 字段；错误码 |
| turn 状态 | 轮询 `turn/get`（2 s 一次） | 终态类型、`running` 持续时长 |
| 事件流时间戳 | `events/subscribe` 之后的通知 | 首事件时延、首个 tool 事件时间 |
| data-dir 内 SQLite（只读） | `sqlite3 -readonly <data-dir>/pi.sqlite 'select session_id,status,count(*) from turns group by 1,2'` | 是否真有多行同时 `running`（比时间戳更硬） |

### 4.4 量化判定与退路

| 观察 | 判定 |
|---|---|
| 重叠 ≥60%、时延中位数 ≤1.5× 基线、无 `TURN_RUNNING`/`QUEUE_FULL`/`capacity` | **可并行**，R2 关闭 |
| 重叠 ≥60%，但出现 `host tool capacity` | **部分并行**：turn 能并行、工具被宿主级预算限流 → 按工具预算定并发槽 |
| 第 k 个 turn 的首事件出现在第 k−1 个结束之后（间隔 ≥ 前者时长 ×0.8） | **被排队**，R2 成立 |
| `turn/start` 直接返回 `TURN_RUNNING` / `QUEUE_FULL` | **被排队（硬失败）**，记错误码原文 |

**不满足时的退路**：每 2 个并发槽一个 pi-host，各自 `--data-dir`（tech-plan §11 R2）。代价按 §3.5 折算：空载栈 ≈202 MB，真实会话按 0.5–1.0 GB 预算 → 4 并发用 2 个 pi-host 是 **+0.5–1.0 GB**；运维上多出 N 套配对令牌、N 个 data-dir、N 份 `doctor` 检查。

---

## 5. 结论记录表（待填）

> 规则：一条断言一行；「证据」填 `probe.jsonl` / `proxy.jsonl` / `racp-*.jsonl` 的文件名或输出摘要；「影响」必须落到「不改方案 / 改 tech-plan §x / 触发某条退路」之一。

| # | 断言 | 实测日期 | 实测人 | 结果 | 证据 | 影响 |
|---|---|---|---|---|---|---|
| A0 | 覆盖点优先级生效 | | | | | |
| A1 | 前台命令经端点、在容器内（三段） | | | | | |
| A1i | shim 的 cwd == 任务 worktree | | | | | |
| A2 | 后台任务经端点、在容器内 | | | | | |
| A3 | 超时 kill 走新机制（A3s/t/c/k/i/e/f/f2） | | | | | |
| A4 | shim/端点/协议契约（a1 C0–C10） | | | | | |
| A5 | 线上副本 == 仓库副本 | | | | | |
| B1 | 4 turn 并行（重叠 ≥60%） | | | | | |
| B2 | 首事件时延 ≤1.5× 基线 | | | | | |
| B3 | 无 `TURN_RUNNING`/`QUEUE_FULL` | | | | | |
| B4 | 无 `host tool capacity` 限流 | | | | | |

> **A4 已有一个非权威的通过记录**：开发机（Windows + Git Bash，tcp 旁路传输）上 C0–C8/C10 全 PASS，C2/C3/C9 因非 Linux 跳过。它只说明「shim → 端点 → 代理」这条链的契约成立，**不是** A 的判定结论。

环境事实（否则不可复现）：

| 项 | 值 |
|---|---|
| pi-host 版本（`PI_HOST_READY.version`） | |
| 主机规格（RAM/vCPU/磁盘/docker 版本） | |

---

## 6. 执行顺序与时间预算

| 步 | 命令 | 前置 | 耗时 |
|---|---|---|---|
| 1 | `./scripts/spike/a1-shim-contract.sh` | 任意有 node 的 Linux（不需要 docker） | 1 min |
| 2 | `PI_HOST_BIN=… PI_WORKER_IMAGE=… ./scripts/spike/00-preflight.sh` | P1–P13 | 2 min |
| 3 | `PI_HOST_BIN=… PI_WORKER_IMAGE=… ./scripts/spike/a2-bash-path-probe.sh` | 步 1/2 通过；P5/P6/P7/P8/P9 | 10–20 min |
| 4 | `PI_HOST_BIN=… PI_WORKER_IMAGE=… ./scripts/spike/b-concurrency-matrix.sh` | 步 3 通过 | 15–30 min |
| 5 | 填 §5，回写 tech-plan §11 R1/R2 | 步 3/4 | 15 min |

总预算约 1 小时（不含凭据排障）。所有脚本可重复执行；临时数据都在 `$PI_BOT_SPIKE_TMP`，不写仓库。

---

## 7. 脚本清单

| 文件 | 作用 | 需要 docker |
|---|---|---|
| `scripts/spike/sandbox-bash.sh` | shim（不碰 docker）：上溯 ≤4 层找 `exec.sock`，交给 exec-client；找不到退 2 | — |
| `scripts/spike/lib/exec-client.mjs` | 端点客户端：单帧请求 + NDJSON 回传（v1.1 §4.5 的协议） | — |
| `scripts/spike/lib/stub-exec-proxy.mjs` | exec 代理桩：`--mode stub`（无 docker，验契约）/ `--mode docker`（真跑 `docker exec … timeout`，含 cmdId 兜底） | docker 模式需要 |
| `scripts/spike/a1-shim-contract.sh` | C0–C11 契约自检（A4/A5），开发机上已跑通 | 不需要 |
| `scripts/spike/00-preflight.sh` | 前置准备自检（含「shim 代码里不含 docker」断言） | 查询用 |
| `scripts/spike/a2-bash-path-probe.sh` | A0/A1/A2/A3 全流程 + 三段证据汇总 | 需要 |
| `scripts/spike/b-concurrency-matrix.sh` | B 的 1/2/3/4 矩阵 + 判定行 + CSV | 需要 |
| `scripts/spike/lib/racp-drive.mjs` | 最小 RACP 驱动（pair / run / concurrent），自带 WS 帧层 | — |
| `scripts/spike/.gitattributes` | 强制 `*.sh`/`*.mjs` 用 LF（仓库 `core.autocrlf=true`） | — |

**诚实说明**：`racp-drive.mjs` 的**请求字段名按 tech-plan §4.4 的操作清单猜写**，未经真实 Host 校验；第一次跑若报 `SCHEMA_SUSPECT`，按 `packages/shared/fixtures/racp.schema.json` 改它一个文件即可（所有收发帧都在 `racp-*.jsonl` 里）。

---

## 8. 已知阻塞与需要 PM 决策的项

1. **[新，重要] v1.1 §4.7 的字面兜底命令匹配不到自己的标记。** 原文是 `docker exec <c> pkill -KILL -f "PI_CMD_ID=<uuid>"`，而按 §4.5 的写法 cmdId 只能经 `docker exec -e PI_CMD_ID=<uuid>` 注入**环境变量**；`pkill -f` 只看 `/proc/<pid>/cmdline`，不看 `environ`。所以字面实现下这道兜底**一条也杀不掉**（A3f2 就是用来复现它的）。三个可选修法：① 兜底改为扫 `/proc/*/environ`（a2 里已验证可命中）；② 把 cmdId 同时以 `# PI_CMD_ID=<uuid>` 写进 cmdline 让 `-f` 命中；③ 放弃兜底，命令级超时即销毁容器。
2. **v1.1 §4.5 的「cwd 越界则回退 `job_dir`」与「不在映射内即 `NO_JOB_MAPPING`」互相冲突**：越界的 cwd 到底该回退到 job 根执行，还是该拒绝？spike 的代理桩选了后者（拒绝），因为它更符合最小权限；需要 PM 在 §4.5 里定一个。
3. **[阻塞] RACP 子协议名缺失**：v1.1 §4.2 写了「见 §14a」，但全文没有 §14a，也没有子协议字面量。这会让握手直接失败或静默降级。脚本已留 `RACP_SUBPROTOCOL` 注入点，但**字面量必须由 PM 提供**。
4. **模型凭据注入方式未固化**（P9）：这是 spike 能否执行的单点前置。
5. **版本钉**：本机 PI-Desktop 0.22.0，tech-plan §3.5 基准 0.21.0。结论表必须记 `PI_HOST_READY.version`。
6. **worker 镜像 uid 与 worktree 属主**：plan §8.1 用 `--user 1001:1001`，worktree 由控制面以运行用户创建；uid 不一致直接 EACCES，会把 A1/A2 的失败误判成「没进容器」。脚本提供 `SPIKE_UID` 覆盖。
7. **worker 镜像必须带 `timeout` 与 `pkill`**（F3 之后这两个是容器内必需品）：`images/` 的 Dockerfile 要加，`doctor` 也应校验。
8. **`exec-client` 依赖宿主 Node**：v1.1 §4.5 已确认「宿主已有 Node 24，不往镜像里装工具」。但要钉住**绝对路径**（`/usr/local/lib/pi-bot/exec-client`），别依赖 `PATH`。

---

## 9. 本次在这个开发机上做了什么 / 没做什么（自查）

**做了**：

- 读 `plan.md` v0.4 与 `tech-plan.md` **v1.1** 的 §3.5/§4.2/§4.5/§4.7/§6/§11/§12，A 系列的机制与判定全部按 v1.1 重写，未自创方案。
- 确认本机无 `docker`（`Get-Command docker` 无结果）、WSL 不可用、有 Git Bash + node 24。
- 用 `sh -n` 对 6 个 `.sh` 做语法检查、`node --check` 对 3 个 `.mjs` 做语法检查：全通过。
- **在本机真跑了 `a1-shim-contract.sh`**（Windows + Git Bash，unix socket 不可用 → 脚本自动切 tcp 旁路）：C0/C0b/C0c/C1a–C1i/C4/C5/C5b/C6a/C6b/C7a/C7b/C7c/C8/C10 全 PASS，C2/C3/C9 因非 Linux 跳过。这条链路是 **shim → exec-client → stub-exec-proxy**，覆盖了「argv/cwd 正确、容器名查表、退出码与流透传、NO_EXEC_ENDPOINT 退 2、NO_JOB_MAPPING 退 3、探针字段」。
- 跑通过程中抓出两个真 bug 并修掉：① `docker exec` 的 `exec` 子命令（v1.0 版脚本的期望串漏了）；② 代理映射表的路径比较在分隔符混用（`\` vs `/`）时失配 → 已改为归一化后比较。

**没做**：

- `a2` / `b` 未执行（本机无 docker，跑不了容器）；`--mode docker` 分支与所有容器内断言未验证。
- 未核对 `crates/host-core/src/tools/shell.rs::find_bash()` 源码（本机只有发布二进制）；§2 那一行仍按 v1.1 §4.5 的引文记账。
- `racp-drive.mjs` 未做真实握手（协议字段未经真实 Host 校验）。
- 本机 PI-Desktop 二进制旁证只做过一次字符串级核对，未在 Linux 构建上复核。
