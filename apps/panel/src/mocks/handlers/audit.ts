import { http, HttpResponse, type HttpHandler } from 'msw';
import { auditEmptyFixture, auditFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 审计（S6）的拦截器 —— **W3-K 只改这一个文件**。
 * 契约：`GET /api/audit`（`AuditResponse`）+ `GET /api/audit/export.csv`（CSV 文本）。
 */
export const auditHandlers: HttpHandler[] = [
  http.get('/api/audit', () => scenarioResponse({ data: auditFixture(), empty: auditEmptyFixture() })),
  http.get('/api/audit/export.csv', () => {
    // 导出只是文本：给两行能看出「BOM + 表头」的最小样本
    const csv = '\uFEFFid,at,repo,task_id,run_id,actor_login,actor_association,command\r\n1,2026-06-01T01:11:00Z,acme/widgets,t-mock-1,r-mock-1,alice,,/review-pr\r\n';
    return new HttpResponse(csv, {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"' },
    });
  }),
];
