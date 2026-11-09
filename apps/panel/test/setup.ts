import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * jsdom 的环境补齐（**只补浏览器有、jsdom 没有的**，不改被测代码行为）。
 *
 * - `ResizeObserver`：Recharts 的 `ResponsiveContainer` 依赖它，jsdom 没实现；
 *   给它一个「什么都不做」的实现，图表会按 0 尺寸渲染（测试里只断言页面级四态，不比对图形）。
 * - `matchMedia`：暗色跟随系统的媒体查询在 jsdom 里不存在，组件/样式查询会抛。
 *
 * 顺带在每个用例后 `cleanup()`：RTL 16 在 `globals: false`（本仓库的配置）下不会自动清理。
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});
