import { http, type HttpHandler } from 'msw';
import { overviewEmptyFixture, overviewFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 总览页（S1）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/overview`（`OverviewResponse`）。
 */
export const overviewHandlers: HttpHandler[] = [
  http.get('/api/overview', () => scenarioResponse({ data: overviewFixture(), empty: overviewEmptyFixture() })),
];
