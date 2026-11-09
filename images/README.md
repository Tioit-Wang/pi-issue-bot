# images/ —— worker 镜像

镜像只装工具链，**不带任何凭证**（plan §8.4 红线 2）。容器由 bot 以
`--user 1001:1001 --read-only --tmpfs /tmp --cap-drop ALL` 等参数启动（HostConfig 见
`apps/server/src/sandbox/hostconfig.ts`），Cmd 恒为 `sleep infinity`，命令一律走
exec 代理的 `docker exec`。

## 构建

```sh
# 基础档：Node 22 + bash + git（判定类任务 /issue-triage /issue-repro 用）
docker build -t pi-worker:node22 -f images/node22.Dockerfile images

# 带 pnpm 的变体（/review-pr 这类要装依赖的任务）
docker build -t pi-worker:pnpm-node22 --build-arg PNPM_VERSION=10.9.0 \
  -f images/node22.Dockerfile images
```

## 工具链标签（`pi-bot.toolchain` label + 镜像 tag 两处一致）

| tag | 基础镜像 | 内容 | 用途 | 内存档（tech-plan §3.6） |
|---|---|---|---|---|
| `pi-worker:node22` | `node:22-alpine` | bash、git、make、python3、curl、coreutils | 判定类（只读 + 少量命令） | 2 GB |
| `pi-worker:pnpm-node22` | 同上 + corepack/pnpm | 同上 + pnpm | 检出 + 装依赖 + 跑测试 | 4 GB |
| `pi-worker:python312` | 待补 | Python 3.12 工具链 | Python 仓库任务 | 2 GB |

## 硬约束（改动本目录前先读）

1. **uid/gid 恒为 1001**：与 `HostConfig.User = "1001:1001"` 对齐。改了这里，
   容器内的 `$HOME` 与 `git` 都会出问题。
2. **`/cache` 只读占位**：依赖缓存卷 `pi-dep-cache` 以 `:ro` 挂在 `/cache`，
   镜像里不需要也不允许往 `/cache` 写东西。
3. **不要有 ENTRYPOINT**：容器必须能靠 `sleep infinity` 常驻，否则 exec 代理没有可进的目标。
4. **不得引用 `/work`**：身份挂载下容器内路径 = 宿主 job 目录（tech-plan §4.5 E1）。
   `/work` 是 v0.4 的写法，已作废；任何 Dockerfile / 脚本 / 文档都不要再出现它。
5. **不装凭证**：不放 token、私钥、`.npmrc` 里的 auth、git credential helper 配置。

## 自检

```sh
# 非 root + bash 可用 + /cache 不可写
docker run --rm --user 1001:1001 --read-only --tmpfs /tmp pi-worker:node22 \
  sh -lc 'id -u; bash -lc "command -v git"; touch /cache/x || echo cache-ro-ok'
```

真容器断言（本机 Docker）跑在 `apps/server/test/sandbox-docker.test.ts`：
`pwd` 等于宿主路径、`touch /x` 失败、`/proc/1/cgroup` 私有命名空间、`id -u` = 1001、
`/sys/fs/cgroup/memory.max` 等于设定的上限、`timeout -s KILL` 生效、OOM 后 `State.OOMKilled = true`。
