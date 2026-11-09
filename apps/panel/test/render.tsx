import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';

/**
 * 测试渲染器：`QueryClient`（不重试、不轮询）+ `MemoryRouter`。
 *
 * - `retry: false`：错误态要立刻可见，不能等重试把测试拖超时；
 * - `refetchInterval: false`：轮询在测试里只会制造「时序不确定」；
 * - 先把 `window.location` 设成目标路由：MSW 的场景开关（`?mock=`）读的是页面 URL。
 */
export function renderWithProviders(
  element: ReactElement,
  options: { route?: string; queryClient?: QueryClient } = {},
): ReturnType<typeof render> {
  const route = options.route ?? '/';
  window.history.replaceState({}, '', route);

  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false, refetchInterval: false, gcTime: 0 } },
    });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}
