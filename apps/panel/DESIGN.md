# 面板设计系统（shadcn/ui 版）

> 给页面组：**这是规范，不是建议**。页面只组合组件，不自造颜色、间距、动效。
>
> 令牌的唯一实现处是 `src/index.css`；状态语义的唯一映射是 `src/components/ui/status.ts`；
> 组件的选型与分工见 `docs/panel-admin-refactor.md`。

## 0. 使命

内网自托管的 GitHub Issue 机器人控制台。用户来这里回答三个问题：

1. **现在有没有事需要我处理？**（失败 / 超时 / 待人回答 / 配置坏了）
2. **某个 issue 被处理成什么样了？**（结论、打了什么标、为什么、成本、reaction）
3. **这个仓库配置对不对？**（触发词、标签词表、限额、提示词）

所以：**信息密度优先、扫描优先、状态优先**。不做 hero，不做 KPI 墙，不做装饰性插图。

## 1. 底座：官方令牌，不再自己配色

这版面板**不再维护第四套色板**。颜色来自 `shadcn/ui` 官方 v4 主题
（`new-york` 风格 / `baseColor: neutral` / CSS 变量），项目只在官方语义之外补三组
官方没有的东西（见 §2）。三者的取值都在 `src/index.css`，页面里**只写语义类名**：

| 用途 | 类名 |
| --- | --- |
| 页面底 / 主文字 | `bg-background` / `text-foreground` |
| 面（卡片、表格容器、浮层） | `bg-card` / `bg-popover` |
| 二级面（表头、hover 底、槽） | `bg-muted` / `bg-accent` |
| 次级文字 / 更弱的文字 | `text-muted-foreground` / `text-faint` / `text-subtle` |
| 主操作（实心） | `bg-primary text-primary-foreground` |
| 破坏性 | `bg-destructive` |
| 分隔线 | `border-border` / `border-border-strong` |
| 焦点环 | `ring-ring` |

**禁止**：`bg-white` / `text-gray-500` / `bg-slate-900` / `text-emerald-500`
这类原生色板，以及页面里自定义 `style={{ color }}`。要新颜色先加到 `index.css` 的令牌层。

## 2. 项目扩展（官方没有、但本产品必需）

| 令牌 | 类名 | 语义 |
| --- | --- | --- |
| `--success` / `-fg` / `-bg` | `bg-success` / `text-success-fg` / `bg-success-bg` | 成功、已应用、健康、启用 |
| `--warn` / `-fg` / `-bg` | 同上（warn） | 降级、dry-run、待人回答、429 熔断 |
| `--danger` / `-fg` / `-bg` | 同上（danger） | 失败、超时、配置非法 |
| `--info` / `-fg` / `-bg` | 同上（info） | 进行中、中性信息 |
| `--neutral` / `-fg` / `-bg` | 同上（neutral） | 排队、跳过、停用、归档 |
| `--brand` / `--brand-soft` / `--brand-line` | `bg-brand` / `bg-brand-soft` / `border-brand` | **唯一强调色**：当前选区、焦点强调、选中行的 3px 左缘 |
| `--faint-foreground` | `text-faint` | 第三级文字：时间戳、计数、表头 |
| `--subtle-foreground` | `text-subtle` | 第四级文字：占位符、禁用态 |
| `--rail-width` / `-head-height` / `-row-height` | `w-rail` / `rail-head` / `rail-row` | 左栏三处共用：280px（窄屏 256）/ 32px 头 / 28px 行 |

状态色**只允许小面积**：状态点、徽章、2px 左边条、图表柱。禁止整行染色、整卡染色、
把状态色当区块背景。状态一律经 `StatusBadge` / `StatusDot`（`components/ui/status-badge.tsx`），
页面只传 `tone`。

## 3. 排版与密度

字号用 Tailwind 默认档，**不再有自定义五档**：

