import { useParams } from 'react-router';
import { AsyncSection } from '../components/AsyncSection.tsx';
import { IssueConversation } from '../components/issues/IssueConversation.tsx';
import { toast } from 'sonner';
import type { IssueKind } from '../lib/contract.ts';
import { useIssueSession } from '../lib/queries.ts';
import { decodeRepo, repoIssuePath, repoRunPath, useRepoRoute } from '../lib/repo-route.ts';
import { NotFoundPage } from './not-found.tsx';

/**
 * Issue 会话（`/repos/:repo/issues/:kind/:number`；旧路径 `/issues/:owner/:name/...` 重定向到这里）。
 *
 * 这一页只回答一件事：**「这条 issue 现在卡在哪、会话长什么样」**。
 * 结构按需求 §5.7（`FR-7.3` / `Q-8` / `AC-27`）：
 *   标题行 → 收起的原文卡 → 收起的系统提示词 → 消息流 → 输入区。
 * 四块的顺序与画法**都在 `IssueConversation` 里**，这里只负责取数与四态。
 *
 * 刻意**去掉**的东西（已过时的产出视图）：结论正文、标签与理由、缺哪些信息、run 时间线表格、
 * reaction 台账、成本汇总卡片。它们要么与会话无关，要么在实现里已经不再写入；
 * 留着只会让人以为平台在维护两套口径。单次成本改成每轮脚注里的 token 与单价（`FR-7.2`）。
 */
export function IssueDetailPage() {
  const params = useParams();
  // 新路径 `/repos/:repo/issues/:kind/:number`（`:repo = owner__name`）；
  // 旧路径 `/issues/:owner/:name/:kind/:number` 只作为重定向入口（见 `routes/legacy.tsx`）。
  const repoParam = params['repo'] ?? '';
  const decoded = repoParam === '' ? null : decodeRepo(repoParam);
  const slash = decoded === null ? -1 : decoded.indexOf('/');
  const owner = decoded === null ? (params['owner'] ?? '') : decoded.slice(0, slash);
  const name = decoded === null ? (params['name'] ?? '') : decoded.slice(slash + 1);
  const kind: IssueKind = params['kind'] === 'pr' ? 'pr' : 'issue';
  const number = Number(params['number'] ?? '');

  if (owner === '' || name === '' || !Number.isInteger(number) || number <= 0) {
    return <NotFoundPage />;
  }

  return <IssueSession owner={owner} name={name} kind={kind} number={number} />;
}

function IssueSession({
  owner,
  name,
  kind,
  number,
}: {
  owner: string;
  name: string;
  kind: IssueKind;
  number: number;
}) {
  const { repo } = useRepoRoute();
  const { data, error, isLoading, refetch } = useIssueSession({ owner, name, kind, number });

  const missing = !isLoading && error === null && data === null;
  const turns = data?.turns ?? [];
  const isEmpty = missing || turns.length === 0;

  const copy = (): void => {
    const href = `${window.location.origin}${repoIssuePath(repo ?? `${owner}/${name}`, kind, number)}`;
    void navigator.clipboard
      .writeText(href)
      .then(() => {
        toast.success('链接已复制', { description: href });
      })
      .catch(() => {
        toast.error('复制失败', { description: '浏览器拒绝了剪贴板写入' });
      });
  };

  /* 任务证据链接：仓库上下文里是 `/repos/:repo/runs/:id`，否则走旧 `/tasks/:id` 重定向。 */
  const taskHref = (taskId: string): string =>
    repo === null ? `/tasks/${encodeURIComponent(taskId)}` : repoRunPath(repo, taskId);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <AsyncSection
        isLoading={isLoading}
        error={error}
        isEmpty={isEmpty}
        emptyText={
          missing
            ? '找不到这个会话：这个 issue 没有任何处理记录（或者链接里的仓库 / 编号拼错了）。'
            : '这个会话还没有任何轮次（任务可能刚入队）。'
        }
        onRetry={() => {
          void refetch();
        }}
        skeletonRows={5}
        testId="issue-detail"
      >
        {data === null || data === undefined ? null : (
          <IssueConversation data={data} taskHref={taskHref} onCopyLink={copy} />
        )}
      </AsyncSection>
    </div>
  );
}
