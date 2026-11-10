import { http, HttpResponse, type HttpHandler } from 'msw';
import type {
  PromptResponse,
  RepoSettingsResponse,
  ReposResponse,
  SaveRepoSettingsRequest,
} from '../../lib/contract.ts';
import { MOCK_NOW } from '../fixtures.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 仓库写面（`/api/repos/*`）的拦截器 —— W3-H 新增，供仓库切换器 / 系统页 / 设置页（W3-I）用。
 *
 * 契约为准：`packages/contract/src/api.ts` §7b 的 `ReposResponse` / `RepoSettingsResponse` /
 * `SaveRepoSettingsRequest`。**三个样本刻意覆盖三种状态**：
 *
 * | 仓库 | 状态 | 面板要能看见的分支 |
 * |---|---|---|
 * | `acme/widgets` | 正常（`settingsValid: true`，dry-run 关） | 常规展示 |
 * | `acme/billing` | `settingsValid: false` + `settingsError` | 「配置无效」徽章 + `settings === null` |
 * | `other/lib` | `archivedAt` 非空（= `enabled: false`） | 「已归档」+ 只读提示 |
 *
 * 写操作（PUT settings）只改内存，刷新页面即回到样本；`?mock=error|empty|slow|unauthorized`
 * 沿用 `scenarioResponse` 的统一机制（读的是页面 URL，不是请求 URL）。
 */

/** `repoSettingsSchema.parse({})` 的默认值（面板只做展示/回写，不在这里发明默认值）。 */
const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  dry_run: true,
  triggers: {
    enabled: true,
    merge_defaults: true,
    remove: [],
    users: 'all',
    faces: {
      issue_opened: 'auto',
      issue_edited: 'auto',
      issue_reopened: 'auto',
      issue_comment: 'mention',
      issue_comment_edited: 'off',
      pr_review_comment: 'mention',
      pr_review_submitted: 'off',
      pr_opened: 'off',
      body_mention: 'off',
    },
  },
  labels: { vocabulary: [], map: {}, missing: 'warn', max_per_issue: 6 },
  create_issue: { enabled: false, daily_quota: 10, scenarios: ['pr-review'] },
  commands: {
    enabled: true,
    allowed: ['/review-pr', '/issue-triage', '/issue-repro'],
    author_associations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    allow_users: [],
    rate_limit_per_hour: 20,
  },
  skills: { repo_skills: true },
  limits: {
    max_comments_per_hour: 10,
    max_actions_per_run: 8,
    max_task_minutes: 20,
    concurrency_per_repo: 2,
    queue_wait_minutes: 10,
  },
  prompt: { enabled: true, current_version: 2 },
} satisfies NonNullable<RepoSettingsResponse['settings']>;

type RepoState = {
  summary: ReposResponse['items'][number];
  settings: RepoSettingsResponse['settings'];
};

/** 三个样本仓库（`archivedAt` 非空的那条 `enabled` 必须是 false——归档 = 不可用）。 */
function initialStates(): RepoState[] {
  return [
    {
      summary: {
        repo: 'acme/widgets',
        enabled: true,
        dryRun: false,
        settingsValid: true,
        settingsError: null,
        settingsUpdatedAt: '2026-06-01T11:00:00.000Z',
        source: 'installation',
        installationId: '12345678',
        archivedAt: null,
        updatedAt: '2026-06-01T11:00:00.000Z',
      },
      settings: { ...DEFAULT_SETTINGS, dry_run: false, prompt: { enabled: true, current_version: 2 } },
    },
    {
      summary: {
        repo: 'acme/billing',
        enabled: true,
        dryRun: true,
        settingsValid: false,
        // 非法配置的原文不进响应体（面板拿到的是 `settings: null` + 这一句原因）
        settingsError: 'labels.max_per_issue: 不能大于 20',
        settingsUpdatedAt: '2026-05-30T09:00:00.000Z',
        source: 'installation',
        installationId: '87654321',
        archivedAt: null,
        updatedAt: '2026-05-30T09:00:00.000Z',
      },
      settings: null,
    },
    {
      summary: {
        repo: 'other/lib',
        enabled: false,
        dryRun: true,
        settingsValid: true,
        settingsError: null,
        settingsUpdatedAt: null,
        source: 'manual',
        installationId: null,
        archivedAt: '2026-05-20T08:00:00.000Z',
        updatedAt: '2026-05-20T08:00:00.000Z',
      },
      settings: { ...DEFAULT_SETTINGS },
    },
  ];
}

