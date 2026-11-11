/**
 * 提示词（四条版本线）的拦截器 —— `?kind=` 是查询参数，所以**一条路径、四份 fixture**。
 *
 * | kind | fixture | 面板要能看见的分支 |
 * |---|---|---|
 * | `project` | v2 项目版 | 「整体覆盖」+ 预算条 + P1 开关 |
 * | `format_check` | 系统默认（指针 v0） | 「未覆盖」+ 内置默认只读区 + 必填占位符校验 |
 * | `classify` | v2 项目版 | 阶段 kind 的上限（8000，不是 P1 预算） |
 * | `agent` | v1 项目版 | 计入 `baseChars`（写多长就扣掉 P1 多少额度，V18） |
 *
 * 三条口径与服务端一致（`apps/server/src/http/api/prompt.ts`）：
 *  1. **四个接口返回同一形状**（`viewOf()`）：当前版本 + 版本列表 + 预算 + 层序 + 预览；
 *  2. **保存即新建版本**（不是覆盖），`layers` 里的 `head` / `tail` 恒为 `droppable: false`；
 *  3. **保存期的三种 400**：`details.code` 是 `placeholder-unknown` / `placeholder-missing` /
 *     `body-too-long`（另有 `empty-body`），面板按它翻成中文文案 —— mock 也照这套返回，
 *     否则「错误文案」这条路只能靠真实服务端验证。
 *
 * 写操作只改内存（模块级 `Map`），刷新页面即回到样本；`?mock=error|empty|slow|unauthorized`
 * 沿用 `scenarioResponse` 的统一机制（读的是页面 URL，不是请求 URL）。
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { PromptKind } from '../../../../../packages/contract/src/index.ts';
import type { PromptBudget, PromptLayerView, PromptResponse, PromptVersionSummary } from '../../lib/contract.ts';
import { MOCK_NOW } from '../fixtures.ts';
import { requireCsrf, scenarioResponse } from './shared.ts';

/** 四条版本线的取值来源（与服务端 `PROMPT_KINDS` 同一份口径）。 */
const PROMPT_KINDS = ['project', 'format_check', 'classify', 'agent'] as const satisfies readonly PromptKind[];

/** 保存期上限（服务端 `PIPELINE_PROMPT_LIMITS`）。 */
const LIMITS = { project: 4_000, format_check: 8_000, classify: 8_000, agent: 4_000 } as const;

/** 阶段 kind 可用的占位符（服务端 `STAGE_PROMPT_PLACEHOLDERS`）。 */
const STAGE_PLACEHOLDERS = ['title', 'body', 'repo', 'target', 'labels', 'author', 'url', 'recheck'] as const;
/** `project` 可用的占位符（P1 层不注入 issue 上下文）。 */
const PROJECT_PLACEHOLDERS = ['repo', 'default_branch', 'labels', 'triggers'] as const;
/** 必填占位符：只有 `format_check` 强制（少了它判据就不完整，V11）。 */
const REQUIRED_PLACEHOLDERS: Partial<Record<PromptKind, readonly string[]>> = { format_check: ['title', 'body'] };

/**
 * 内置默认正文（只读展示）。`project` 恒为空串 —— 它没有默认正文（`version = 0` 即不注入）。
 * 内容摘自服务端 `skills/stage-prompts.ts` 的模板，保留占位符原样。
 */
const SYSTEM_DEFAULT = {
  project: '',
  format_check: [
    '【任务】判断这个 issue（{{repo}} {{target}}）的格式是否符合本项目要求。',
    '【项目要求】（这一段由项目维护：写清必填项与判定标准。）',
    '【issue】标题：{{title}}',
    '作者：{{author}}',
    '正文：{{body}}',
  ].join('\n'),
  classify: [
    '【任务】判断 {{repo}} {{target}} 的类型并给结论：requirement / defect / other。',
    '【可用标签】{{labels}}',
    '【issue】{{title}}',
    '正文：{{body}}',
  ].join('\n'),
  agent: [
    '【身份】你是 {{repo}} 的 issue 处理助手，只在被 @ 时响应；处理对象：{{target}}。',
    '【上下文】标题：{{title}}；正文：{{body}}。',
    '【输出】先给结论，再给依据；最后交出一个 JSON 对象。',
  ].join('\n'),
} as const satisfies Record<PromptKind, string>;

