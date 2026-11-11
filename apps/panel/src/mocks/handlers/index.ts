import type { HttpHandler } from 'msw';
import { auditHandlers } from './audit.ts';
import { costsHandlers } from './costs.ts';
import { issueSessionHandlers, issuesHandlers } from './issues.ts';
import { overviewHandlers } from './overview.ts';
import { qualityHandlers } from './quality.ts';
import { promptHandlers } from './prompt.ts';
import { reposHandlers } from './repos.ts';
import { skillsHandlers } from './skills.ts';
import { systemHandlers } from './system.ts';
import { taskDetailHandlers } from './task-detail.ts';
import { tasksHandlers } from './tasks.ts';

/**
 * 全部拦截器（**每页一个文件**，互不干扰：W3 的两个 session 各改自己那几页的 handler）。
 *
 * 注意顺序：`/api/tasks/:id` 必须在 `/api/tasks` 之前吗？——不需要，
 * MSW 按注册顺序匹配**完整路径**，`/api/tasks` 不会匹配 `/api/tasks/abc`。
 * 但 `task-detail` 放前面更安全（万一将来加了通配），这里就按「具体 → 宽泛」排。
 * `/api/issues/:owner/:name/:kind/:number` 与 `/api/issues` 同理（四段在前）。
 * 技能页的四段/三段路径（`/api/skills/:id/versions`）同理，`skillsHandlers` 内部已按具体在前排好。
 */
export function createHandlers(): HttpHandler[] {
  return [
    ...issueSessionHandlers,
    ...issuesHandlers,
    ...taskDetailHandlers,
    ...tasksHandlers,
    ...overviewHandlers,
    ...costsHandlers,
    ...qualityHandlers,
    ...auditHandlers,
    ...skillsHandlers,
    // 仓库写面（`/api/repos`、`/api/repos/:owner/:name/settings`）：四段路径已按具体在前排好
    ...reposHandlers,
    // 提示词（`/api/repos/:owner/:name/prompt[/versions|/rollback|/restore]?kind=…`）：
    // 一条路径四份 fixture（`?kind=`），所以单独一个文件；`prompt/versions` 等长路径在该文件内部在前
    ...promptHandlers,
    ...systemHandlers,
  ];
}
