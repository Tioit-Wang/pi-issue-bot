import { http, HttpResponse, type HttpHandler } from 'msw';
import type { RepoSettingsResponse, ReposResponse, SaveRepoSettingsRequest } from '../../lib/contract.ts';
import { MOCK_NOW } from '../fixtures.ts';
import { requireCsrf, scenarioResponse } from './shared.ts';

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
 *
 * 提示词子系统（`?kind=` 四条版本线）随固定流水线一起退役：`prompt.ts` 已删除，
 * 仓库设置只剩这一组写接口（`PUT settings` 走 `shared.ts` 的 `requireCsrf`）。
 */

/**
 * 仓库配置的样本（面板只做展示/回写，不在这里发明默认值）。
 *
 * `labels.vocabulary` 给三条**带 role** 的词条（需求 / 缺陷 / 其他 各一）：
 * 角色是分类阶段的流程分叉依据（§4.5 / Q4），空词表会让设置页的角色下拉与覆盖提示
 * 都没有行可渲染 —— mock 模式就看不到这条真实分支。三条名字互不重复（契约校验）。
 */
const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,
  dry_run: true,
  triggers: { aliases: ['issuebot'] },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement', meaning: '用户希望新增或改变的行为', color: '0E8A16' },
      { name: '缺陷', role: 'defect', meaning: '与既有行为不符的实现问题', color: 'D73A4A' },
      { name: '文档', role: 'other', meaning: '不需要进入开发流程的改动', color: '5319E7' },
    ],
    map: {},
    missing: 'warn',
    max_per_issue: 6,
  },
  skills: { project_skills: true },
  limits: {
    max_comments_per_hour: 10,
    max_actions_per_run: 8,
    max_task_minutes: 20,
    concurrency_per_repo: 2,
    queue_wait_minutes: 10,
  },
  agent: {
    managers: ['alice', 'bob'],
    on_opened: 'format-check',
    on_edited: 'format-check',
    auto_label_after_format_pass: false,
    project_prompt: '本仓库用 pnpm，跑 `pnpm -r test` 前先 `pnpm build`。',
  },
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
      settings: { ...DEFAULT_SETTINGS, dry_run: false },
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

export const reposHandlers: HttpHandler[] = [
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
