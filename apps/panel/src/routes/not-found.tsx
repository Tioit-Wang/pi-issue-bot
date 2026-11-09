import { Link } from 'react-router';
import { PageShell } from './PageShell.tsx';

/** 404：路由表之外的路径（`<Route path="*">`）。 */
export function NotFoundPage() {
  return (
    <PageShell title="页面不存在" description="链接可能过期了">
      <p className="text-sm text-muted-foreground">
        返回 <Link className="underline" to="/">总览</Link>。
      </p>
    </PageShell>
  );
}