/** `acme/widgets` 的初始正文（三个项目版各写一段，让人一眼看出 tab 切对了）。 */
const INITIAL_BODY = {
  project: [
    '## 项目约定',
    '',
    '- 提交信息用中文，类型前缀沿用 Conventional Commits。',
    '- 改到 `apps/server/src/queries/**` 必须同时改 `test/queries-*.test.ts`。',
    '- 别在评论里贴内部链接（内网地址一律不许出现在 GitHub 上）。',
    '- 仓库标签与角色见 {{labels}}；触发别名见 {{triggers}}。',
  ].join('\n'),
  format_check: '',
  classify: [
    '【项目补充】除了通用判据，这个仓库还要求：',
    '',
    '- 结论为 defect 时，evidence 必须给 `path:line`；找不到就写 not-found 并说明已查范围。',
    '- 需求类结论的评论按「需求理解 / 影响范围 / 实现要点 / 风险与待确认 / 工作量档位」五段写。',
    '',
    '【issue】{{title}}',
    '正文：{{body}}',
  ].join('\n'),
  agent: [
    '【项目补充】这个仓库的额外约定：',
    '',
    '- 不要改动 `migrations/**`，需要迁移时只给建议。',
    '- 回答里提到文件一律写成 `path:line`。',
  ].join('\n'),
} as const satisfies Record<PromptKind, string>;

type PromptState = {
  body: string;
  activeVersion: number;
  present: boolean;
  versions: PromptVersionSummary[];
};

/** 初始版本线：`format_check` 刻意是「指针 v0 + 没项目版本」（系统默认那一态）。 */
function initialState(kind: PromptKind): PromptState {
  if (kind === 'format_check') return { body: '', activeVersion: 0, present: false, versions: [] };
  const body = INITIAL_BODY[kind];
  const activeVersion = kind === 'agent' ? 1 : 2;
  const versions: PromptVersionSummary[] = [
    {
      version: activeVersion,
      note: kind === 'project' ? '补一条「别贴内部链接」' : '按流水线口径补一段项目补充',
      createdAt: '2026-05-31T10:00:00.000Z',
      chars: body.length,
      current: true,
    },
  ];
  if (activeVersion > 1) {
    versions.push({
      version: activeVersion - 1,
      note: '初版：提交信息与测试约定',
      createdAt: '2026-05-20T08:30:00.000Z',
      chars: 120,
      current: false,
    });
  }
  return { body, activeVersion, present: true, versions };
}

/** 进程内的假版本库（`${repo}:${kind}` → 当前状态），PUT 之后 GET 能读到最后一次写入。 */
const states = new Map<string, PromptState>(
  PROMPT_KINDS.map((kind) => ['acme/widgets:' + kind, initialState(kind)]),
);

function stateOf(repo: string, kind: PromptKind): PromptState {
  const key = `${repo}:${kind}`;
  const found = states.get(key);
  if (found !== undefined) return found;
  const created = initialState(kind);
  states.set(key, created);
  return created;
}

function kindOf(request: Request): PromptKind {
  const value = new URL(request.url).searchParams.get('kind');
  return PROMPT_KINDS.find((kind) => kind === value) ?? 'project';
}

function repoOf(params: Record<string, string | readonly string[] | undefined>): string {
  return `${String(params['owner'])}/${String(params['name'])}`;
}

/** 保存期预演（服务端 `prompt/budget.ts` 的 `PromptBudget`）。 */
function budgetOf(kind: PromptKind, body: string): PromptBudget {
  // 阶段 kind 的正文落在 head（baseChars）里，所以 P1 的可用额度会被它挤掉（V18）
  const stageChars = kind === 'project' ? 0 : body.length;
  const otherLayersChars = 6_700 + stageChars;
  const available = kind === 'project' ? 4_000 : Math.max(0, 12_000 - otherLayersChars);
  return {
    budgetChars: 12_000,
    p1Cap: 4_000,
    otherLayersChars,
    available,
    requested: kind === 'project' ? body.length : 0,
    ok: kind !== 'project' || body.length <= available,
    source: 'last-assembly',
    layers: { p0: 1_200, p1: kind === 'project' ? body.length : available, p2Root: 2_400, p2Nearby: 1_800, p3: 1_200, p4: 0 },
  };
}

