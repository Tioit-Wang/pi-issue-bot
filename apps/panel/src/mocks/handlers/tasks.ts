import { http, type HttpHandler } from 'msw';
import { tasksEmptyFixture, tasksFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 任务列表（S2）的拦截器 —— **W3-K 只改这一个文件**。
 * 契约：`GET /api/tasks`（`TasksResponse`）。游标分页的第二页在 W3-K 里按 `request.url` 造。
 */
export const tasksHandlers: HttpHandler[] = [
  http.get('/api/tasks', () => scenarioResponse({ data: tasksFixture(), empty: tasksEmptyFixture() })),
];
