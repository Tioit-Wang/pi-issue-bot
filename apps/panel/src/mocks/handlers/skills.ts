import { http, HttpResponse, type HttpHandler } from 'msw';
/*
 * 技能的 DTO 直接取自契约本体（`skills.ts` 下半段）：`lib/contract.ts` 还没有再导出技能这一组，
 * 而本次改动不允许碰它（相对路径的取舍见 `lib/api.ts` 顶部同一段说明）。
 */
import type {
  SkillDetail,
  SkillFileMeta,
  SkillListItem,
  SkillPatch,
  SkillsResponse,
  SkillUploadResponse,
  SkillValidation,
  SkillVersion,
  SkillVersionsResponse,
} from '../../../../../packages/contract/src/index.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 技能页（`/skills`）的拦截器 —— 覆盖 `docs/spec/skill-management.md` §6 的 6 条路由。
 *
 * 这份 mock 是**有状态**的（`Map` 存详情 + 版本），因为这一页是面板里第一个有写操作的页面：
 * 开关、上传、删除都必须让「随即刷新的列表」真的变了，否则页面看起来像没生效。
 * 测试里用 `resetSkillsMock()` 在每例前复位（`server.resetHandlers()` 不会清模块状态）。
 *
 * 种子的三条技能刻意覆盖页面的每个分支：
 *  1. `/review-pr`（全局 · 内置 · v2）**被同名的仓库技能覆盖** ⇒ 「被 /review-pr（acme/widgets）覆盖」灰标；
 *  2. `/review-pr`（`acme/widgets` · 面板上传 · v1）⇒ 作用域筛选、来源筛选、覆盖者本尊；
 *  3. `/triage`（全局 · 面板上传 · v3 · 停用 · 1.2 MB）⇒ 关闭状态的开关与 MB 大小格式。
 *
 * 校验结果也两样：第 1 条 `ok` + 一条 warning；第 3 条 `ok` 无告警。
 * 上传按 spec §8 的边界做最小面校验（必须是 zip 的 `PK` 魔数、≤5 MB、必须带 CSRF 头），
 * 不做真正的解包（面板不需要知道解包细节，服务端才是真相）。
 */

const KB = 1024;
const MB = 1024 * KB;
/** 契约：单文件 zip 上传上限 5 MB。 */
const MAX_UPLOAD_BYTES = 5 * MB;

/** 假 sha256：长度 64、只含 `[0-9a-f]`（契约的字面约束，不要求是真的哈希）。 */
function fakeSha(key: string): string {
  return key.replace(/[^0-9a-f]/g, 'a').padEnd(64, '0').slice(0, 64);
}

function fileMeta(path: string, bytes: number): SkillFileMeta {
  return { path, bytes, sha256: fakeSha(path) };
}

/** 详情 = 列表行 + 正文/清单/校验；列表行统一从这里裁出来，避免两处字段漂移。 */
function toListItem(detail: SkillDetail): SkillListItem {
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    scope: detail.scope,
    repo: detail.repo,
    source: detail.source,
    enabled: detail.enabled,
    currentVersion: detail.currentVersion,
    overriddenBy: detail.overriddenBy,
    sizeBytes: detail.sizeBytes,
    updatedAt: detail.updatedAt,
  };
}

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const REVIEW_BODY = `## 何时用

收到 PR 后、合并前。

## 步骤

1. 先读 diff 的**范围**（改了哪些包、有没有迁移）
2. 逐条核对测试：新增行为有没有对应断言
3. 边界值 / 错误分支 / 并发
4. 结论写进评论：**通过 / 需要改**，需要改就列成可勾选的清单

## 注意

- 不评价代码风格（交给 lint）
- 不猜意图：读不到的上下文直接问
`;

const REVIEW_FILES: SkillFileMeta[] = [
  fileMeta('SKILL.md', 2_480),
  fileMeta('assets/checklist.md', 1_220),
];

const TRIAGE_BODY = `## 何时用

issue 刚进来、还没有人认领时。

## 步骤

1. 判断类型（bug / feature / question），打对应的 label
2. 缺信息就回一条「需要什么」的评论
3. 有复现步骤的，挂上 \`needs-repro\` 之前先自己试一次
`;

