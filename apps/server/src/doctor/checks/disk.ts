/**
 * `disk`：数据目录可用空间 ≥ 20 GB（tech-plan §6.4 / §3.5 的硬件规格）。
 *
 * 真读 `statfs`，不用「df 解析」也不用估算：
 *  - 用 `bavail`（非 root 可用的块数）而不是 `bfree`——容器与 bot 以 `pi` 用户跑，
 *    root 保留的 5% 对他们不可用，用 `bfree` 会系统性高估。
 *  - 只看**数据目录**所在的文件系统。把「/ 有空间」当成「能跑容器」是两回事，
 *    Docker 的数据盘常常是另一块盘（§3.5 的 80 GB SSD 指的就是它）。
 */
import { describeError, formatBytes } from '../deps.ts';
import type { CheckDefinition } from '../deps.ts';

export const diskCheck: CheckDefinition = {
  id: 'disk',
  title: '数据目录可用空间 ≥ 20 GB',
  async run(ctx) {
    let freeBytes: number;
    try {
      freeBytes = await ctx.fs.freeBytes(ctx.dataDir);
    } catch (error) {
      return {
        status: 'fail',
        detail: `读不到 ${ctx.dataDir} 的可用空间：${describeError(error)}`,
        fixHint: '确认数据目录存在且可读（PI_BOT_DATA_DIR；默认是仓库根）',
      };
    }

    const required = ctx.diskMinFreeBytes;
    const detail =
      `可用 ${formatBytes(freeBytes)} / 需 ≥ ${formatBytes(required)}（${ctx.dataDir}）`;
    if (freeBytes >= required) {
      return { status: 'ok', detail };
    }
    return {
      status: 'fail',
      detail,
      fixHint:
        '按 tech-plan §6.3 先清最旧的失败容器与 worktree（运行期 >85% 会自动清），或扩容数据盘；' +
        '临时放宽阈值可用 PI_BOT_DISK_MIN_GB',
    };
  },
};
