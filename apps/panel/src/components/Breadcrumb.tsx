import { Link } from 'react-router';
import {
  Breadcrumb as BreadcrumbRoot,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './ui/breadcrumb.tsx';

/**
 * 面包屑（项目层封装）：`全部项目 / acme/widgets / 设置`。
 *
 * 为什么包一层而不是页面直接用 `ui/breadcrumb.tsx`：
 * 1. 段与段之间用 `Link`（react-router），官方原语只给 `<a>`；
 * 2. 最后一段自动是 `aria-current="page"` 的当前页（不可点），调用方不必判断；
 * 3. `nav` 的 `aria-label` 用中文「面包屑」，读屏用户听到的是界面语言。
 *
 * 位置由外壳统一渲染（`layout/AppLayout.tsx`）：一个视图里只允许有一条面包屑，
 * 页面自己再画一条就会出现两份「我在哪」，两份迟早不一致。
 */
export type Crumb = {
  label: string;
  /** 不传即为当前页（不可点，`aria-current="page"`）。 */
  to?: string;
};

export function Breadcrumb({ items, testId }: { items: readonly Crumb[]; testId?: string }) {
  return (
    <BreadcrumbRoot aria-label="面包屑" data-testid={testId}>
      <BreadcrumbList className="gap-1.5 text-xs sm:gap-1.5">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <BreadcrumbItem key={`${item.label}-${String(index)}`}>
              {index === 0 ? null : <BreadcrumbSeparator className="text-muted-foreground/60" />}
              {item.to === undefined || last ? (
                <BreadcrumbPage className="max-w-[24rem] truncate font-medium">{item.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link className="max-w-[16rem] truncate" to={item.to}>
                    {item.label}
                  </Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </BreadcrumbRoot>
  );
}