const TRIAGE_FILES: SkillFileMeta[] = [
  fileMeta('SKILL.md', 1_960),
  fileMeta('assets/labels.json', 640),
  fileMeta('assets/triage.sh', 1_100),
];

type SkillRecord = {
  detail: SkillDetail;
  versions: SkillVersion[];
};

/** 模块级状态：`resetSkillsMock()` 复位（测试每例前调用）。 */
let records = new Map<string, SkillRecord>();

export function resetSkillsMock(): void {
  const reviewValidation: SkillValidation = {
    ok: true,
    errors: [],
    warnings: ['timeout 未声明，按默认 20m 生效'],
  };
  const cleanValidation: SkillValidation = { ok: true, errors: [], warnings: [] };

  const globalReview: SkillDetail = {
    id: 'sk-review-pr-global',
    name: '/review-pr',
    description: '按清单审 PR：先看 diff 范围，再逐条核对测试与边界条件。',
    scope: 'global',
    repo: null,
    source: 'builtin',
    enabled: true,
    currentVersion: 2,
    // 同名的仓库技能优先级更高（spec §7：面板-仓库 > 面板全局 > 仓库文件 > 内置）
    overriddenBy: 'sk-review-pr-repo',
    sizeBytes: REVIEW_FILES.reduce((sum, file) => sum + file.bytes, 0),
    updatedAt: isoAt(-26 * 60 * 60 * 1000),
    frontmatter: {
      name: '/review-pr',
      description: '按清单审 PR：先看 diff 范围，再逐条核对测试与边界条件。',
      'allowed-tools': ['Bash', 'Read', 'Grep'],
      outputs: ['comment', 'labels'],
      'requires-repo-config': false,
    },
    body: REVIEW_BODY,
    files: REVIEW_FILES,
    validation: reviewValidation,
    treeSha256: fakeSha('review-tree-v2'),
  };

  const repoReview: SkillDetail = {
    ...globalReview,
    id: 'sk-review-pr-repo',
    description: '（仓库覆盖版）审 PR：额外检查 acme/widgets 的发布流程与双写迁移。',
    scope: 'repo',
    repo: 'acme/widgets',
    source: 'upload',
    currentVersion: 1,
    overriddenBy: null,
    updatedAt: isoAt(-10 * 60 * 1000),
    frontmatter: {
      name: '/review-pr',
      description: '（仓库覆盖版）审 PR：额外检查 acme/widgets 的发布流程与双写迁移。',
      'allowed-tools': ['Bash', 'Read'],
      outputs: ['comment'],
      timeout: '10m',
    },
    validation: cleanValidation,
    treeSha256: fakeSha('repo-review-tree-v1'),
  };

  const triage: SkillDetail = {
    id: 'sk-triage',
    name: '/triage',
    description: '新 issue 分类：打标签、判断类型，缺信息时回一条「需要什么」。',
    scope: 'global',
    repo: null,
    source: 'upload',
    enabled: false,
    currentVersion: 3,
    overriddenBy: null,
    sizeBytes: 1_200 * KB,
    updatedAt: isoAt(-2 * 60 * 60 * 1000),
    frontmatter: {
      name: '/triage',
      description: '新 issue 分类：打标签、判断类型，缺信息时回一条「需要什么」。',
      'allowed-tools': ['Read', 'Grep'],
      outputs: ['comment', 'labels', 'issue'],
      timeout: '5m',
    },
    body: TRIAGE_BODY,
    files: TRIAGE_FILES,
    validation: cleanValidation,
    treeSha256: fakeSha('triage-tree-v3'),
  };

  records = new Map<string, SkillRecord>([
    [
      globalReview.id,
      {
        detail: globalReview,
        versions: [
          {
            version: 1,
            treeSha256: fakeSha('review-tree-v1'),
            files: [fileMeta('SKILL.md', 2_040)],
            validation: cleanValidation,
            createdAt: isoAt(-3 * 24 * 60 * 60 * 1000),
          },
          {
            version: 2,
            treeSha256: globalReview.treeSha256,
            files: REVIEW_FILES,
            validation: reviewValidation,
            createdAt: globalReview.updatedAt,
          },
        ],
      },
    ],
    [
      repoReview.id,
      {
        detail: repoReview,
        versions: [
          {
            version: 1,
            treeSha256: repoReview.treeSha256,
            files: REVIEW_FILES,
            validation: cleanValidation,
            createdAt: repoReview.updatedAt,
          },
        ],
      },
    ],
    [
      triage.id,
      {
        detail: triage,
        versions: [
          {
            version: 2,
            treeSha256: fakeSha('triage-tree-v2'),
            files: TRIAGE_FILES,
            validation: cleanValidation,
            createdAt: isoAt(-4 * 24 * 60 * 60 * 1000),
          },
          {
            version: 3,
            treeSha256: triage.treeSha256,
            files: TRIAGE_FILES,
            validation: cleanValidation,
            createdAt: triage.updatedAt,
          },
        ],
      },
    ],
  ]);
}