| 用途 | 类 |
| --- | --- |
| 页面标题 | `text-lg font-semibold tracking-tight` |
| 区块标题 | `text-sm font-medium` |
| 正文 / 表格 | `text-sm` |
| 辅助（时间、单位、说明） | `text-xs text-muted-foreground` |
| 微标（表头、分组标题、单位） | `text-2xs micro-label` |

数字列（时间戳、计数、金额、耗时）一律 `tabular`（等宽数字，列不跳动）。
id / hash / 路径 / 命令一律 `font-mono`。

## 4. 形状、阴影、动效

- 圆角只用官方阶梯：`rounded-md`（按钮 / 输入）、`rounded-lg`（卡片 / 表格容器）、
  `rounded-xl`（对话框 / 浮层）。改 `--radius` 一处，整条阶梯跟着变。
- 阴影用官方默认（`shadow-xs` / `shadow-sm` / `shadow-md` / `shadow-lg`）。
  **上一版「页面元素一律无阴影、shadow 降级成 1px 描边」的补丁已删除**；
  层级现在既有 hairline 也有阴影，按官方用法来。
- 动效 120–200ms，只动背景色 / 边框色 / 颜色 / 透明度 / 位移。`prefers-reduced-motion`
  已在 `index.css` 全局归零，页面不需要各写一份。
- 浮层开合动效来自 `tw-animate-css`（`animate-in` / `fade-in-0` / `slide-in-from-*`），
  由 shadcn 组件自带，页面不要手写 keyframes。

## 5. 组件分层（三层，别串）

1. **官方原语** `components/ui/*`：`shadcn add` 的产物，**不手改**它的变体表。
   需要新的外观，就在项目层包一层。当前 36 个：button / card / badge / alert / alert-dialog /
   input / textarea / label / select / switch / checkbox / radio-group / progress / slider×0 /
   table / tabs / dialog / sheet / dropdown-menu / popover / tooltip / skeleton / separator /
   scroll-area / breadcrumb / sidebar / command / sonner / field / empty / item / kbd /
   toggle / toggle-group / input-group / spinner / status-badge。
2. **项目层**（`components/<域>/`、`components/ui/status-badge.tsx`）：把官方原语组合成本产品的
   惯用法。`StatusBadge` / `StatusDot`、`FilterSelect`、`AsyncSection`、`Rail`、`PageHeader`、
   `settings/form.tsx` 的字段装配、`SkillPreview` 都在这一层。
3. **页面**（`routes/`）：只做布局与数据接线，不做样式创新。

判断标准：**同一个组合出现第二次，就下沉到项目层**；只出现一次就别抽。

## 6. 外壳

侧栏式 admin（`FR-7.1`）：

- 左：`Sidebar`（可折叠成图标栏，窄屏变抽屉）——头部仓库切换器，中间三组导航
  （项目 / 证据 / 全局），底部主题切换与折叠按钮。
- 右：状态带（四个数字 + 降级 chip）→ 面包屑（外壳统一渲染，页面不要再画）→ 页面 →
  内容区是唯一滚动容器。
- 快捷键：`⌘K` 命令面板、`⌘.` 系统页、`[` 折叠侧栏。

## 7. 无障碍与状态

- 键盘焦点统一 `ring-ring`（官方组件自带 `focus-visible:ring-[3px]`），别再写 `outline-2`。
- 每个异步区块必须四态齐全：加载（`Skeleton`）、空（`Empty`）、错误（`Alert` + 重试）、
  有数据。`AsyncSection` 已经封装，优先用它。
- 状态文字不能只有颜色：`StatusBadge` 带文字，`StatusDot` 的语义由旁边的文字或
  `aria-label` 承担。
- 表格行若整行可点，必须同时给键盘路径与可见焦点。

## 8. 不要做

- 不要为了好看加 `bg-gradient-*`、玻璃拟态、大圆角卡片堆叠。
- 不要在页面里判断 `dark:` 手写两套颜色 —— 令牌已经双通道。
- 不要把提示做成自造 toast：全站只有 `sonner` 一套。
- 不要把状态映射写第二份：`ui/status.ts` 是唯一来源。
