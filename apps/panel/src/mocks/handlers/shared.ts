import { HttpResponse, delay } from 'msw';
import { readScenario } from '../scenario.ts';

/**
 * 四个场景的统一应答（**每页 handler 都用它，别各写一遍**）：
 *
 * | 场景 | 行为 |
 * |---|---|
 * | `default` | 200 + 该页 fixture |
 * | `empty` | 200 + 该页的「空」fixture（仓库/队列/记录全空） |
 * | `error` | 500 + 契约错误体（`{error:{code,message}}`） |
 * | `unauthorized` | 401 + 契约错误体（面板显示「重新登录」，不重试） |
 * | `slow` | 延迟 `slowMs`（默认 800ms）后返回 `default` |
 *
 * 场景在**请求时刻**读取页面 URL，所以同一个 worker 实例可以边切场景边看效果。
 */
export type ScenarioPayload = {
  data: unknown;
  /** `?mock=empty` 时返回的内容；不传就等于 `data`。 */
  empty?: unknown;
  slowMs?: number;
};

export async function scenarioResponse(payload: ScenarioPayload): Promise<Response> {
  const scenario = readScenario();

  if (scenario === 'unauthorized') {
    return HttpResponse.json(
      { error: { code: 'unauthorized', message: '面板会话已过期，请重新登录' } },
      { status: 401 },
    );
  }

  if (scenario === 'error') {
    return HttpResponse.json(
      { error: { code: 'internal', message: '读取数据库失败（mock 场景 error）' } },
      { status: 500 },
    );
  }

  if (scenario === 'slow') {
    await delay(payload.slowMs ?? 800);
  }

  const body = scenario === 'empty' && payload.empty !== undefined ? payload.empty : payload.data;
  return HttpResponse.json(body as Record<string, unknown>);
}
