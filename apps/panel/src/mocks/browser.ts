import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers/index.ts';
import { shouldStartMocks } from './scenario.ts';

/**
 * 浏览器侧 MSW（只在 `?mock=` / `VITE_MOCK=1` 时启动，见 `main.tsx`）。
 *
 * `public/mockServiceWorker.js` 由 `pnpm --filter @pi-issue-bot/panel exec msw init public --save` 生成并入库；
 * 换 MSW 大版本后要重跑一次，否则 worker 与客户端协议不匹配（浏览器控制台会提示）。
 *
 * 注意 MSW 3 的选项名：`onUnhandledRequest` 已改成 `onUnhandledFrame`
 * （未拦截的请求，例如 Vite 的 HMR 资源，原样放行）。
 */
export const worker = setupWorker(...createHandlers());

export async function startMocks(): Promise<void> {
  if (!shouldStartMocks()) return;
  await worker.start({ onUnhandledFrame: 'bypass' });
}
