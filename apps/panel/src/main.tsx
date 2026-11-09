import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import './index.css';
import { createQueryClient } from './lib/queries.ts';
import { startMocks } from './mocks/browser.ts';
import { AppRoutes } from './routes.tsx';

/**
 * 面板入口。
 *
 * `startMocks()` 只在 URL 带 `?mock=`（或 `VITE_MOCK=1`）时启动 MSW，
 * 平时一律打真实 `/api/*`（dev 下由 Vite 代理到 `127.0.0.1:3000`）。
 * 这样「四态预览」不需要改代码，也不会在正常开发时把真实请求拦掉。
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (container === null) throw new Error('找不到 #root 节点');

  await startMocks();

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
