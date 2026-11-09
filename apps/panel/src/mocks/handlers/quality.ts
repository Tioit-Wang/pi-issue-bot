import { http, type HttpHandler } from 'msw';
import { revertsEmptyFixture, revertsFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 质量（S5）的拦截器 —— **W3-J 只改这一个文件**。
 * 契约：`GET /api/quality/reverts`（`RevertsResponse`）。
 */
export const qualityHandlers: HttpHandler[] = [
  http.get('/api/quality/reverts', () =>
    scenarioResponse({ data: revertsFixture(), empty: revertsEmptyFixture() }),
  ),
];
