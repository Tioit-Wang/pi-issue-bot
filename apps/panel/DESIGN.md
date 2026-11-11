# 面板设计系统（D1）

> 给 D2 / D3 的页面组：**这是规范，不是建议**。页面只组合原语，不自造颜色、间距、动效。
> 令牌的唯一实现在 `src/index.css`（取值与 `design-demo/_src/app.css` 同源）；
> 状态语义的唯一映射在 `src/components/ui/status.ts`。

## 0. 使命

内网自托管的 GitHub Issue 机器人控制台。用户来这里是回答三个问题：

1. **现在有没有事需要我处理？**（失败 / 超时 / 待人回答 / 配置坏了）
2. **某个 issue 被处理成什么样了？**（结论、打了什么标、为什么、成本、reaction）
3. **这个仓库配置对不对？**（触发词、标签词表、限额、提示词）

所以：**信息密度优先、扫描优先、状态优先**。不是报表门户，不做 hero，不做 KPI 墙。

## 1. 颜色令牌

方向：**中性底盘 + 单一青色强调 + 墨色主操作**。层级由 hairline 与留白承担，不靠放大字号、不靠投影。

- 底盘近白偏暖（hue 95）；文字四级统一 hue 264，级差自己承担层级。
- 强调只有一支青（hue 205）：**当前选区 / 焦点环 / 强调文字**。
- **主操作按钮是墨色实心**（`bg-primary`），不是品牌色 —— `bg-brand` 永远不做实心大块。

