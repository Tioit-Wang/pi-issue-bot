/**
 * 面板的 API 客户端：**一个文件**。读接口全是 GET（tech-plan §8.3），
 * 写接口只有技能管理那几个（`docs/spec/skill-management.md` §6）。
 *
 * 关于 openapi-fetch：原本按 E8 的方案是 `createClient<paths>()` + `openapi-typescript` 产物。
 * 现状是 `openapi/pi-bot.openapi.json` 的响应体是自指 `$ref`（生成会抛
 * `Self-referencing circular pointer`，见 `lib/contract.ts` 的说明），所以这里用
 * **同一份契约类型 + 原生 fetch**：类型来源不变，只换传输实现。等 spec 修好后，
 * 只需本文件换成 openapi-fetch 的 3 行调用（页面与 hooks 的签名都不用动）。
 *
 * 约定：
 * - 查询参数只带**有值**的（`undefined` / 空串不拼进 URL，否则后端 zod 会当成显式空值）；
 * - 4xx/5xx 一律抛 `ApiError`（带 status 与 `error.code`），由 hooks 决定展示或降级；
 * - CSV 导出返回 URL 字符串，交给 `<a download>` 或 `window.open`（W3-K 用）；
 * - **写请求**一律走 `write()`：带自定义头 `X-Pi-Bot-CSRF: 1` + `credentials: same-origin`
 *   （spec R11 的双保险，缺了服务端直接 403），`204` / 空体不解析 JSON。
 */
import type {
  ApiErrorBody,
  AuditQuery,
  AuditResponse,
  CostsQuery,
  CostsResponse,
  IssueSessionParams,
  IssueSessionResponse,
  IssuesQuery,
  IssuesResponse,
  OverviewQuery,
  OverviewResponse,
  QualityQuery,
  RepoSettingsResponse,
  ReposResponse,
  RevertsResponse,
  SaveRepoSettingsRequest,
  SystemQuery,
  SystemResponse,
  TaskDetailResponse,
  TasksQuery,
  TasksResponse,
} from './contract.ts';

/*
 * 技能管理的 DTO 直接取自契约本体（`skills.ts` 的下半段）。
 *
 * 为什么不走 `./contract.ts`：那个文件是面板侧契约的**唯一**入口，但它目前还没有再导出
 * 技能这一组（`skillListItemSchema` / `skillDetailSchema` / …），而本次改动不允许碰它
 * （另一个 subagent 正在动 `packages/contract`）。等它补上再改回一行即可。
 *
 * 为什么用相对路径而不是 `@pi-issue-bot/contract`：面板**没有**把契约包声明成依赖，
 * pnpm 没有建链接，包名解析不到（`lib/contract.ts` 用的也是这条相对路径）。
 */
import type {
  SkillDetail,
  SkillFileWrite,
  SkillFilesResponse,
  SkillImportResponse,
  SkillPatch,
  SkillsQuery,
  SkillsResponse,
  SkillUploadResponse,
  SkillVersionsResponse,
} from '../../../../packages/contract/src/index.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type QueryValues = Record<string, string | number | boolean | undefined>;

/** 只拼有值的参数：`{ repo: undefined, limit: 50 }` → `?limit=50`。 */
export function toSearch(query: QueryValues | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** 4xx/5xx：把契约错误体翻成 `ApiError`（非 JSON 错误体用状态码兜底）。 */
async function failWith(response: Response): Promise<never> {
  // 错误体也可能不是 JSON（网关 502 之类），此时退化成状态码文案
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // 非 JSON 错误体（网关 502 等）：body 保持 null，用状态码兜底
  }
  throw new ApiError(
    response.status,
    body?.error?.code ?? 'internal',
    body?.error?.message ?? `请求失败（HTTP ${String(response.status)}）`,
    body?.error?.details,
  );
}

