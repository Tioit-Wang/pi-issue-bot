import { http, type HttpHandler } from 'msw';
import { costsEmptyFixture, costsFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 成本（S4）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/costs`（`CostsResponse`）。
 */
export const costsHandlers: HttpHandler[] = [
  http.get('/api/costs', () => scenarioResponse({ data: costsFixture(), empty: costsEmptyFixture() })),
];
