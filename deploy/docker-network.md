# deploy/docker-network.md —— `pi-jobs` 专用 bridge 网络

tech-plan §6.2 / plan §8.2 / D7：容器之间不共享默认 bridge，出口策略靠 nftables 在这张网络上
DROP 私网段与云元数据段（见 `deploy/nftables.conf`）。

## 为什么不用 `--network=bridge`（默认）

- 默认 bridge 上还有别的容器（数据库、面板、别的项目），容器能凭 172.17.0.0/16 直接打到它们；
- 默认 bridge 没法单独挂 nftables 规则（要按接口名匹配，默认就是 `docker0`）；
- 需要一个**非 `internal`** 的网络：`internal` 会连公网也断掉，装依赖就废了。

## 建网络

```sh
# 固定子网，便于 nftables 里按接口名/网段核对；不要和宿主机现有网段重叠
docker network create \
  --driver bridge \
  --subnet 172.31.240.0/24 \
  --gateway 172.31.240.1 \
  pi-jobs
```

**不要加 `--internal`**（§6.2 明文：非 internal，所以能出公网）。
**不要加 `--ipv6`**：目前容器内只需要 IPv4 出口；IPv6 私网段在 nftables 里已被 DROP 兜底。

校验：

```sh
docker network inspect pi-jobs --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
# 找到 bridge 接口名（形如 br-<12 位 network id>，不是 "pi-jobs"）
ip -o link show | awk -F': ' '$2 ~ /^br-/ {print $2}'
```

把上一步出来的接口名写进 `deploy/nftables.conf` 的 `PI_JOBS_IF`，然后：

```sh
nft -c -f deploy/nftables.conf   # 只检查语法
nft -f deploy/nftables.conf      # 加载
```

## 从代码侧怎么用

`apps/server/src/sandbox/hostconfig.ts` 的默认 `NetworkMode` 就是 `pi-jobs`；
高风险任务（会自动推分支的 `/review-pr` 修复路径）可以显式传 `networkMode: 'none'`
切到加固档（§6.2 的可选档），此时容器完全无网络。

## 金丝雀检查（`pi-bot doctor` 的一项）

```sh
# 元数据必须打不通：期望 curl 失败（非 0 退出），而不是返回 200
docker run --rm --network pi-jobs curlimages/curl:latest \
  -sS -m 3 --fail http://169.254.169.254/latest/meta-data/ || echo "metadata-blocked"
```

`doctor` 的具体实现在 `apps/server/src/doctor/**`（W3-L 负责），这里只规定口径：
**打不通才叫 ok**，能打通一律 `fail` 并拒绝启动（§6.4）。

## 清理

```sh
docker network rm pi-jobs   # 需要先删掉接在它上面的容器
```