/**
 * 层序（与服务端 `assembleCore()` 同一份口径）：
 * - 阶段 kind 的 `head` 就是阶段系统提示词（项目版整体覆盖内置默认），不出现 `project` 层；
 * - `project` 只有项目版那一层；
 * - `head` / `tail` 恒为 `droppable: false`（运行期超预算也不丢）。
 */
function layersOf(kind: PromptKind, body: string, isSystemDefault: boolean): PromptLayerView[] {
  const headText = kind === 'project' ? '（固定基座）' : body === '' || isSystemDefault ? SYSTEM_DEFAULT[kind] : body;
  const head: PromptLayerView = { name: 'head', chars: headText.length, droppable: false, dropped: false };
  const tail: PromptLayerView = { name: 'tail', chars: 420, droppable: false, dropped: false };
  if (kind === 'project') {
    return [
      head,
      { name: 'project', chars: body.length, droppable: true, dropped: false },
      { name: 'agents:root', chars: 2_400, droppable: true, dropped: false },
      { name: 'skill:review', chars: 1_200, droppable: true, dropped: false },
      tail,
    ];
  }
  return [head, tail];
}

/** 一个 kind 的完整视图（GET / PUT / rollback / restore 同一个形状）。 */
function viewOf(repo: string, kind: PromptKind): PromptResponse {
  const state = stateOf(repo, kind);
  const limit = LIMITS[kind];
  const budget = budgetOf(kind, state.body);
  const isSystemDefault = kind === 'project' ? false : state.activeVersion === 0 || !state.present;
  const body = kind === 'project' || !isSystemDefault ? state.body : '';
  const headChars = (layersOf(kind, body, isSystemDefault)[0] ?? { chars: 0 }).chars;
  return {
    repo,
    kind,
    kinds: PROMPT_KINDS,
    enabled: true,
    version: state.activeVersion,
    activeVersion: state.activeVersion,
    present: state.present,
    body,
    systemDefault: SYSTEM_DEFAULT[kind],
    isSystemDefault,
    limit,
    availableChars: kind === 'project' ? budget.available : Math.max(0, limit - body.length),
    versions: [...state.versions].sort((left, right) => right.version - left.version),
    budget,
    layers: layersOf(kind, body, isSystemDefault),
    preview: {
      text: `# pi-issue-bot\n\n（固定基座省略 · ${kind}）\n\n${body === '' ? SYSTEM_DEFAULT[kind] : body}\n`,
      stats: {
        baseChars: headChars,
        promptChars: kind === 'project' ? body.length : 0,
        agentsChars: kind === 'project' ? 2_400 : 0,
        skillChars: kind === 'project' ? 1_200 : 0,
        totalChars: headChars + 420 + (kind === 'project' ? body.length + 3_600 : 0),
        truncated: [],
      },
      omitted:
        kind === 'project'
          ? ['AGENTS.md（来自 worktree）', '任务技能（来自 registry）']
          : ['输出契约（运行期由代码追加）', 'AGENTS.md（来自 worktree）'],
      ref: null,
      sha: null,
    },
    lastAssembly: {
      baseChars: headChars,
      promptChars: kind === 'project' ? body.length : 0,
      agentsChars: kind === 'project' ? 2_400 : 0,
      skillChars: kind === 'project' ? 1_200 : 0,
      totalChars: headChars + 420 + (kind === 'project' ? body.length + 3_600 : 0),
      truncated: [],
    },
  };
}

/* ── 保存期校验（三种 400，错误码与服务端一字不差） ───────────────────────── */

type SaveError = { status: number; code: string; message: string; details: Record<string, unknown> };

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu;

function placeholdersOf(body: string): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 按服务端的顺序判：空正文 → 未知占位符 → 缺必填占位符 → 超上限。 */
function validate(kind: PromptKind, body: string): SaveError | null {
  const trimmed = body.trim();
  if (trimmed === '') {
    return { status: 400, code: 'empty-body', message: `${kind} 正文不能为空`, details: {} };
  }

  const allowed: readonly string[] = kind === 'project' ? PROJECT_PLACEHOLDERS : STAGE_PLACEHOLDERS;
  const unknown = placeholdersOf(trimmed).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    return {
      status: 400,
      code: 'placeholder-unknown',
      message: `${kind} 正文里有未识别的占位符：${unknown.map((name) => `{{${name}}}`).join('、')}`,
      details: { unknownPlaceholders: unknown },
    };
  }

  const required = REQUIRED_PLACEHOLDERS[kind] ?? [];
  const missing = required.filter((name) => !placeholdersOf(trimmed).includes(name));
  if (missing.length > 0) {
    return {
      status: 400,
      code: 'placeholder-missing',
      message: `${kind} 正文缺少必需的占位符：${missing.map((name) => `{{${name}}}`).join('、')}`,
      details: { missingPlaceholders: missing },
    };
  }

  if (trimmed.length > LIMITS[kind]) {
    return {
      status: 400,
      code: 'body-too-long',
      message: `${kind} 正文 ${String(trimmed.length)} 字符，超过上限 ${String(LIMITS[kind])}`,
      details: {},
    };
  }

  return null;
}

