/**
 * `host`：pi-host 可用（`connection/ping`，tech-plan §6.4 第七项）。
 *
 * 为什么是**注入**：真握手要 `vendor/pi-host` bundle + `racp-client` 起一个 WS 连接，
 * 而本机没有 bundle（dev-plan §13.1）。所以这条检查的形状是
 *  - 调用方给了 `hostPing`：真调一次（`serve`/`bootstrap` 那边已经很会做这件事）；
 *  - 没给：`warn`，并在 detail 里说明「为什么没验」，而不是假装 `ok`。
 *
 * 不做的事：doctor 自己 spawn 一个 pi-host。预检不该顺手拉起一个长跑进程——
 * 那是 `bootstrap-host` / `serve` 的职责，doctor 只回答「现在这一套能不能起来」。
 */
import { describeError } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

export const hostCheck: CheckDefinition = {
  id: 'host',
  title: 'pi-host 可用（connection/ping）',
  async run(ctx) {
    const hostPing = ctx.hostPing;
    if (hostPing === undefined) {
      return {
        status: 'warn',
        detail:
          '未注入 connection/ping（本机无 vendor/pi-host bundle，dev-plan §13.1）：pi-host 可用性未校验，不等于通过',
        fixHint:
          '在有 bundle + 设备令牌的目标机上跑 `pi-bot doctor`（或让 serve/bootstrap 注入 hostPing）；' +
          '先 `pi-bot bootstrap-host` 完成配对（tech-plan §4.2）',
      };
    }

    const started = ctx.elapsed();
    try {
      const handshake = await hostPing();
      const elapsedMs = Math.max(0, Math.round(ctx.elapsed() - started));
      return {
        status: 'ok',
        detail: `connection/ping 成功：hostVersion=${handshake.hostVersion}（往返 ${String(elapsedMs)}ms）`,
      };
    } catch (error) {
      return {
        status: 'fail',
        detail: `connection/ping 失败：${describeError(error)}`,
        fixHint:
          '确认 pi-host 进程在跑、设备令牌有效（`pi-bot bootstrap-host --repair`）；' +
          '版本不符要重算 PIN.json（§2.2 第 2 条）',
      };
    }
  },
};
