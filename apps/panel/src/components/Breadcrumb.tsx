import { Link } from 'react-router';
import { Fragment } from 'react';

/**
 * 面包屑（仓库维度页面用）：`全部项目 / acme/widgets / 运行`。
 *
 * 为什么放在内容区顶部而不是顶栏：顶栏是全局的（降级横幅、时区），面包屑属于页面本身，
 * 跟着页面滚动/刷新，位置稳定在 `h1` 上方一行。
 */
export type Crumb = {
  label: string;
  /** 不传即为当前页（不可点，`aria-current="page"`）。 */
  to?: string;
};

export function Breadcrumb({ items, testId }: { items: readonly Crumb[]; testId?: string }) {
  return (
    <nav aria-label="面包屑" data-testid={testId}>
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {items.map((item, index) => (
          <Fragment key={`${item.label}-${String(index)}`}>
            {index === 0 ? null : (
              <li aria-hidden className="text-muted-foreground/60">
                /
              </li>
            )}
            <li className="min-w-0">
              {item.to === undefined ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {item.label}
                </span>
              ) : (
                <Link
                  className="truncate underline-offset-2 transition-colors hover:text-foreground hover:underline"
                  to={item.to}
                >
                  {item.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