resetSkillsMock();

/* ── 与 handler 共用的纯函数（测试里覆写拦截器时也调用它们，保持同一份状态） ────────── */

/** 列表：按 spec §6 的查询串过滤（缺省 = 全部，不默认只看启用的）。 */
export function listSkillsMock(params?: URLSearchParams): SkillsResponse {
  const scope = params?.get('scope') ?? '';
  const source = params?.get('source') ?? '';
  const enabled = params?.get('enabled') ?? '';
  const repo = params?.get('repo') ?? '';

  const skills = [...records.values()]
    .map((record) => toListItem(record.detail))
    .filter((item) => (scope === '' ? true : item.scope === scope))
    .filter((item) => (source === '' ? true : item.source === source))
    .filter((item) => (enabled === '' ? true : String(item.enabled) === enabled))
    .filter((item) => (repo === '' ? true : item.repo === repo))
    .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));

  return { generatedAt: new Date().toISOString(), skills };
}

export function skillDetailMock(id: string): SkillDetail | null {
  return records.get(id)?.detail ?? null;
}

export function skillVersionsMock(id: string): SkillVersionsResponse | null {
  const record = records.get(id);
  if (record === undefined) return null;
  return {
    generatedAt: new Date().toISOString(),
    skillId: id,
    versions: [...record.versions].sort((a, b) => b.version - a.version),
  };
}

/** `PATCH`：只允许 `enabled` / `description` / `body`（给了 `body` 就产生一个新版本）。 */
export function patchSkillMock(id: string, patch: SkillPatch): SkillDetail | null {
  const record = records.get(id);
  if (record === undefined) return null;

  const updatedAt = new Date().toISOString();
  const next: SkillDetail = { ...record.detail, updatedAt };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.body !== undefined) {
    next.body = patch.body;
    next.currentVersion = record.detail.currentVersion + 1;
    record.versions = [
      ...record.versions,
      {
        version: next.currentVersion,
        treeSha256: next.treeSha256,
        files: next.files,
        validation: next.validation,
        createdAt: updatedAt,
      },
    ];
  }

  record.detail = next;
  return next;
}

/** `DELETE`：软删 = 从这里消失（磁盘内容由服务端按保留期处理）。 */
export function deleteSkillMock(id: string): boolean {
  return records.delete(id);
}

/**
 * `POST /api/skills`：真正解包不在面板 mock 的范围里，这里只按字节数决定版本号，
 * 让「同名再传 = 版本 +1」这条交互在页面上看得见。
 */
