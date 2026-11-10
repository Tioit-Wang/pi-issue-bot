import { useEffect, useState } from 'react';

/**
 * 断点模式（三档），供外壳决定侧栏怎么摆：
 *
 * - `wide`   ≥1280：三栏可用，侧栏常驻；
 * - `medium` 1024–1279：侧栏可折叠（顶栏按钮开合）；
 * - `narrow` <1024：侧栏变抽屉（遮罩 + 点外部关闭）。
 *
 * 默认值刻意取 `wide`：媒体查询不可用（jsdom / 老环境）时，宁可把导航当成常驻，
 * 也不要让页面在测试或异常环境里"少一半东西"。
 */
export type ViewportMode = 'wide' | 'medium' | 'narrow';

function readMode(): ViewportMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide';
  if (window.matchMedia('(max-width: 1023.98px)').matches) return 'narrow';
  if (window.matchMedia('(max-width: 1279.98px)').matches) return 'medium';
  return 'wide';
}

export function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(readMode);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const narrow = window.matchMedia('(max-width: 1023.98px)');
    const medium = window.matchMedia('(max-width: 1279.98px)');
    const update = (): void => {
      setMode(readMode());
    };
    narrow.addEventListener('change', update);
    medium.addEventListener('change', update);
    update();
    return () => {
      narrow.removeEventListener('change', update);
      medium.removeEventListener('change', update);
    };
  }, []);

  return mode;
}