| 令牌 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--background` | `oklch(0.988 0.002 95)` | `oklch(0.168 0.008 264)` | 页面底 |
| `--card` | `oklch(1 0 0)` | `oklch(0.207 0.009 264)` | 面（卡片、浮层、表格容器） |
| `--muted` | `oklch(0.971 0.003 95)` | `oklch(0.243 0.01 264)` | 二级面（行 hover、分段控件槽、徽章底） |
| `--foreground` | `oklch(0.205 0.012 264)` | `oklch(0.955 0.004 264)` | 主文字 / 墨色 |
| `--muted-foreground` | `oklch(0.435 0.011 264)` | `oklch(0.745 0.008 264)` | 次级文字、说明 |
| `--faint-foreground`（类 `text-faint`） | `oklch(0.605 0.01 264)` | `oklch(0.6 0.008 264)` | 第三级：时间戳、计数、表头 |
| `--subtle-foreground`（类 `text-subtle`） | `oklch(0.72 0.008 264)` | `oklch(0.49 0.008 264)` | 第四级：占位符、禁用态、极弱标注 |
| `--brand`（类 `bg-brand` / `text-brand`） | `oklch(0.475 0.088 205)` | `oklch(0.79 0.098 195)` | **唯一强调色**：当前选区、焦点环、强调文字 |
| `--brand-soft` | `color-mix(brand 9%, card)` | `14%` | 选中行 / 当前导航项底色 |
| `--brand-line` | `color-mix(brand 34%, transparent)` | `40%` | 2px 左边条、下划线 |
| `--primary`（类 `bg-primary`） | `oklch(0.205 0.012 264)` | `oklch(0.955 0.004 264)` | **主操作按钮实底（墨色）** |
| `--primary-foreground` | `oklch(0.988 0.002 95)`（= 页面底） | `oklch(0.168 0.008 264)` | 主操作文字 |
| `--primary-hover` / `--primary-active` | `mix(primary 86% / 76%, brand)` | 同公式 | 主操作 hover / press |
| `--border` | `color-mix(ink 9%, transparent)` | `11%` | 所有 hairline 分隔 |
| `--input` | `color-mix(ink 15%, transparent)` | `18%` | 表单控件描边 |
| `--border-strong` | `color-mix(ink 24%, transparent)` | `28%` | 输入框 hover、需要更明显的一根线 |
| `--ring` | `= --brand` | `= --brand` | 焦点环（`outline: 2px`，offset 2） |

### 状态四档（`status.ts` 是唯一映射处）

色相固定：成功 155 / 警示 72 / 失败 27 / 信息 245。**只允许小面积**：状态点、徽章、2px 左边条、图表柱。
禁止整行染色、整卡染色、把状态色当区块背景。

| tone | `--tone`（浅 / 深） | `-fg`（浅 / 深） | `-bg` | 语义 |
| --- | --- | --- | --- | --- |
| `success` | `0.52 0.125 155` / `0.72 0.13 155` | `0.38 0.095 155` / `0.82 0.12 155` | `mix(success 10% / 16%, card)` | 成功、已应用、健康、启用 |
| `warn` | `0.66 0.135 72` / `0.79 0.13 78` | `0.46 0.1 62` / `0.86 0.11 82` | `15% / 16%` | 降级、dry-run、待人回答、429 熔断 |
| `danger` | `0.545 0.185 27` / `0.68 0.17 27` | `0.47 0.17 27` / `0.8 0.13 27` | `10% / 18%` | 失败、超时、配置非法 |
| `info` | `0.55 0.1 245` / `0.72 0.11 245` | `0.45 0.1 245` / `0.83 0.09 245` | `10% / 16%` | 进行中、中性信息（issue `open`） |
| `neutral` | `0.6 0.008 264` / 同 | `0.45 0.01 264` / `0.75 0.008 264` | `0.962 0.003 264` / `0.25 0.01 264` | 排队、跳过、停用、归档 |

底色一律由 `color-mix(in oklab, var(--tone) 10~18%, var(--card))` 与面混出，
**不要**四套彩虹色，也不要给同一状态配两个颜色。

### 地图（页面用到的类名）

`bg-background` `bg-card` `bg-muted` `bg-brand-soft` `bg-primary` `bg-success-bg`…
`text-foreground` `text-muted-foreground` `text-faint` `text-subtle` `text-primary-foreground` `text-danger-fg`…
`border-border` `border-border-strong` `border-input` `outline-ring`

## 2. 字体与层级

**五档，没有第六档；20px 以上的标题一行都不许有。**

| 层级 | 字号 | 令牌/类 | 用途 |
| --- | --- | --- | --- |
| 微标 | 9.5px | `text-2xs`（+ `.micro-label`：大写、字距 0.05em） | 表头、分组标题、单位 |
| 辅助 | 11px | `text-xs` | 说明、徽章、时间戳 |
| 区块标题 | 12.5px | `text-base` | `Section` 标题、`CardTitle`、dialog 标题 |
| 正文 | 13px | `text-sm`（也是 `body` 默认） | 表格、列表、表单、按钮 |
| 页面标题 | 16px | `text-lg` | `PageHeader` 的 `h1`（一页只有一个，15–17 之间） |
| 大数字 / 空状态 | 17px | `text-xl` / `text-2xl`（上限，仅兼容旧类名） | 指标数字、空状态标题 |

- 等宽：`font-mono` 给 id / hash / 路径 / 命令 / `owner/name`。
- 数字：`tabular`（`font-variant-numeric: tabular-nums`）用在表格、金额、计数、时间上。
- 字体栈：`--font-ui`（Inter 优先的系统栈 + 中文回退）、`--font-code`。
- 层级靠**粗细 + 颜色 + 留白**拉开，不靠加字号。

## 3. 密度、圆角与层级

4px 网格；**表格行 33px、控件 28–30px**，一屏尽可能多看一行。

| 单位 | 值 | 令牌 | 用法 |
| --- | --- | --- | --- |
| 表格行 | 33px | `--row-height` / `--spacing-row`（`h-[var(--row-height)]`） | `TableCell` |
| 表头 | 28px | `h-7` | `TableHead`（微标 + hairline 下边线，不填底色） |
| 控件 | 28 / 30 / 32px | `--control-sm/md/lg`（`h-[var(--control-md)]`） | `Button` 的 `sm` / `md` / `lg` |
| 列表行 | 34–54px | 内容决定高度，不裁剪 | 时间线、待办队列等非表格列表 |
| 分区间距 | 24px | `--gutter` | `Section` 之间（`pt-4` + 上边线） |
| 块内间距 | 16px | `--gutter-tight` | 标题与内容 8px，内容内部 16px |
| 紧凑间距 | 8px | `--gutter-hair` | 徽章组、行内动作 |
| 圆角 | 4 / 5 / 6 / 8 / 10 / 12px | `--radius-xs/sm/md/lg/xl/2xl` | 小色块 / 徽章 / 控件 / 表格容器·卡片 / dialog·popover·palette / 浮层上限 |

层级只用 **hairline**（`border-border`）表达；**页面元素没有阴影**。
`--shadow-overlay`（= `--shadow-float`）**只**给 dialog / sheet / popover / palette / toast。
`@theme` 已把 `shadow-2xs/xs` 归零、`shadow-sm/md` 降级成 1px 描边、`shadow-lg/xl/2xl` 指向浮层阴影——
所以页面里即使写了 `shadow-sm` 也不会出现投影。

## 4. 动效

| 令牌 | 值 |
| --- | --- |
| `--ease-out-quint`（别名 `--ease`） | `cubic-bezier(0.22, 1, 0.36, 1)` |
| `--dur-fast` | 120ms（hover / focus / 颜色） |
| `--dur-base` | 160ms（浮层入场、列表行淡入） |
| `--dur-slow` | 180ms（抽屉滑入） |

- 只过渡具体属性：`transition-[background-color,border-color,color,opacity,transform]`，
  **禁止**全属性过渡（`transition-property: all`）。
- 只动 背景色 / 边框色 / 颜色 / 透明度 / 位移（≤4px）；不动 `width`、`height`、`top`、`left`。
- 入场：`animate-pop-in`（浮层）/ `animate-slide-in-right`（抽屉、toast）/ `stagger-row`（列表，最多 8 行）。
- 状态变化才给动效（加载、选中、展开）；装饰性动画不做，不用匀速 linear 表达状态。
- `prefers-reduced-motion: reduce` 下**全局**把时长归零（`index.css` 最后一节），组件不必各写一遍。

## 5. 组件清单（`src/components`）

| 组件 | 文件 | 用法要点 |
| --- | --- | --- |
| `Button` | `ui/button.tsx` | `primary`（墨色实心）/ `secondary` / `ghost` / `danger`；`sm\|md\|lg` = 28/30/32px；`loading` 不改宽度 |
| `Badge` / `StatusDot` | `ui/badge.tsx` | 只传 `tone`（或兼容旧 `variant`）；低饱和底小徽章，`dot` 带状态点 |
| `Alert` | `ui/alert.tsx` | 错误 / 降级横幅唯一出口；左缘 2px 色条 |
| `Dialog` / `Sheet` | `ui/dialog.tsx` | 模态：焦点陷阱 + Esc + 关闭后焦点归还；阴影只在这里 |
| `Popover` / `DropdownMenu` / `MenuItem` | `ui/popover.tsx`、`ui/dropdown-menu.tsx` | ↑↓ Home End + typeahead（焦点在输入框时不接管） |
| `Tooltip` | `ui/tooltip.tsx` | hover 与 focus 都显示，150ms 延迟，`role=tooltip` |
| `Segmented` | `ui/segmented.tsx` | 2–4 个互斥选项（off / mention / auto），`radiogroup` + 方向键 |
| `Field` | `ui/field.tsx` | label + hint + error，自动绑 `aria-describedby` / `aria-invalid` |
| `Table` | `ui/table.tsx` | 单元格 33px、表头 28px 微标；hairline 分隔；`stickyFirst` 让首列横向吸顶 |
| `Tabs` | `ui/tabs.tsx` | 下划线式，不是胶囊 |
| `Select` | `ui/select.tsx` | 原生 `<select>`（高度仍为 32px，见改造须知） |
| `Toast` | `ui/toast.tsx` | `useToast().push({tone,title})`；右下、最多 3 条、`role=status` |
| `AsyncSection` | `AsyncSection.tsx` | 五态：加载（同形骨架）/ 错误（重试 + 折叠细节）/ 空（事实 + 动作）/ 离线 pill / 内容 |
| `PageHeader` | `PageHeader.tsx` | 面包屑 + `h1`（16px）+ 说明 + 动作 + 更新时间 |
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
| <1024 | 抽屉（遮罩；关闭时 `inert`；此时侧栏是浮层，可以用阴影） | 容器内横向滚动，`stickyFirst` 首列吸顶 |

## 6. 禁止事项

1. **卡片套卡片**。页面主体用 `Section`；`Card` 只给同级的几块内容（图表、表格容器）。
2. **KPI 墙**。不要 4 个等宽大数字卡；数字要跟口径、时间窗、对比基准在同一行。
3. **彩虹色 / 大面积色块**。只有 4 档状态色 + 中性 + 一支青；状态色只出现在圆点、徽章、
   2px 左边条、图表柱上，**不要**整行染色、整卡染色，也不要出现 `text-emerald-500`、`bg-amber-500/15`。
4. **品牌色当主按钮底色**。主操作是墨色 `bg-primary`；`bg-brand` 只留给选区、焦点环与强调文字。
5. **全属性过渡，以及 `0.3s ease` 这种没语义的时长/曲线**。
6. **用阴影表达层级**。层级用 hairline 与留白；阴影只属于浮层。
7. **20px 以上的标题**，以及用字号放大来制造层级。
8. 用溢出裁剪掩盖布局缺陷（`overflow-hidden` 藏错位）；网格/表格轨道要能容纳长内容（`min-w-0` + 省略号 + `title`）。
9. 在页面里内联 `fetch` / 自建轮询：取数走 `lib/queries.ts`（间隔只在那一处定义）。
10. 把 fixture 当真实数据展示：演示数据必须显式标注「演示数据」。

## 7. 键盘与可达性

- 全站唯一焦点环：`:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`（青色）。
  组件里的 `focus-visible:outline-ring` 与之等价，不要自造第二种焦点样式。
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
