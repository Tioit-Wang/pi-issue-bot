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

/*
 * 指针捕获与滚动：Radix 的 `Select` / `Popover` 在 `pointerdown` 里调
 * `hasPointerCapture` / `setPointerCapture`，在 jsdom 里这两个方法不存在，
 * 缺失时组件直接抛 `TypeError`（不是断言失败，是渲染期崩）。
 * 只补「浏览器有、jsdom 没有」的那部分：捕获本身没有可观察语义，留空实现即可。
 */
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});