export function uploadSkillMock(bytes: Uint8Array): SkillUploadResponse {
  const id = 'sk-uploaded-demo';
  const existing = records.get(id);
  const name = '/uploaded-demo';
  const validation: SkillValidation = { ok: true, errors: [], warnings: [] };
  const version = existing === undefined ? 1 : existing.detail.currentVersion + 1;
  const files = [fileMeta('SKILL.md', bytes.byteLength), fileMeta('assets/README.md', 180)];

  const detail: SkillDetail = {
    id,
    name,
    description: '面板上传的示例技能（mock：真实内容在 zip 里，面板只展示元数据）。',
    scope: 'global',
    repo: null,
    source: 'upload',
    enabled: true,
    currentVersion: version,
    overriddenBy: null,
    sizeBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    updatedAt: new Date().toISOString(),
    frontmatter: {
      name,
      description: '面板上传的示例技能（mock：真实内容在 zip 里，面板只展示元数据）。',
      'allowed-tools': ['Read'],
      outputs: ['comment'],
    },
    body: '（mock）这个技能的正文来自刚上传的 zip。\n',
    files,
    validation,
    treeSha256: fakeSha(`uploaded-${String(version)}`),
  };

  const versions: SkillVersion[] =
    existing === undefined
      ? [
          {
            version,
            treeSha256: detail.treeSha256,
            files,
            validation,
            createdAt: detail.updatedAt,
          },
        ]
      : [
          ...existing.versions,
          {
            version,
            treeSha256: detail.treeSha256,
            files,
            validation,
            createdAt: detail.updatedAt,
          },
        ];

  records.set(id, { detail, versions });
  return { skill: toListItem(detail), version, validation };
}

/* ── 拦截器 ───────────────────────────────────────────────────────────────── */

function errorResponse(status: number, code: string, message: string): Response {
  return HttpResponse.json({ error: { code, message } }, { status });
}

/** 写接口的 CSRF 检查（spec R11）：缺头就 403，和真实服务端一致。 */
function csrfRejected(request: Request): Response | null {
  if (request.headers.get('X-Pi-Bot-CSRF') !== '1') {
    return errorResponse(403, 'forbidden', '缺少 X-Pi-Bot-CSRF 头（写接口需要它）');
  }
  return null;
}

export const skillsHandlers: HttpHandler[] = [
  // 具体路径在前（`/versions` 不会被 `/api/skills` 抢走，但顺序约定与 index.ts 一致）
  http.get('/api/skills/:id/versions', ({ params }) => {
    const result = skillVersionsMock(String(params.id));
    if (result === null) return errorResponse(404, 'not-found', '技能不存在');
    return scenarioResponse({ data: result });
  }),

  http.get('/api/skills/:id', ({ params }) => {
    const detail = skillDetailMock(String(params.id));
    if (detail === null) return errorResponse(404, 'not-found', '技能不存在');
    return scenarioResponse({ data: detail });
  }),

  http.get('/api/skills', ({ request }) =>
    scenarioResponse({
      data: listSkillsMock(new URL(request.url).searchParams),
      empty: { generatedAt: new Date().toISOString(), skills: [] } satisfies SkillsResponse,
    }),
  ),

  http.post('/api/skills', async ({ request }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    if ((request.headers.get('content-type') ?? '') !== 'application/zip') {
      return errorResponse(400, 'bad-request', '上传只接受 application/zip（原始二进制）');
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return errorResponse(413, 'payload-too-large', 'zip 超过 5 MB 上限');
    }
    // zip 的本地文件头魔数 `PK\x03\x04`：mock 里只校验这一层，真正的解包在服务端
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return errorResponse(400, 'bad-request', '不是合法的 zip（缺少 PK 魔数）');
    }

    return HttpResponse.json(uploadSkillMock(bytes), { status: 201 });
  }),

  http.patch('/api/skills/:id', async ({ request, params }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const patch = (await request.json()) as SkillPatch;
    const detail = patchSkillMock(String(params.id), patch);
    if (detail === null) return errorResponse(404, 'not-found', '技能不存在');
    return HttpResponse.json(detail);
  }),

  http.delete('/api/skills/:id', ({ request, params }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const id = String(params.id);
    const record = skillDetailMock(id);
    if (record === null) return errorResponse(404, 'not-found', '技能不存在');

    // `?hard=1` 只对面板上传的技能有效（内置技能不能硬删，spec §6）
    if (new URL(request.url).searchParams.get('hard') === '1' && record.source !== 'upload') {
      return errorResponse(409, 'conflict', '内置技能不能硬删（先停用）');
    }

    deleteSkillMock(id);
    return new HttpResponse(null, { status: 204 });
  }),
];