function errorResponse(error: SaveError): Response {
  return HttpResponse.json(
    { error: { code: 'bad-request', message: error.message, details: { code: error.code, ...error.details } } },
    { status: error.status },
  );
}

/** 写成功 = 新建一版（不覆盖），版本指针跟到新版本。 */
function commit(repo: string, kind: PromptKind, body: string, note: string | null): void {
  const state = stateOf(repo, kind);
  const nextVersion = state.activeVersion + 1;
  states.set(`${repo}:${kind}`, {
    body,
    activeVersion: nextVersion,
    present: true,
    versions: [
      { version: nextVersion, note, createdAt: MOCK_NOW, chars: body.length, current: true },
      ...state.versions.map((version) => ({ ...version, current: false })),
    ],
  });
}

export const promptHandlers: HttpHandler[] = [
  /** 三段以上的路径先注册（避免被 `/prompt` 抢先匹配；MSW 按完整路径匹配，这里仍按具体在前排）。 */
  http.get('/api/repos/:owner/:name/prompt/versions', ({ request, params }) => {
    const repo = repoOf(params);
    const kind = kindOf(request);
    const view = viewOf(repo, kind);
    return scenarioResponse({
      data: {
        repo,
        kind,
        kinds: PROMPT_KINDS,
        activeVersion: view.activeVersion ?? 0,
        isSystemDefault: view.isSystemDefault ?? false,
        limit: view.limit ?? LIMITS[kind],
        versions: view.versions,
      },
      slowMs: 300,
    });
  }),

  http.get('/api/repos/:owner/:name/prompt', ({ request, params }) =>
    scenarioResponse({ data: viewOf(repoOf(params), kindOf(request)), slowMs: 500 }),
  ),

  http.put('/api/repos/:owner/:name/prompt', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const repo = repoOf(params);
    const kind = kindOf(request);
    const payload = (await request.json()) as { body?: string; note?: string };
    const body = typeof payload.body === 'string' ? payload.body : '';
    const invalid = validate(kind, body);
    if (invalid !== null) return errorResponse(invalid);
    commit(repo, kind, body.replace(/\s+$/u, ''), payload.note ?? null);
    return HttpResponse.json(viewOf(repo, kind) satisfies PromptResponse);
  }),

  http.post('/api/repos/:owner/:name/prompt/rollback', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const repo = repoOf(params);
    const kind = kindOf(request);
    const payload = (await request.json()) as { version?: number };
    const state = stateOf(repo, kind);
    const target = state.versions.find((version) => version.version === payload.version);
    if (target === undefined) {
      return HttpResponse.json(
        { error: { code: 'not-found', message: `v${String(payload.version ?? 0)} 不存在（${kind}）` } },
        { status: 404 },
      );
    }
    commit(repo, kind, state.body, `回滚自 v${String(target.version)}`);
    return HttpResponse.json(viewOf(repo, kind) satisfies PromptResponse);
  }),

  http.post('/api/repos/:owner/:name/prompt/restore', async ({ request, params }) => {
    const csrf = requireCsrf(request);
    if (csrf !== null) return csrf;
    const repo = repoOf(params);
    const kind = kindOf(request);
    const state = stateOf(repo, kind);
    // 「恢复默认」= 指针回 0（不删历史），所以历史里仍然能选回旧版本
    states.set(`${repo}:${kind}`, {
      body: '',
      activeVersion: 0,
      present: false,
      versions: state.versions.map((version) => ({ ...version, current: false })),
    });
    return HttpResponse.json(viewOf(repo, kind) satisfies PromptResponse);
  }),
];
