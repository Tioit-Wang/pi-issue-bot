/**
 * `apps/panel` 的包入口。
 *
 * 面板是 SPA，真正的入口是 `src/main.tsx`（由 `index.html` 引用，自带 `QueryClient` 与 `BrowserRouter`）；
 * 这里导出不含任何副作用的路由表与轮询常量，供测试与将来的嵌入式用法复用。
 */
export { AppRoutes, NAV_ITEMS, PANEL_ROUTES } from './routes.tsx';
export { createQueryClient, REFETCH_INTERVAL } from './lib/queries.ts';
