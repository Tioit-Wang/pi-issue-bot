/**
 * TanStack Query 封装：**轮询间隔只在这里定义**（tech-plan §9.4）。
 *
 * - 总览 10s、列表 15s、详情 5s（详情页可能正在跑，要更勤）；
 * - 用轮询而不是 SSE：规模小，SSE 的复杂度不值当；接口层将来要推再换（契约预留 `/api/stream`）。
 *
 * 约定：所有 hooks 的 `queryKey` 都包含**筛选参数**，这样切筛选不会复用旧数据；
 * `taskDetail` 的 404 在 hook 里被规约成 `null`（`/api/tasks/:id` 的 404 是正常业务态，
 * 不是错误——上层面板显示「任务不存在」即可）。
 */
import { QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './api.ts';
import type {
  AuditQuery,
  CostsQuery,
  IssueSessionParams,
  IssuesQuery,
  OverviewQuery,
  QualityQuery,
  TasksQuery,
} from './contract.ts';
/*
 * 技能的 DTO 直接取自契约本体：`lib/contract.ts` 还没有再导出技能这一组，而本次改动不允许碰它
 * （原因与相对路径的取舍见 `lib/api.ts` 顶部同一段说明）。
 */
import type {
  SkillDetail,
  SkillFileWrite,
  SkillImportResponse,
  SkillPatch,
  SkillScope,
  SkillsQuery,
  SkillUploadResponse,
} from '../../../../packages/contract/src/index.ts';

/** 轮询间隔（毫秒）：总览 / 列表 / 详情。 */
export const REFETCH_INTERVAL = {
  overview: 10_000,
  list: 15_000,
  detail: 5_000,
} as const;

export const queryKeys = {
  overview: (query: OverviewQuery) => ['overview', query] as const,
  tasks: (query: TasksQuery) => ['tasks', query] as const,
  taskDetail: (id: string) => ['taskDetail', id] as const,
  costs: (query: CostsQuery) => ['costs', query] as const,
  reverts: (query: QualityQuery) => ['reverts', query] as const,
  audit: (query: AuditQuery) => ['audit', query] as const,
  issues: (query: IssuesQuery) => ['issues', query] as const,
  issueSession: (params: IssueSessionParams) => ['issueSession', params] as const,
  /**
   * 仓库配置（只读消费）：流水线页要读 `settings.pipeline.*_prompt_version` 的四个指针。
   * 与设置页自己的草稿 key（`settings-draft`）分开：那个是可编辑草稿，这里是只读快照。
   */
  repoSettings: (repo: string) => ['repoSettings', repo] as const,
  system: () => ['system'] as const,
  /*
   * 技能页的三个 key 都以 `'skills'` 开头：写操作后一句
   * `invalidateQueries({ queryKey: ['skills'] })` 就把列表/详情/版本全部失效。
   */
  skills: (query: SkillsQuery) => ['skills', 'list', query] as const,
  skillDetail: (id: string) => ['skills', 'detail', id] as const,
  skillVersions: (id: string) => ['skills', 'versions', id] as const,
  /** 技能目录里每个文件的全文（模态框编辑器用；写后随 `'skills'` 前缀一起失效）。 */
  skillFiles: (id: string) => ['skills', 'files', id] as const,
};

/** 面板的 QueryClient 默认值：失败只重试一次（内网接口，重试多了只会拖慢首屏）。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 0,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function useOverview(query: OverviewQuery = {}) {
  return useQuery({
    queryKey: queryKeys.overview(query),
    queryFn: () => api.overview(query),
    refetchInterval: REFETCH_INTERVAL.overview,
  });
}

export function useTasks(query: TasksQuery) {
  return useQuery({
    queryKey: queryKeys.tasks(query),
    queryFn: () => api.tasks(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useTaskDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.taskDetail(id),
    queryFn: async () => {
      try {
        return await api.taskDetail(id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: REFETCH_INTERVAL.detail,
  });
}

export function useCosts(query: CostsQuery) {
  return useQuery({
    queryKey: queryKeys.costs(query),
    queryFn: () => api.costs(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useReverts(query: QualityQuery = {}) {
  return useQuery({
    queryKey: queryKeys.reverts(query),
    queryFn: () => api.reverts(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useAudit(query: AuditQuery = {}) {
  return useQuery({
    queryKey: queryKeys.audit(query),
    queryFn: () => api.audit(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

export function useSystem() {
  return useQuery({
    queryKey: queryKeys.system(),
    queryFn: () => api.system(),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/**
 * issue 列表（spec §3.1）：契约是**游标分页**（`cursor` 不透明 + `hasMore`/`nextCursor`），
 * 所以这里给 `useInfiniteQuery`，页面只负责「加载更多」。
 *
 * `queryKey` 带 `'pages'` 后缀：无限查询的缓存形状是 `{pages, pageParams}`，
 * 不能和单次快照的扁平响应共用 key（与 `/tasks` 列表同一约定）。
 */
export function useIssuesInfinite(query: IssuesQuery) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.issues(query), 'pages'] as const,
    queryFn: ({ pageParam }) =>
      api.issues({ ...query, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor !== null ? lastPage.nextCursor : undefined,
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/**
 * 一个 issue = 一个 session（spec §3.2），每 5s 轮询（详情可能正在跑）。
 *
 * 404 规约成 `null`：`(repo,kind,number)` 没有任何 `tasks` 行是**正常业务态**
 * （「这个 issue 我们从没处理过」），页面显示空态而不是错误态。
 */
export function useIssueSession(params: IssueSessionParams) {
  return useQuery({
    queryKey: queryKeys.issueSession(params),
    queryFn: async () => {
      try {
        return await api.issueSession(params);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: REFETCH_INTERVAL.detail,
  });
}
/**
 * 任务详情的**按需**版本：`id === null` 时不发请求（`enabled: false`），404 仍规约成 `null`。
 *
 * 用在「只有拿到最近一轮任务才知道能不能展示证据」的地方（issue 详情的分类结论）：
 * 无条件 `useTaskDetail('')` 会朝 `/api/tasks/` 打一个必然 404 的请求，不如不发。
 */
export function useTaskDetailIf(id: string | null) {
  return useQuery({
    queryKey: queryKeys.taskDetail(id ?? ''),
    queryFn: async () => {
      if (id === null) return null;
      try {
        return await api.taskDetail(id);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: id !== null,
    refetchInterval: REFETCH_INTERVAL.detail,
  });
}


/**
 * 仓库配置的**只读**快照（流水线页用）。
 *
 * 为什么不复用 `useSettingsDraft`（`components/settings/use-settings-draft.ts`）：那是表单草稿层
 * （本地编辑 + 脏标记 + 保存），流水线页只需要「四个提示词指针现在指向哪一版」，不应该把
 * 一个可写草稿挂到一个纯读页面上。轮询间隔沿用列表档（15s）。
 */
export function useRepoSettings(repo: string) {
  return useQuery({
    queryKey: queryKeys.repoSettings(repo),
    queryFn: () => api.repoSettings(repo),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/* ── 技能管理（spec §6） ───────────────────────────────────────────────────── */

/** 技能列表（筛选在服务端做，所以筛选参数进 `queryKey`）。 */
export function useSkills(query: SkillsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.skills(query),
    queryFn: () => api.skills(query),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/** 技能详情（frontmatter + 正文 + 文件清单 + 校验结果）：只在展开某一行时才挂载。 */
export function useSkillDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.skillDetail(id),
    queryFn: () => api.skillDetail(id),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/** 版本列表（标出当前版本）；上传/编辑后与详情一起失效。 */
export function useSkillVersions(id: string) {
  return useQuery({
    queryKey: queryKeys.skillVersions(id),
    queryFn: () => api.skillVersions(id),
    refetchInterval: REFETCH_INTERVAL.list,
  });
}

/**
 * 技能目录里每个文本文件的全文（模态框左树右编辑器）。
 *
 * **不轮询**：内容可能正被用户编辑，5s 一次的后台刷新只会制造「回填覆盖草稿」的错觉；
 * 写入成功后由 `useInvalidateSkills` 统一失效，那一次刷新足够。
 */
export function useSkillFiles(id: string) {
  return useQuery({
    queryKey: queryKeys.skillFiles(id),
    queryFn: () => api.skillFiles(id),
    refetchInterval: false,
  });
}

/** 写操作后的统一失效（列表/详情/版本都在 `'skills'` 前缀下）。 */
function useInvalidateSkills(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['skills'] });
}

/**
 * 启停 / 改描述（`PATCH /api/skills/:id`）。
 *
 * 不做乐观更新：服务端是唯一事实源（`enabled` 还可能被覆盖关系影响），
 * 失败时列表保持原样，由页面把错误贴出来。
 */
export function useSkillPatch() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: { id: string; patch: SkillPatch }) => api.patchSkill(vars.id, vars.patch),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * 上传 zip（原始二进制，上传即生效）：成功后列表立刻刷新。
 *
 * 作用域由调用方给（缺省 `global`）：项目技能页必须传 `{ scope: 'repo', repo }`，
 * 否则技能会挂到全局、在所有项目里生效。
 */
export function useSkillUpload() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: { file: Blob; scope?: SkillScope; repo?: string }) =>
      api.uploadSkill(vars.file, {
        scope: vars.scope ?? 'global',
        ...(vars.repo === undefined ? {} : { repo: vars.repo }),
      }),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * 整份 SKILL.md 覆盖保存（`PUT /api/skills/:id { text }`）：成功即产生新版本。
 *
 * 与 `useSkillPatch` 的分工：`patch` 改的是「列表行上的开关 / 描述 / 正文」这种局部字段；
 * 这里改的是**完整文件**（frontmatter + 正文），校验与版本由服务端负责。
 * 同样不做乐观更新 —— 服务端会改写 `currentVersion`，猜错就得回滚两次。
 */
export function useSkillSaveText() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: { id: string; text: string }): Promise<SkillDetail> =>
      api.saveSkillText(vars.id, vars.text),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * 保存**一个文件**（`PUT /api/skills/:id/files { path, text }`）：成功即新版本。
 *
 * 与 `useSkillSaveText` 的区别：那条只能整份覆盖 `SKILL.md`，这条能改 `references/x.md`
 * 之类的附件。400 的 `message` 是给人看的中文，页面直接显示，不要替换成通用文案。
 */
export function useSkillSaveFile() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: { id: string; write: SkillFileWrite }): Promise<SkillDetail> =>
      api.saveSkillFile(vars.id, vars.write),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * 用 zip 覆盖**这一个**技能（`POST /api/skills/:id/versions`）：成功即新版本。
 *
 * 名字是否一致由服务端判定（不一致 400），面板不预判 —— 猜错的代价是「弹窗说能覆盖、服务端拒绝」。
 */
export function useSkillOverwrite() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: { id: string; file: Blob }): Promise<SkillUploadResponse> =>
      api.overwriteSkillByZip(vars.id, vars.file),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * 一个 zip 里多个技能目录的批量导入（`POST /api/skills/import`）。
 *
 * 作用域由调用方给：项目技能页必须传 `{ scope: 'repo', repo }`，否则技能会挂到全局。
 * 成功（含部分成功）后统一失效，列表与详情一起刷新。
 */
export function useSkillImport() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (vars: {
      file: Blob;
      scope?: SkillScope;
      repo?: string;
      enabled?: boolean;
    }): Promise<SkillImportResponse> =>
      api.importSkills(vars.file, {
        scope: vars.scope ?? 'global',
        ...(vars.repo === undefined ? {} : { repo: vars.repo }),
        ...(vars.enabled === undefined ? {} : { enabled: vars.enabled }),
      }),
    onSuccess: () => {
      void invalidate();
    },
  });
}

/** 软删（`DELETE /api/skills/:id`）：成功即从列表消失。 */
export function useSkillDelete() {
  const invalidate = useInvalidateSkills();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      void invalidate();
    },
  });
}
