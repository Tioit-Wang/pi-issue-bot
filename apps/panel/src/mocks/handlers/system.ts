import { http, type HttpHandler } from 'msw';
import { systemEmptyFixture, systemFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 系统（S7）的拦截器 —— **四态的代表页**（W3-J 只改这一个文件）。
 * 契约：`GET /api/system`（`SystemResponse`）。
 */
export const systemHandlers: HttpHandler[] = [
  http.get('/api/system', () => scenarioResponse({ data: systemFixture(), empty: systemEmptyFixture() })),
];