async function request<T>(path: string, query?: QueryValues): Promise<T> {
  const response = await fetch(`${path}${toSearch(query)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    // 面板会话是 cookie（`sid`），同站请求必须带上
    credentials: 'same-origin',
  });

  if (!response.ok) await failWith(response);

  return (await response.json()) as T;
}

/** 写请求必须带的自定义头（spec R11：缺了服务端回 403）。 */
export const CSRF_HEADER = 'X-Pi-Bot-CSRF';

type WriteInit = {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 原始二进制（上传 zip）或 JSON 字符串。 */
  body?: BodyInit;
  contentType?: string;
};

/**
 * 写请求：自动带 CSRF 头与 cookie；`204`/空体返回 `undefined`（DELETE 常见）。
 *
 * 面板侧写接口的**响应体契约尚未定稿**（spec §6 只写了方法/路径），所以调用方一律用
 * `void` 或只读 `skill`/`version` 这两个确定字段，不依赖完整响应形状。
 */
async function write<T>(path: string, init: WriteInit, query?: QueryValues): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', [CSRF_HEADER]: '1' };
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;

  const response = await fetch(`${path}${toSearch(query)}`, {
    method: init.method,
    headers,
    credentials: 'same-origin',
    ...(init.body === undefined ? {} : { body: init.body }),
  });

  if (!response.ok) await failWith(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** 仓库标识：`"owner/name"` 字符串，或已拆好的两段（路由里 `repo` 含 `/`，必须分两段编码）。 */
export type RepoRef = string | { owner: string; name: string };

function repoSegments(repo: RepoRef): { owner: string; name: string } {
  if (typeof repo === 'string') {
    const [owner = '', name = ''] = repo.split('/');
    return { owner, name };
  }
  return repo;
}

/** `/api/repos/:owner/:name`（写面与提示词共用；`repo` 含 `/`，`encodeURIComponent` 不能省）。 */
export function repoBasePath(repo: RepoRef): string {
  const { owner, name } = repoSegments(repo);
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export const api = {
  overview: (query: OverviewQuery = {}): Promise<OverviewResponse> =>
    request<OverviewResponse>('/api/overview', { ...query }),

  tasks: (query: TasksQuery): Promise<TasksResponse> => request<TasksResponse>('/api/tasks', { ...query }),

  taskDetail: (id: string): Promise<TaskDetailResponse> =>
    request<TaskDetailResponse>(`/api/tasks/${encodeURIComponent(id)}`),

  issues: (query: IssuesQuery): Promise<IssuesResponse> =>
    request<IssuesResponse>('/api/issues', { ...query }),

  /**
   * 一个 issue = 一个 session（spec §3.2）。
   * `repo` 含 `/` 会被路由吞掉，所以路径是四段 `:owner/:name/:kind/:number`。
   */
  issueSession: (params: IssueSessionParams): Promise<IssueSessionResponse> =>
    request<IssueSessionResponse>(
      `/api/issues/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.name)}/${params.kind}/${String(params.number)}`,
    ),

  costs: (query: CostsQuery): Promise<CostsResponse> => request<CostsResponse>('/api/costs', { ...query }),

  reverts: (query: QualityQuery): Promise<RevertsResponse> =>
    request<RevertsResponse>('/api/quality/reverts', { ...query }),

  audit: (query: AuditQuery): Promise<AuditResponse> => request<AuditResponse>('/api/audit', { ...query }),

  system: (query: SystemQuery = {}): Promise<SystemResponse> =>
    request<SystemResponse>('/api/system', { ...query }),

  /* ── 仓库写面（`/api/repos/*`；契约见 `packages/contract/src/api.ts` §7b） ──────
   * `repo` 含 `/`，路径一律拆成 `:owner/:name` 两段（`repoBasePath`）。
   */

  /** 全部仓库 + 状态（面板切换器 / 系统页 / 健康卡）。 */
  repos: (): Promise<ReposResponse> => request<ReposResponse>('/api/repos'),

  /** 单个仓库的配置视图（`settingsValid=false` 时 `settings` 为 `null`）。 */
  repoSettings: (repo: RepoRef): Promise<RepoSettingsResponse> =>
    request<RepoSettingsResponse>(`${repoBasePath(repo)}/settings`),

  /** 保存配置（body 就是 settings 本身；校验失败服务端一个字都不写 → 400 + `details.issues`）。 */
  saveRepoSettings: async (repo: RepoRef, settings: SaveRepoSettingsRequest): Promise<RepoSettingsResponse> =>
    write<RepoSettingsResponse>(`${repoBasePath(repo)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
      contentType: 'application/json',
    }),

  /** 手动添加仓库（其余用部署默认 settings seed，`source='manual'`）。 */
  addRepo: async (repo: string): Promise<RepoSettingsResponse> =>
    write<RepoSettingsResponse>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ repo }),
      contentType: 'application/json',
    }),


  /** 审计 CSV 的下载地址（`limit` 被服务端忽略，上限固定 50000）。 */
  auditCsvUrl: (query: AuditQuery = {}): string => `/api/audit/export.csv${toSearch({ ...query })}`,

  /* ── 技能管理（spec §6；写操作的鉴权见 R11） ─────────────────────────────── */

  skills: (query: SkillsQuery): Promise<SkillsResponse> =>
    request<SkillsResponse>('/api/skills', { ...query }),

  skillDetail: (id: string): Promise<SkillDetail> =>
    request<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`),

  skillVersions: (id: string): Promise<SkillVersionsResponse> =>
    request<SkillVersionsResponse>(`/api/skills/${encodeURIComponent(id)}/versions`),

  /**
   * 上传 zip：**原始二进制**（`application/zip`），不是 multipart（spec §6 的「不引入新依赖」）。
   * 技能只属于项目，所以 `repo` 必填（`?repo=owner/name&enabled=true`，上传即生效）。
   * 同一个项目里 `name` 再传 = 新版本。
   */
  uploadSkill: async (file: Blob, target: { repo: string }): Promise<SkillUploadResponse> => {
    const bytes = await file.arrayBuffer();
    return write<SkillUploadResponse>(
      '/api/skills',
      { method: 'POST', body: bytes, contentType: 'application/zip' },
      { repo: target.repo, enabled: 'true' },
    );
  },

  /**
   * 技能目录里**每个文本文件的内容**（`GET /api/skills/:id/files`）。
   *
   * 一次全拉而不是逐文件请求：技能包 ≤200 文件、单个 ≤5 MB，一次全量省事，
   * 也避开了「路径里的 `/` 怎么编码进 URL」这个问题（树在端上按 `/` 分段算）。
   */
  skillFiles: (id: string): Promise<SkillFilesResponse> =>
    request<SkillFilesResponse>(`/api/skills/${encodeURIComponent(id)}/files`),

  /**
   * 保存**一个文件**（`PUT /api/skills/:id/files`，body `{ path, text }`）→ 裸 `SkillDetail`。
   *
   * 成功 = 生成新版本（服务端重建整个技能包再走 `upload`，见 `docs/plan-skill-editor-modal.md`）。
   * 400 的 `message` 是**可直接展示的中文**（非法路径 / 非文本扩展名 / 改了技能名 / 校验不通过），
   * 所以调用方必须原样显示它，不要翻译成「保存失败」。
   */
  saveSkillFile: async (id: string, write_: SkillFileWrite): Promise<SkillDetail> =>
    write<SkillDetail>(`/api/skills/${encodeURIComponent(id)}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: write_.path, text: write_.text }),
      contentType: 'application/json',
    }),

  /**
   * 用 zip **覆盖这一个技能**（`POST /api/skills/:id/versions`，原始二进制）。
   *
   * 与 `uploadSkill` 的区别：那条按「同一项目内同名 = 新版本，否则新建」，这条**强制同名**
   * （名字不一致服务端直接 400，原文展示）—— 正是「在弹窗里覆盖当前技能」要的语义。
   */
  overwriteSkillByZip: async (id: string, file: Blob): Promise<SkillUploadResponse> => {
    const bytes = await file.arrayBuffer();
    return write<SkillUploadResponse>(`/api/skills/${encodeURIComponent(id)}/versions`, {
      method: 'POST',
      body: bytes,
      contentType: 'application/zip',
    });
  },

  /**
   * 一个 zip 里**多个技能目录**的批量导入（`POST /api/skills/import`，原始二进制）。
   *
   * 部分成功也是 200：`imported` 是要显示的成果，`errors` / `warnings` 要**逐条**显示
   * （只报条数等于让用户自己猜哪个目录被跳过了）。与单技能上传同一套查询参数：`repo` 必填。
   */
  importSkills: async (
    file: Blob,
    target: { repo: string; enabled?: boolean },
  ): Promise<SkillImportResponse> => {
    const bytes = await file.arrayBuffer();
    return write<SkillImportResponse>(
      '/api/skills/import',
      { method: 'POST', body: bytes, contentType: 'application/zip' },
      {
        repo: target.repo,
        enabled: target.enabled === false ? 'false' : 'true',
      },
    );
  },

  /**
   * 整份 SKILL.md 覆盖保存（`PUT /api/skills/:id`，body `{ text }`）。
   *
   * 响应按 `{ skill: SkillDetail }` 读（新增接口的形状）；万一服务端返回的是裸
   * `SkillDetail`（`GET /api/skills/:id` 就是裸的），这里也照收不误 —— 调用方只关心
   * 「拿到最新的那一份」。
   */
  saveSkillText: async (id: string, text: string): Promise<SkillDetail> => {
    const body = await write<SkillDetail | { skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(id)}`,
      { method: 'PUT', body: JSON.stringify({ text }), contentType: 'application/json' },
    );
    return isWrappedSkill(body) ? body.skill : body;
  },

  /** 局部更新（只允许 `enabled` / `description` / `body`；`name` / `repo` 不可改）。 */
  patchSkill: async (id: string, patch: SkillPatch): Promise<void> => {
    await write<unknown>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
      contentType: 'application/json',
    });
  },

  /** 软删（`?hard=1` 只对 `source='upload'` 有效，面板不提供硬删）。 */
  deleteSkill: async (id: string): Promise<void> => {
    await write<unknown>(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

/** 写接口把技能包一层（`{ skill }`），读接口是裸的 —— 两种响应都要能读。 */
function isWrappedSkill(body: SkillDetail | { skill: SkillDetail }): body is { skill: SkillDetail } {
  return typeof (body as { skill?: unknown }).skill === 'object' && (body as { skill?: unknown }).skill !== null;
}