/** 进程内的假仓库表（PUT 之后 GET 能读到最后一次写入，方便设置页做「保存 → 回显」）。 */
const states = new Map<string, RepoState>(initialStates().map((state) => [state.summary.repo, state]));

function repoOf(params: Record<string, string | readonly string[] | undefined>): string {
  return `${String(params['owner'])}/${String(params['name'])}`;
}

function settingsView(state: RepoState): RepoSettingsResponse {
  return {
    repo: state.summary.repo,
    enabled: state.summary.enabled,
    dryRun: state.summary.dryRun,
    settings: state.settings,
    settingsValid: state.summary.settingsValid,
    settingsError: state.summary.settingsError,
    source: state.summary.source,
    installationId: state.summary.installationId,
    archivedAt: state.summary.archivedAt,
  };
}

function listPayload(): ReposResponse {
  return { items: [...states.values()].map((state) => state.summary) };
}

function listEmpty(): ReposResponse {
  return { items: [] };
}

function settingsEmpty(): RepoSettingsResponse {
  return {
    repo: 'acme/widgets',
    enabled: false,
    dryRun: true,
    settings: null,
    settingsValid: false,
    settingsError: null,
    source: 'manual',
    installationId: null,
    archivedAt: null,
  };
}

/** 提示词（P1）的假数据：两版 + 预算预演 + 装配预览（形状见 `lib/contract.ts` 的 `PromptResponse`）。 */
function promptPayload(repo: string): PromptResponse {
  const body = [
    '## 项目约定',
    '',
    '- 提交信息用中文，类型前缀沿用 Conventional Commits。',
    '- 改到 `apps/server/src/queries/**` 必须同时改 `test/queries-*.test.ts`。',
    '- 别在评论里贴内部链接（内网地址一律不许出现在 GitHub 上）。',
  ].join('\n');
  const stats = {
    baseChars: 3_100,
    promptChars: 0,
    agentsChars: 2_400,
    skillChars: 1_200,
    totalChars: 6_700 + body.length,
    truncated: [] as string[],
  };
  return {
    repo,
    enabled: true,
    version: 2,
    present: true,
    body,
    versions: [
      { version: 2, note: '补一条「别贴内部链接」', createdAt: '2026-05-31T10:00:00.000Z', chars: body.length, current: true },
      { version: 1, note: '初版：提交信息与测试约定', createdAt: '2026-05-20T08:30:00.000Z', chars: 120, current: false },
    ],
    budget: {
      budgetChars: 12_000,
      p1Cap: 4_000,
      otherLayersChars: 6_700,
      available: 4_000,
      requested: body.length,
      ok: true,
      source: 'last-assembly',
      layers: { p0: 1_200, p1: 4_000, p2Root: 4_000, p2Nearby: 6_000, p3: 4_000, p4: 4_400 },
    },
    preview: {
      text: `# pi-issue-bot\n\n（固定基座省略）\n\n${body}\n`,
      stats,
      omitted: ['AGENTS.md（来自 worktree）', '任务技能（来自 registry）'],
      ref: null,
      sha: null,
    },
    lastAssembly: {
      baseChars: 3_100,
      promptChars: body.length,
      agentsChars: 2_400,
      skillChars: 1_200,
      totalChars: 6_700 + body.length,
      truncated: [],
    },
  };
}

