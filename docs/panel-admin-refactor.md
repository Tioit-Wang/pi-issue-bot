# 面板重构契约：企业级 admin（Tailwind 4 + shadcn/ui）

本文是这次重构的**唯一约定**。三个开发面（外壳 / Issue 与运行 / 设置与技能）都按这里改，
不要各写一套。

## 1. 为什么改

原面板是「顶部一条栏 + 底部 dock + 系统模态框」的三层结构：项目级导航只有 Issue / 设置 / 技能
三项，全局只有一个「系统」入口，总览 / 成本 / 质量 / 审计 / 系统五个页面在路由表里不存在
（`AC-26` / `FR-7.1`）。

产品方决定改需求：面板改为**侧栏式企业级 admin** —— 左侧固定导航栏承载全局入口，
右侧内容区带面包屑与页面标题，信息密度交给表格与卡片。同时组件底座从「手写 16 个原语」
换成 `shadcn/ui` 官方产物（Radix 原语），视觉按官方默认值重置（接受密度下降）。
需求正文 `AC-26` / `FR-7.1` 已在同一次改动里改写，不要再按旧描述实现。

## 2. 已就位的基础设施（不要再动）

| 位置 | 内容 |
| --- | --- |
| `apps/panel/components.json` | shadcn 配置：`new-york` / `neutral` / CSS 变量 / 别名 `@/*` |
| `apps/panel/tsconfig.json` | `baseUrl` + `paths: { "@/*": ["./src/*"] }` |
| `apps/panel/vite.config.ts` | `resolve.alias`：`@` → `src` |
| `apps/panel/src/index.css` | 官方 v4 令牌 + 项目扩展（状态四档、文字第四级、左栏尺寸） |
| `apps/panel/src/components/ui/*` | 官方组件（37 个）；`shadcn add <组件>` 可继续加 |
| `apps/panel/src/components/ui/status-badge.tsx` | 项目层：`StatusBadge` / `StatusDot`（tone 语义） |
| `apps/panel/src/components/ui/status.ts` | tone 的唯一定义处（**不要**改） |
| `apps/panel/src/hooks/use-mobile.ts` | 官方 `useIsMobile`（侧栏折叠用） |

### 导入规则（硬要求）

仓库 tsconfig 是 `nodenext` + `verbatimModuleSyntax` + `allowImportingTsExtensions`，
**ESM 不补扩展名**。所以：

```ts
import { Button } from '@/components/ui/button.tsx';   // ✅ 带 .tsx
import { cn } from '@/lib/utils.ts';                    // ✅ 带 .ts
import { useIsMobile } from '@/hooks/use-mobile.ts';     // ✅ 带 .ts
import { Button } from '@/components/ui/button';         // ❌ TS2307
```

相对导入同理（`../lib/x.ts`）。新加的 shadcn 组件跑一次
`node <scratch>/patch-imports.mjs apps/panel/src` 或手工补扩展名。

## 3. 组件选型（不要手写新的原语）

| 需要 | 用 |
| --- | --- |
| 按钮 | `Button`（变体 `default` / `secondary` / `outline` / `ghost` / `destructive` / `link`；尺寸 `default` / `sm` / `xs` / `lg` / `icon` / `icon-sm`） |
| 状态 | `StatusBadge` / `StatusDot`（**不要**用 `Badge variant="success"`，官方没有这个变体） |
| 表单字段 | `Field` / `FieldGroup` / `FieldLabel` / `FieldDescription` / `FieldError` + `Input` / `Textarea` / `Select` / `Switch` / `Checkbox` |
| 列表 | `Table` 家族，或项目层 `components/tables/DataTable.tsx` |
| 空态 | `Empty`（`EmptyHeader` / `EmptyTitle` / `EmptyDescription` / `EmptyContent`） |
| 加载 | `Skeleton` / `Spinner` |
| 浮层 | `Dialog` / `Sheet` / `AlertDialog` / `Popover` / `DropdownMenu` / `Tooltip` / `HoverCard` |
| 导航 | `Sidebar` 家族 / `Breadcrumb` 家族 / `Tabs` / `Command` |
| 提示 | `sonner` 的 `toast()` + `<Toaster />`（`ui/sonner.tsx`）；`ui/toast.tsx` 是旧实现，用到的页面改掉后可直接删 |

**不要**修改 `components/ui/*.tsx` 里官方组件的变体表来迁就页面；需要新变体就在项目层
（`components/<域>/`）包一层，并把理由写进注释。

## 4. 外壳（侧栏式 admin）

```
┌───────────────┬─────────────────────────────────────────────┐
│ Sidebar       │ 面包屑 + 页面标题 + 页面级操作               │
│ (可折叠,      ├─────────────────────────────────────────────┤
│  可拖宽)      │                                             │
│ 项目切换      │ 内容区（唯一滚动容器）                       │
│ ── 项目导航   │                                             │
│ ── 全局入口   │                                             │
│ 底部：主题/用户│                                             │
└───────────────┴─────────────────────────────────────────────┘
```

- `SidebarProvider` 包在 `AppLayout` 最外层；`<Sidebar collapsible="icon">`。
- 分三组：**项目**（Issue / 设置 / 技能）、**证据**（运行列表）、**全局**（系统）；
  原来「总览 / 成本 / 质量 / 审计」被删掉的信息仍不进导航 —— 它们在状态带、会话流、
  系统面板里（`FR-7.2` 未变）。**新增**的只有「系统」从模态框变成页面：`/system`。
- 顶部状态带保留为内容区第一行（四个数字 + 降级 chip），不占侧栏。
- 移动端（`useIsMobile`）侧栏变 `Sheet`，由侧栏触发按钮打开。
- 主题切换、仓库切换器放侧栏底部/头部，不再占顶栏。

## 5. 视觉与密度

- 官方令牌：`bg-background` / `text-foreground` / `bg-card` / `border-border` / `text-muted-foreground` /
  `ring-ring`。**不要**写 `bg-white`、`text-gray-500`、`bg-slate-*`。
- 字号用 Tailwind 默认档（`text-xs` / `text-sm` / `text-base` / `text-lg`），
  微标才用 `text-2xs` + `micro-label`。
- 阴影用官方默认（`shadow-xs` / `shadow-sm` / `shadow-md`）；**不要**再假设 `shadow-*` 被降级成描边
  （那是上一版的做法，已经拿掉）。
- 圆角只用 `rounded-md` / `rounded-lg` / `rounded-xl`（官方从 `--radius` 派生）。
- 状态颜色只经 `StatusBadge` / `StatusDot` / `Alert`，不写 `text-emerald-500` 这类原生色。
- 动效停在 120–200ms，只动背景/边框/颜色/透明度和位移；`prefers-reduced-motion` 已全局归零。

## 6. 禁止

- 不要改 `apps/server/**`、`packages/**`、`migrations/**`：这是纯面板重构。
- 不要为了跑通类型把 `any` / `as any` / `@ts-ignore` 加回来。
- 不要把 `data-testid` 删掉（测试与实机验证都靠它）；可以加，不可以改名的减少。
- 不要在页面里重新定义 tone 颜色表（`ui/status.ts` 是唯一来源）。
- 不要引第三个 UI 库（mantine / antd / headlessui 之类）。

## 7. 完成标准

1. `pnpm --filter @pi-issue-bot/panel typecheck` 0 error。
2. `pnpm --filter @pi-issue-bot/panel test` 全绿（测试随实现一起改，断言仍是可观察事实）。
3. `pnpm lint` 通过（不许放宽 lint zone）。
4. 每处改动的注释说清「为什么」，不写「改了什么」。
