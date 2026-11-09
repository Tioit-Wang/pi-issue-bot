/**
 * MSW 场景开关（`?mock=empty|error|unauthorized|slow`）。
 *
 * 为什么不放在请求 URL 上：面板的 API 请求由 `lib/api.ts` 统一拼参数，
 * 拦截层再往里塞一个只有 mock 认识的查询参数会污染真实接口契约。
 * 读**页面 URL** 最干净：`http://localhost:5173/system?mock=error` 打开即预览错误态，
 * 刷新不丢、也不需要改代码或重启。
 */
export type MockScenario = 'default' | 'empty' | 'error' | 'unauthorized' | 'slow';

export const MOCK_SCENARIOS: readonly MockScenario[] = ['default', 'empty', 'error', 'unauthorized', 'slow'];

/** 从查询串解析场景；未知值一律按 `default`（不能让一个拼错的参数把页面变成空白）。 */
export function parseScenario(search: string): MockScenario {
  const value = new URLSearchParams(search).get('mock');
  if (value === null) return 'default';
  const match = MOCK_SCENARIOS.find((scenario) => scenario === value);
  return match ?? 'default';
}

/** 读当前页面 URL 的场景（jsdom 里同样可用）。 */
export function readScenario(): MockScenario {
  return parseScenario(globalThis.location?.search ?? '');
}

/** 是否应该启用 MSW：URL 带 `mock=`，或显式设置了 `VITE_MOCK=1`。 */
export function shouldStartMocks(search: string = globalThis.location?.search ?? ''): boolean {
  if (new URLSearchParams(search).has('mock')) return true;
  return import.meta.env.VITE_MOCK === '1';
}
