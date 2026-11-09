# pi-worker:node22 —— 沙箱 worker 镜像（Node 22 + 最小工具链）
#
# 设计约束来自 plan §8.1 / §8.4 与 tech-plan §6.1，逐条对应：
#   1. **非 root**：固定 uid/gid 1001（`--user 1001:1001` 由 HostConfig 传，镜像里也要有对应账户，
#      否则 `$HOME`、`/etc/passwd` 查询会失败，`npm` 之类的工具会报警）。
#   2. **无凭证**：镜像里不写任何 token / 私钥 / git credential；模型请求由宿主代发（红线 2）。
#   3. **`/cache` 只读**：依赖缓存卷以 `:ro` 挂在这里（§6.1），镜像内的 `/cache` 目录只做占位。
#   4. **不需要 ENTRYPOINT**：容器 Cmd 是 `sleep infinity`（HostConfig 里给），
#      命令一律由 exec 代理发起 `docker exec`（§4.5）。
#   5. **不得引用 `/work`**：身份挂载下容器内路径 = 宿主 job 目录（tech-plan §4.5 E1）。
#
# 构建：
#   docker build -t pi-worker:node22 -f images/node22.Dockerfile images
# 带 pnpm 的变体：
#   docker build -t pi-worker:pnpm-node22 --build-arg PNPM_VERSION=10.9.0 -f images/node22.Dockerfile images

FROM node:22-alpine

# 工具链：bash 是硬需求（代理执行 `bash -lc`），git 是检出 / diff 的硬需求，
# 其余是常见构建脚本会顺手调用的东西。故意**不装** curl/wget 之外任何网络工具，
# 也不装编译器：需要编译的任务换 `pi-worker:build-*` 镜像。
RUN apk add --no-cache \
      bash \
      git \
      openssh-client \
      tini \
      ca-certificates \
      coreutils \
      findutils \
      grep \
      sed \
      gawk \
      tar \
      gzip \
      xz \
      make \
      python3 \
      curl

# uid/gid 固定 1001（与 HostConfig 的 `--user 1001:1001` 对齐）
RUN addgroup -g 1001 -S pi \
 && adduser -u 1001 -G pi -S -h /home/pi -s /bin/bash pi

# 依赖缓存挂载点（运行时以 `:ro` 挂载；镜像里只占位，属主 root、不可写）
RUN mkdir -p /cache \
 && chown root:root /cache \
 && chmod 0555 /cache

# git 的全局配置写进用户目录（agent 在容器里可能需要 git status/diff）
RUN git config --system --add safe.directory '*' \
 && git config --system core.pager cat

# 可选：带上 pnpm（`--build-arg PNPM_VERSION=10.9.0`）
ARG PNPM_VERSION=
RUN if [ -n "$PNPM_VERSION" ]; then \
      corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate; \
    fi

# 便于排障的身份信息（不打任何凭证）
ENV HOME=/home/pi \
    CI=true \
    TERM=dumb \
    LANG=C.UTF-8

USER 1001:1001
WORKDIR /home/pi

LABEL org.opencontainers.image.title="pi-worker:node22" \
      org.opencontainers.image.description="pi-issue-bot 沙箱 worker（Node 22 + bash + git，非 root，无凭证）" \
      pi-bot.toolchain="node22" \
      pi-bot.uid="1001"

# 没有 ENTRYPOINT / CMD：容器始终由 HostConfig 的 `Cmd: ["sleep","infinity"]` 启动
