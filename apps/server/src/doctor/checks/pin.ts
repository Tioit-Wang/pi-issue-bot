/**
 * `pin`：`vendor/pi-host/<version>/PIN.json` 的每份 SHA256 与 `hostVersion` 全部匹配
 * （tech-plan §6.4 / §2.2 末尾五条）。
 *
 * 判定全部委托给 `runtime/pin.ts` 的 `verifyPin()`——**不在这里重写哈希逻辑**：
 * 预检与启动自检必须是同一套代码，否则「doctor 绿、启动红」就成了新的故障源。
 *
 * 本机（以及任何还没 vendored bundle 的环境）拿不到 bundle 时**降级成 `warn`**（`VENDOR_MISSING`）：
 * 这不是「通过」，报告里会明确写「未校验」。哈希不符则一律 `fail`——
 * `--allow-host-version-mismatch` 只放宽协商版本，永不放开哈希（§2.2 第 4 条），这里也一样：
 * `allowHostVersionMismatch` 在本检查里根本没有入口。
 */
import path from 'node:path';

import { PIN_ERROR_CODES, verifyPin } from '../../runtime/pin.ts';
import { describeError } from '../deps.ts';
import type { CheckContext, CheckDefinition } from '../deps.ts';

/**
 * 定位 bundle 目录：
 *  1. `PI_BOT_BUNDLE_DIR`（显式指定，生产首选）；
 *  2. `vendor/pi-host/` 下唯一的那个版本目录（`vendor/pi-host/0.21.0/`）；
 *  3. 都没有 → `undefined`（调用方报 `VENDOR_MISSING`）。
 */
export async function resolveBundleDir(ctx: CheckContext): Promise<string | undefined> {
  if (ctx.bundleDir !== undefined) {
    return ctx.bundleDir;
  }
  try {
    const entries = (await ctx.fs.readdir(ctx.vendorDir)).filter((name) => !name.startsWith('.')).sort();
    const first = entries[0];
    return first === undefined ? undefined : path.join(ctx.vendorDir, first);
  } catch {
    return undefined;
  }
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export const pinCheck: CheckDefinition = {
  id: 'pin',
  title: 'vendor/pi-host PIN.json 哈希与版本匹配',
  async run(ctx) {
    const bundleDir = await resolveBundleDir(ctx);
    if (bundleDir === undefined) {
      return {
        status: 'warn',
        detail: `${PIN_ERROR_CODES.missing}：${ctx.vendorDir} 下没有 vendored bundle（未校验，不等于通过）`,
        fixHint:
          'scripts/vendor-pi-host.mjs --version <v> 下载并重算 PIN.json（§2.2 第 3 条：升级 = 一次显式 PR）',
      };
    }

    try {
      const verified = await verifyPin({ bundleDir, readFile: ctx.fs.readBytes });
      return {
        status: 'ok',
        detail:
          `PIN.json 校验通过：hostVersion=${verified.pin.hostVersion}，` +
          `${String(verified.files.length)} 个文件 SHA256 一致；握手常量 wsPath=${verified.pin.wsPath}、` +
          `子协议=${verified.pin.wsSubprotocol} 与 racp-client 一致`,
      };
    } catch (error) {
      const code = errorCodeOf(error);
      // 「bundle 目录给我了但没有 PIN.json」= 等价于没 vendored：降级而不是 fail，
      // 否则 `PI_BOT_BUNDLE_DIR` 指向一个空目录就会挡住启动（那是配置笔误，不是安全事件）。
      if (code === PIN_ERROR_CODES.missing) {
        return {
          status: 'warn',
          detail: `${PIN_ERROR_CODES.missing}：${bundleDir} 里没有 PIN.json（未校验，不等于通过）`,
          fixHint: '用 scripts/vendor-pi-host.mjs 重新 vendored（PIN.json 与 bundle 必须同版本入库）',
        };
      }
      return {
        status: 'fail',
        detail: `${code ?? 'PIN_CHECK_FAILED'}：${describeError(error)}`,
        fixHint:
          '哈希不符视为被替换，一律拒绝启动（§2.2 第 4 条：--allow-host-version-mismatch 也只放宽协商版本）；' +
          '重新 vendored 并重算 PIN.json',
      };
    }
  },
};