/** 写操作要带的 CSRF 头（与真实服务端的约定一致：缺了 403）。 */
function requireCsrf(request: Request): Response | null {
  if (request.headers.get('X-Pi-Bot-CSRF') === '1') return null;
  return HttpResponse.json(
    { error: { code: 'forbidden', message: '缺少 X-Pi-Bot-CSRF 头（写接口需要它）' } },
    { status: 403 },
  );
}

export const reposHandlers: HttpHandler[] = [
  /** 提示词（三段以上的路径先注册，避免被 `/settings` 前缀规则抢先匹配）。 */
  http.get('/api/repos/:owner/:name/prompt', ({ params }) =>
    scenarioResponse({ data: promptPayload(repoOf(params)), slowMs: 500 }),
  ),

  http.put('/api/repos/:owner/:name/prompt', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const payload = (await request.json()) as { body?: string; note?: string };
    const data = promptPayload(repoOf(params));
    const nextBody = typeof payload.body === 'string' && payload.body !== '' ? payload.body : data.body;
    return HttpResponse.json({
      ...data,
      body: nextBody,
      versions: [
        { version: 3, note: payload.note ?? null, createdAt: MOCK_NOW, chars: nextBody.length, current: true },
        ...data.versions.map((version) => ({ ...version, current: false })),
      ],
      version: 3,
    } satisfies PromptResponse);
  }),

  http.post('/api/repos/:owner/:name/prompt/rollback', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const payload = (await request.json()) as { version?: number };
    const data = promptPayload(repoOf(params));
    const target = data.versions.find((version) => version.version === payload.version);
    return HttpResponse.json({
      ...data,
      body: target === undefined ? data.body : data.body,
      version: data.version,
    } satisfies PromptResponse);
  }),

  /** 单个仓库的 settings（读 / 写同一个形状）。 */
  http.get('/api/repos/:owner/:name/settings', ({ params }) => {
    const repo = repoOf(params);
    const state = states.get(repo);
    if (state === undefined) {
      return HttpResponse.json(
        { error: { code: 'not-found', message: `仓库不存在：${repo}（先用 POST /api/repos 添加）` } },
        { status: 404 },
      );
    }
    return scenarioResponse({ data: settingsView(state), empty: settingsEmpty(), slowMs: 500 });
  }),

  http.put('/api/repos/:owner/:name/settings', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const repo = repoOf(params);
    const state = states.get(repo);
    if (state === undefined) {
      return HttpResponse.json(
        { error: { code: 'not-found', message: `仓库不存在：${repo}` } },
        { status: 404 },
      );
    }
    const body = (await request.json()) as SaveRepoSettingsRequest;
    // mock 不做完整 zod 校验：只演示「写进去 → 读回来」这条路径
    const next: RepoState = {
      summary: {
        ...state.summary,
        enabled: body.enabled,
        dryRun: body.dry_run,
        settingsValid: true,
        settingsError: null,
        settingsUpdatedAt: MOCK_NOW,
        updatedAt: MOCK_NOW,
      },
      settings: body,
    };
    states.set(repo, next);
    return HttpResponse.json(settingsView(next) satisfies RepoSettingsResponse);
  }),

  /** 全部仓库（切换器 / 系统页 / 健康卡）。 */
  http.get('/api/repos', () => scenarioResponse({ data: listPayload(), empty: listEmpty() })),

  /** 手动添加（用部署默认 settings seed，`source='manual'`）。 */
  http.post('/api/repos', async ({ request }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const body = (await request.json()) as { repo?: string };
    const repo = typeof body.repo === 'string' ? body.repo : '';
    const state: RepoState = {
      summary: {
        repo,
        enabled: true,
        dryRun: true,
        settingsValid: true,
        settingsError: null,
        settingsUpdatedAt: MOCK_NOW,
        source: 'manual',
        installationId: null,
        archivedAt: null,
        updatedAt: MOCK_NOW,
      },
      settings: { ...DEFAULT_SETTINGS },
    };
    states.set(repo, state);
    return HttpResponse.json(settingsView(state) satisfies RepoSettingsResponse, { status: 201 });
  }),
];
