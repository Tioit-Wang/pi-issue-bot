# 面板设计系统（D1）

> 给 D2 / D3 的页面组：**这是规范，不是建议**。页面只组合原语，不自造颜色、间距、动效。
> 令牌的唯一实现在 `src/index.css`；状态语义的唯一映射在 `src/components/ui/status.ts`。

## 0. 使命

内网自托管的 GitHub Issue 机器人控制台。用户来这里是回答三个问题：

1. **现在有没有事需要我处理？**（失败 / 超时 / 待人回答 / 配置坏了）
2. **某个 issue 被处理成什么样了？**（结论、打了什么标、为什么、成本、reaction）
3. **这个仓库配置对不对？**（触发词、标签词表、限额、提示词）

所以：**信息密度优先、扫描优先、状态优先**。不是报表门户，不做 hero，不做 KPI 墙。

## 1. 颜色令牌

三层，只有三层：中性底盘、**单一**品牌色、四档状态色。

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--background` | `oklch(0.985 0.002 250)` | `oklch(0.16 0.006 250)` | 页面底 |
| `--card` | `oklch(1 0 0)` | `oklch(0.2 0.008 250)` | 面（卡片、浮层、表格容器） |
| `--muted` | `oklch(0.965 0.003 250)` | `oklch(0.235 0.008 250)` | 次级面（hover、分段控件槽） |
| `--foreground` | `oklch(0.21 0.01 250)` | `oklch(0.95 0.004 250)` | 主文字 |
| `--muted-foreground` | `oklch(0.45 0.01 250)` | `oklch(0.72 0.008 250)` | 次级文字、说明 |
| `--faint-foreground`（类 `text-faint`） | `oklch(0.62 0.008 250)` | `oklch(0.58 0.008 250)` | 第三级：时间戳、计数、单位 |
| `--brand`（类 `bg-brand` / `text-brand`） | `oklch(0.55 0.16 262)` | `oklch(0.72 0.13 262)` | **只用于**当前选区 / 主操作 / 焦点环 |
| `--brand-soft` | `color-mix(brand 8%, card)` | `color-mix(brand 16%, card)` | 选中行 / 当前导航项底色 |
| `--border` | `color-mix(前景 8%, transparent)` | `color-mix(前景 12%, transparent)` | 所有 hairline 分隔 |
| `--border-strong` | `color-mix(前景 18%, transparent)` | `22%` | 输入框 hover、需要更明显的一根线 |
| `--input` | `color-mix(前景 16%, transparent)` | `18%` | 表单控件描边 |

### 状态四档（`status.ts` 是唯一映射处）

| tone | 令牌 | 语义（用在哪） |
| --- | --- | --- |
| `success` | `--success` / `-fg` / `-bg` | 成功、已应用、健康、启用 |
| `warn` | `--warn` / `-fg` / `-bg` | 降级、dry-run、待人回答、429 熔断 |
| `danger` | `--danger` / `-fg` / `-bg` | 失败、超时、配置非法 |
| `info` | `--info` / `-fg` / `-bg` | 进行中、中性信息（issue `open`） |
| `neutral` | `--neutral` / `-fg` / `-bg` | 排队、跳过、停用、归档 |

底色一律由 `color-mix(in oklab, var(--tone) 10~20%, var(--card))` 与面混出（8–12% 视觉浓度），
**不要**四套彩虹色，也不要给同一状态配两个颜色。

### 地图（页面用到的类名）

`bg-background` `bg-card` `bg-muted` `bg-brand-soft` `bg-success-bg`…
`text-foreground` `text-muted-foreground` `text-faint` `text-danger-fg`…
`border-border` `border-border-strong` `outline-brand`

## 2. 字体与层级

| 层级 | 字号 | 令牌/类 | 用途 |
| --- | --- | --- | --- |
| 微标签 | 10px | `text-2xs` + `.micro-label`（大写、字距 0.02em） | 分组标题、表头、单位 |
| 次级 | 11px | `text-xs` | 说明、徽章、时间戳 |
| 正文 | 13px | `text-sm`（也是 `body` 默认） | 表格、列表、表单 |
| 次级标题 | 15px | `text-base` | `Section` 标题、`CardTitle` |
| 页标题 | 20px | `text-lg` | `PageHeader` 的 `h1`（一页只有一个） |
| 空状态大标题 | 28px | `text-2xl` | 只有空状态允许 |

- 等宽：`font-mono` 给 id / hash / 路径 / 命令 / `owner/name`。
- 数字：`tabular`（`font-variant-numeric: tabular-nums`）用在表格、金额、计数、时间上。
- 字体栈：`--font-ui`（系统栈 + 中文回退）、`--font-code`。

## 3. 密度与间距

4px 网格；**行密度 32px（表头 / 列表行的最小高度）**。

| 单位 | 值 | 用法 |
| --- | --- | --- |
| 行高 | 32px（`h-8`）起 | 表格行、列表行、`md` 控件；行内有标题+徽章时可自然增高，不裁剪 |
| 控件 | 28 / 32 / 36px | `Button` 的 `sm` / `md` / `lg` |
| 分区间距 | 24px | `Section` 之间（`pt-4` + 上边线） |
| 块内间距 | 16px | 标题与内容之间用 8px，内容内部 16px |
| 紧凑间距 | 8px | 徽章组、行内动作 |

层级只用 **hairline**（`border-border`）表达；`--shadow-overlay` **只**给 dialog / sheet / popover / palette / toast。

## 4. 动效

| 令牌 | 值 |
| --- | --- |
| `--ease-out-quint` | `cubic-bezier(0.22, 1, 0.36, 1)` |
| `--dur-fast` | 120ms（hover / focus / 颜色） |
| `--dur-base` | 160ms（浮层入场、列表行淡入） |
| `--dur-slow` | 220ms（抽屉滑入） |

- 只过渡具体属性：`transition-[background-color,border-color,color]`，**禁止** `transition: all`。
- 入场：`animate-pop-in`（浮层）/ `animate-slide-in-right`（抽屉、toast）/ `stagger-row`（列表，最多 8 行）。
- 状态变化才给动效（加载、选中、展开）；装饰性动画不做。
- `prefers-reduced-motion: reduce` 下**全局**把时长归零（`index.css` 最后一节），组件不必各写一遍。

## 5. 组件清单（`src/components`）

| 组件 | 文件 | 用法要点 |
| --- | --- | --- |
| `Button` | `ui/button.tsx` | `primary` / `secondary` / `ghost` / `danger`；`sm|md|lg`；`loading` 不改宽度 |
| `Badge` / `StatusDot` | `ui/badge.tsx` | 只传 `tone`（或兼容旧 `variant`）；`dot` 带状态点 |
| `Alert` | `ui/alert.tsx` | 错误 / 降级横幅唯一出口；左缘 2px 色条 |
| `Dialog` / `Sheet` | `ui/dialog.tsx` | 模态：焦点陷阱 + Esc + 关闭后焦点归还 |
| `Popover` / `DropdownMenu` / `MenuItem` | `ui/popover.tsx`、`ui/dropdown-menu.tsx` | ↑↓ Home End + typeahead（焦点在输入框时不接管） |
| `Tooltip` | `ui/tooltip.tsx` | hover 与 focus 都显示，150ms 延迟，`role=tooltip` |
| `Segmented` | `ui/segmented.tsx` | 2–4 个互斥选项（off / mention / auto），`radiogroup` + 方向键 |
| `Field` | `ui/field.tsx` | label + hint + error，自动绑 `aria-describedby` / `aria-invalid` |
| `Table` | `ui/table.tsx` | 32px 行；`stickyFirst` 让首列横向吸顶 |
| `Tabs` | `ui/tabs.tsx` | 下划线式，不是胶囊 |
| `Select` | `ui/select.tsx` | 原生 `<select>`，32px 高 |
| `Toast` | `ui/toast.tsx` | `useToast().push({tone,title})`；右下、最多 3 条、`role=status` |
| `AsyncSection` | `AsyncSection.tsx` | 五态：加载（同形骨架）/ 错误（重试 + 折叠细节）/ 空（事实 + 动作）/ 离线 pill / 内容 |
| `PageHeader` | `PageHeader.tsx` | 面包屑 + `h1` + 说明 + 动作 + 更新时间 |
| `Section` | `Section.tsx` | 页面主体默认骨架：标题行 + 内容，hairline 分隔，**不套卡片** |
| `Toolbar` | `Toolbar.tsx` | 筛选 / 切换 / 导出都收在一行 |
| `CommandPalette` | `CommandPalette.tsx` | ⌘K / Ctrl+K / `/`；页面 + 仓库 + 最近 issue |

外壳：`layout/AppLayout.tsx`（顶栏 + 左栏 + 内容区 + 三个全局浮层）、`layout/Sidebar.tsx`、
`layout/RepoSwitcher.tsx`、`layout/ThemeToggle.tsx`、`layout/use-theme.ts`、`layout/use-viewport.ts`。

### 断点

| 宽度 | 侧栏 | 表格 |
| --- | --- | --- |
| ≥1280 | 常驻 224px | 正常 |
| 1024–1279 | 可折叠（顶栏按钮，`aria-expanded`） | 正常 |
| <1024 | 抽屉（遮罩；关闭时 `inert`） | 容器内横向滚动，`stickyFirst` 首列吸顶 |

## 6. 禁止事项

1. **卡片套卡片**。页面主体用 `Section`；`Card` 只给同级的几块内容（图表、表格容器）。
2. **KPI 墙**。不要 4 个等宽大数字卡；数字要跟口径、时间窗、对比基准在同一行。
3. **彩虹色**。只有 4 档状态色 + 中性 + 品牌；不许出现 `text-emerald-500`、`bg-amber-500/15` 这类自造色。
4. **`transition: all`**，以及 `0.3s ease` 这种没语义的时长/曲线。
5. **用阴影表达层级**。层级用 hairline 与留白；阴影只属于浮层。
6. 用溢出裁剪掩盖布局缺陷（`overflow-hidden` 藏错位）；网格/表格轨道要能容纳长内容（`min-w-0` + 省略号 + `title`）。
7. 在页面里内联 `fetch` / 自建轮询：取数走 `lib/queries.ts`（间隔只在那一处定义）。
8. 把 fixture 当真实数据展示：演示数据必须显式标注「演示数据」。

## 7. 键盘与可达性

- 全站唯一焦点环：`:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px }`。
- 顶栏第一个可 Tab 元素是「跳到主内容」跳过链接。
- `Sidebar` 当前项 `aria-current="page"`；`Segmented` / `Tabs` 用 roving tabindex；模态类浮层（Dialog / Sheet / CommandPalette）焦点不出面板，Esc 关闭后焦点归还来路。
- 状态不能只靠颜色：`StatusDot` 带 `aria-label`，列表里同时有文字徽章。

## 8. 文案规则（D3 收口）

**可见文案只承载：事实、后果、单位、错误、动作。**
标题已经说了的，版面（分组 / 列头 / 徽章 / 图标 + `title`）已经说了的，一个字都不要再说。

### 该删 / 该留

| 该删 | 该留（非显然信息） |
| --- | --- |
| `Section` 标题下那句「这块影响什么 / 这个页面展示…」 | 破坏性、不可逆的后果（删除、归档、干跑不写 GitHub） |
| 字段 hint 里重复校验规则（「3–39 个字符」）、「留空表示默认」（默认值已显示时） | 语义歧义处（同一字段两种解释、单位不同） |
| 列表 caption 里的整句解释（「只作用于已加载的 N 行」） | 口径 / 分母**必须**说明处 → 压成列头 `title` 或 `(i)` + `Tooltip`，不占正文行 |
| 卡片 / 行里的第二行描述（「该仓库暂无活动」这类重复空态的） | 空态一句话（事实 + 一个动作） |
| 重复说明键盘用法（全站只保留一处） | 禁用态原因 → 走 `title` / `aria-describedby`，不写在按钮下面 |
| 「这是…」「用于…」式的元描述 | 错误信息、单位、时间口径、权限与写动作提示 |

### 版面表达优先于句子

分组与顺序、列头、`Badge` / `StatusDot`、图标 + `Tooltip`、`Segmented`、数字对齐、留白。
删完如果信息不可达，用 `title` / `Tooltip` / `aria-describedby` 补，**不恢复整句**。

### 三个示例（删前 → 删后）

1. 分区标题下的元描述
   - 删前：`趋势` / 「按小时聚合（UTC）· 今日 12 个任务 · 成功率 92% · 今日成本 $1.23 · p50/p95 8s / 31s」
   - 删后：`趋势` / 「今日 12 个任务 · 成功率 92% · 成本 $1.23 · p50/p95 8s / 31s」
     （横轴自己说明了「按小时」，去重后只留数字与它的时间窗）

2. 列表 caption 里的口径整句
   - 删前：caption =「显示 3 / 已加载 40 行 · 按最后更新倒序 · 标签 / 搜索 / 时间窗只作用在已加载的行上（服务端没有对应参数）」
   - 删后：caption =「显示 3 / 已加载 40 行 · 按最后更新倒序」；口径改成工具条上的 `(i)` + Tooltip
     「标签 / 搜索 / 时间窗只筛选已加载的 40 行：服务端没有这些参数」

3. 禁用动作下面的说明句
   - 删前：按钮「重跑这一轮」`disabled`，下面一行「重跑需要排队进 run-task 并走仓库并发与闸门；写接口未就绪…」
   - 删后：同一句话进按钮的 `title` + 一个 `sr-only` 段落，按钮 `aria-describedby` 指过去 ——
     hover 有、读屏有、正文行没有

### 落点

- 空态：`AsyncSection` 的 `emptyText`（事实）+ 一个 `emptyAction`；`emptyHint` 只在「为什么空」确实不可推断时才有。
- 计数与分母：`Toolbar` 的 `meta` 或列头右侧，用 `tabular` 数字，不写句子。
- 原因与口径：`title` / `Tooltip` / `aria-describedby` / `footnote`（`Section` 的下方 2xs 一行）。
- 状态：`Badge` / `StatusDot` 带文字，颜色只是附加信息。
