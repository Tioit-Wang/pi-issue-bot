import { useSearchParams } from 'react-router';
import { useRepoDirectory } from '../lib/repos.ts';
import { Select } from './ui/select.tsx';

/**
 * 「仓库」筛选下拉（`?repo=owner/name`）——统计页与 Issue 中心共用一个。
 *
 * 三条约束来自 `docs/plan-multi-repo.md` §9（项目 = 仓库，不引入 project 概念）：
 *
 *  1. **筛选进 URL**（`?repo=`）：刷新不丢、能贴给别人；用 `replace` 写，不往历史里塞垃圾条目；
 *  2. **只改 `repo` 这一个键**：其它参数（`?mock=error` 这类 mock/外部参数、审计页的
 *     `command`/`intent`）原样保留——页面之间共用查询串，谁也不许一把清空；
 *  3. **候选来源要说清楚**：默认 `useRepoDirectory()`（`/api/repos`，失败退回 `/api/system`）；
 *     调用方已经有清单时传 `options`（`/system` 自己就带着 `repos[]`），这样不会**多打一次**
 *     请求。当前选中值即使不在清单里也留着，否则下拉会「跳回全部」。
 *
 * 四态只在自己取清单时才有：加载中 / 清单为空 / 清单读不到 → 下拉禁用并把原因写在旁边，
 * 而不是给一个**看起来能点、其实没有选项**的死控件。
 */
export type RepoFilterProps = {
  /** 无障碍标签（默认「仓库筛选」；同页有多个筛选器时传更具体的名字）。 */
  label?: string;
  /** 空项文案（默认「全部仓库」；传 `null` 表示必须选一个）。 */
  placeholder?: string | null;
  /** 额外候选（页面已加载数据里出现过的仓库；清单接口还没上线时这是唯一来源）。 */
  extraRepos?: readonly string[];
  /** 直接给候选清单（给了就不再调 `/api/repos`）。 */
  options?: readonly string[];
  className?: string;
  testId?: string;
};

type SelectProps = RepoFilterProps & { current: string; onChange: (next: string) => void };

/** 纯展示：候选已经由调用方/目录给出，本组件只管「选中值 + 空项 + 无障碍」。 */
function RepoSelect({
  label = '仓库筛选',
  placeholder = '全部仓库',
  options,
  current,
  onChange,
  className,
  testId = 'repo-filter',
  disabled,
  hint,
}: SelectProps & { disabled?: boolean; hint?: string | null }) {
  const seen = new Set<string>(options ?? []);
  if (current !== '') seen.add(current);
  const items = [...seen].sort().map((repo) => ({ value: repo, label: repo }));

  return (
    <span className="flex items-center gap-1.5" data-testid={testId}>
      <Select
        aria-label={label}
        options={items}
        placeholder={placeholder}
        value={current}
        disabled={disabled === true}
        className={className}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint === null || hint === undefined ? null : <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </span>
  );
}

/** 自己取仓库清单的版本（`/api/repos` → 失败降级 `/api/system`）。 */
function DirectoryRepoSelect({ extraRepos = [], ...rest }: RepoFilterProps & { current: string; onChange: (next: string) => void }) {
  const directory = useRepoDirectory();
  const candidates = [...directory.repos.map((repo) => repo.repo), ...extraRepos];

  if (candidates.length === 0) {
    const hint = directory.isLoading
      ? '读仓库清单…'
      : directory.isEmpty
        ? '仓库清单为空（还没有仓库被接入）'
        : '仓库清单读不到，暂不能按仓库筛选';
    return <RepoSelect {...rest} options={[]} disabled hint={hint} />;
  }
  return <RepoSelect {...rest} options={candidates} />;
}

export function RepoFilterSelect(props: RepoFilterProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const current = searchParams.get('repo') ?? '';

  const onChange = (next: string): void => {
    const params = new URLSearchParams(searchParams);
    if (next === '') params.delete('repo');
    else params.set('repo', next);
    setSearchParams(params, { replace: true });
  };

  /*
   * 两个分支各是一个组件：`useRepoDirectory()` 只在**需要**时才挂载。
   * 挂在这里（条件调用 hook）会违反 hooks 规则，所以用组件而不是分支表达式。
   */
  if (props.options !== undefined) {
    return <RepoSelect {...props} current={current} onChange={onChange} />;
  }
  return <DirectoryRepoSelect {...props} current={current} onChange={onChange} />;
}