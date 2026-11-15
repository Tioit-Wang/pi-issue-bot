import { cn as mergeClassName } from 'cn';

/**
 * 类名合并。唯一的实现是 `cn` 包（shadcn 官方出的 `clsx + tailwind-merge` 替代品）。
 *
 * 为什么不再自己 `twMerge(clsx(...))`：`shadcn add` 生成的 36 个组件全部 `import { cn } from 'cn'`，
 * 项目层（页面、`components/<域>`）也走这里。两套合并实现意味着同一个类名组合在组件里和在页面里
 * 可能被消解成不同结果 —— 尤其是本项目扩展的工具类（`text-2xs`、`bg-brand-soft`、`text-faint`），
 * 它们只出现在后加载的那张合并表里。所以这里改成转出一层，保留既有导入路径，
 * 同时让全仓只有一份合并逻辑。
 */
export function cn(...inputs: Parameters<typeof mergeClassName>): string {
  return mergeClassName(...inputs);
}
