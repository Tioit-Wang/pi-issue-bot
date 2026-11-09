import { http, HttpResponse, type HttpHandler } from 'msw';
import { taskDetailFixture } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 任务详情（S3）的拦截器 —— **W3-K 只改这一个文件**。
 * 契约：`GET /api/tasks/:id`（`TaskDetailResponse`）；不存在时 404 + `not-found`。
 */
export const taskDetailHandlers: HttpHandler[] = [
  http.get('/api/tasks/:id', ({ params }) => {
    const id = String(params['id']);
    // 任意 id 都返回同一份 fixture（mock 的目的是看四态，不是做数据管理）
    if (id === 'missing') {
      return HttpResponse.json(
        { error: { code: 'not-found', message: '任务不存在' } },
        { status: 404 },
      );
    }
    return scenarioResponse({ data: { ...taskDetailFixture(), task: { ...taskDetailFixture().task, id } } });
  }),
];
