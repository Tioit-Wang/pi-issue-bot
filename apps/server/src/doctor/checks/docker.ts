/**
 * `docker`：daemon 可达（tech-plan §6.4 第一项 / plan §8.5）。
 *
 * 真跑 `ping()`——不是「socket 文件存在」，也不是「`docker` 命令在 PATH 上」。
 * socket 存在但 daemon 没起来时，只有 ping 会失败；而恰恰那种状态最容易被误判为「装好了」。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

export const dockerCheck: CheckDefinition = {
  id: 'docker',
  title: 'docker daemon 可达',
  async run(ctx) {
    const started = ctx.elapsed();
    try {
      await ctx.docker.ping();
    } catch (error) {
      return {
        status: 'fail',
        detail: `ping 失败：${describeError(error)}`,
        fixHint:
          '启动 Docker daemon（systemd: `systemctl enable --now docker`），并确认 PI_BOT_DOCKER_SOCKET 指向正确：' +
          'Linux 默认 /var/run/docker.sock，Windows 默认 //./pipe/docker_engine',
      };
    }
    const elapsedMs = Math.max(0, Math.round(ctx.elapsed() - started));

    // 版本只是「在线证明」的附加信息：拿不到不影响结论（ping 已经成立）。
    const version = await ctx.run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 10_000,
    });
    const serverVersion = version.code === 0 ? version.stdout.trim() : '';
    return {
      status: 'ok',
      detail:
        serverVersion.length > 0
          ? `daemon 可达（Server ${serverVersion}，ping 往返 ${String(elapsedMs)}ms）`
          : `daemon 可达（ping 往返 ${String(elapsedMs)}ms；版本未取到）`,
    };
  },
};
