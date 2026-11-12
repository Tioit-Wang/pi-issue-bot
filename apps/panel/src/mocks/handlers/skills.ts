import { http, HttpResponse, type HttpHandler } from 'msw';
/*
 * 技能的 DTO 直接取自契约本体（`skills.ts` 下半段）：`lib/contract.ts` 还没有再导出技能这一组，
 * 而本次改动不允许碰它（相对路径的取舍见 `lib/api.ts` 顶部同一段说明）。
 */
import type {
  SkillDetail,
  SkillFileMeta,
  SkillFilesResponse,
  SkillFileText,
  SkillImportResponse,
  SkillListItem,
  SkillPatch,
  SkillsResponse,
  SkillUploadResponse,
  SkillValidation,
  SkillVersion,
  SkillVersionsResponse,
} from '../../../../../packages/contract/src/index.ts';
import { isEditableSkillPath, utf8ByteLength } from '../../lib/skill-files.ts';
import { composeSkillText } from '../../lib/skill-text.ts';
import { scenarioResponse } from './shared.ts';

/**
 * 技能（`/api/skills*`）的拦截器 —— 覆盖 `docs/spec/skill-management.md` §6 的路由。
 *
 * 技能**只属于项目**（`repo=owner/name` 必填）：种子都挂在 `acme/widgets` 上，
 * 三个内置技能（`source=builtin`）对任何项目都可见，用来验证「内置排在最前 + 可被本项目同名技能覆盖」。
 *
 * 这份 mock 是**有状态**的（`Map` 存详情 + 版本），因为技能页有写操作：
 * 开关、上传、删除都必须让「随即刷新的列表」真的变了，否则页面看起来像没生效。
 * 测试里用 `resetSkillsMock()` 在每例前复位（`server.resetHandlers()` 不会清模块状态）。
 *
 * 种子刻意覆盖页面的每个分支：
 *  1. `/review-pr`（`acme/widgets` · 面板上传 · v1）⇒「面板上传」徽章、可编辑的仓库技能；
 *  2. `/release-notes`（`acme/widgets` · 面板上传 · v2 · 两层目录）⇒ 文件树嵌套与保存路径。
 *
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

/*
 * 附件正文（seed 用）：`GET /api/skills/:id/files` 要能返回「点开有内容」的文件。
 * 字节数与 meta 不必相等 —— 树上的字节数按 UTF-8 现算（`lib/skill-files.ts`）。
 */
const ATTACHMENT_TEXT: Record<string, string> = {
  'assets/checklist.md': `## 评审清单

- [ ] 新增行为有对应断言
- [ ] 错误分支有断言（不只是 happy path）
- [ ] 迁移脚本可回滚
- [ ] CHANGELOG 已更新
`,
  'assets/labels.json': `{
  "type": ["bug", "feature", "question"],
  "status": ["needs-repro", "needs-info", "blocked"]
}
`,
  'assets/triage.sh': `#!/usr/bin/env bash
# mock 附件：真实技能里的脚本不会进文件树（只列文本文件）
set -euo pipefail
echo "triage"
`,
  'references/publishing.md': `# 发布流程

1. 合并到主干后等 CI 绿
2. 打 tag：\`v<主>.<次>.<补丁>\`
3. 用发布说明草稿人工过一遍「破坏性变更」
`,
  'references/guides/versioning.md': `# 版本号约定

语义化版本：破坏性变更升主版本，新增能力升次版本，其余升补丁。
预告两个版本后才可以落主版本。
`,
};

/** `/release-notes` 的附件清单：刻意有两级目录，模态框的文件树要靠它验证嵌套。 */
const RELEASE_NOTES_FILES: SkillFileMeta[] = [
  fileMeta('SKILL.md', 1_480),
  fileMeta('references/publishing.md', 980),
  fileMeta('references/guides/versioning.md', 620),
];

const ISSUE_FORMAT_BODY = `## 何时用

issue 正文抓不到重点（缺复现、缺期望）时。

## 步骤

1. 把正文拆成粒度一致的段落：现象 / 复现步骤 / 期望行为 / 环境
2. 缺哪一段就在评论里点名要哪一段，不整体重写
3. 保留原始报错与版本号（改写会丢信息）
`;

const LABEL_TRIAGE_BODY = `## 何时用

issue 还没有 label、或 label 与正文明显不符时。

## 步骤

1. 先从仓库的标签词表里挑，不要新造标签
2. 类型标签（bug / feature / question）只打一个
3. 人工已经打过的标签一律保留，冲突写进评论
`;

const ISSUE_ANALYSIS_BODY = `## 何时用

需要判断「这是真 bug 还是配置问题」的时候。

## 步骤

1. 先读 issue 里的堆栈与版本，再读仓库里对应的代码路径
2. 结论压成一句话：现象 → 原因 → 下一步
3. 不确定的环节明确写「未验证」，不猜实现细节
`;

const RELEASE_NOTES_BODY = `## 何时用

发布 tag 之前需要一份给人看的变更说明。

## 步骤

1. 只看已合并的 PR 标题与标签，别抄 commit 原文
2. 分三组：新增 / 修复 / 破坏性变更
3. 破坏性变更必须写出迁移动作
`;

/** 一个内置技能的种子：三个内置技能只有 id / 名字 / 正文不同。 */
function builtinSeed(input: {
  id: string;
  name: string;
  description: string;
  body: string;
  bytes: number;
  /** 内置副本所属的项目：技能只有项目级，不再有「全局内置技能」。 */
  repo: string;
}): SkillDetail {
  const files = [fileMeta('SKILL.md', input.bytes)];
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    // 内置技能是**每个项目各自的副本**（播种而来）：`repo` 就是当前项目，`source='builtin'`。
    // 以前这里造的是 `repo: null` 的「全局内置技能」，与「技能只有项目级」的模型相悖。
    scope: 'repo',
    repo: input.repo,
    source: 'builtin',
    enabled: true,
    currentVersion: 1,
    overriddenBy: null,
    sizeBytes: input.bytes,
    updatedAt: isoAt(-30 * 24 * 60 * 60 * 1000),
    frontmatter: {
      name: input.name,
      description: input.description,
      'allowed-tools': ['Read', 'Grep'],
      outputs: ['comment', 'labels'],
      timeout: '20m',
    },
    body: input.body,
    files,
    validation: { ok: true, errors: [], warnings: [] },
    treeSha256: fakeSha(`${input.id}-v1`),
  };
}

type SkillRecord = {
  detail: SkillDetail;
  versions: SkillVersion[];
  /** 被 `PUT /api/skills/:id` 保存过的整份 SKILL.md 原文（详情里带回去）。 */
  text?: string;
  /** 当前版本每个**文本文件**的全文：`GET /api/skills/:id/files` 的数据源。 */
  fileTexts: SkillFileText[];
};

/**
 * seed 一个技能的「当前版本文件全文」：`SKILL.md` 由 frontmatter + 正文拼回，
 * 附件正文来自 `ATTACHMENT_TEXT`（没有就生成一句占位，保证点开不是空白）。
 */
function seededFiles(detail: SkillDetail): SkillFileText[] {
  const files: SkillFileText[] = [
    { path: 'SKILL.md', text: composeSkillText(detail.frontmatter, detail.body) },
  ];
  for (const meta of detail.files) {
    if (meta.path === 'SKILL.md') continue;
    files.push({ path: meta.path, text: ATTACHMENT_TEXT[meta.path] ?? `（mock 附件）${meta.path}\n` });
  }
  return files;
}

/** 模块级状态：`resetSkillsMock()` 复位（测试每例前调用）。 */
let records = new Map<string, SkillRecord>();

export function resetSkillsMock(): void {
  const cleanValidation: SkillValidation = { ok: true, errors: [], warnings: [] };

  /** `acme/widgets` 自己上传的一条技能（页面上可编辑、可停用）。 */
  const repoReview: SkillDetail = {
    id: 'sk-review-pr-repo',
    name: '/review-pr',
    description: '审 PR：额外检查 acme/widgets 的发布流程与双写迁移。',
    scope: 'repo',
    repo: 'acme/widgets',
    source: 'upload',
    enabled: true,
    currentVersion: 1,
    overriddenBy: null,
    sizeBytes: REVIEW_FILES.reduce((sum, file) => sum + file.bytes, 0),
    updatedAt: isoAt(-10 * 60 * 1000),
    frontmatter: {
      name: '/review-pr',
      description: '审 PR：额外检查 acme/widgets 的发布流程与双写迁移。',
      'allowed-tools': ['Bash', 'Read'],
      outputs: ['comment'],
      timeout: '10m',
    },
    body: REVIEW_BODY,
    files: REVIEW_FILES,
    validation: cleanValidation,
    treeSha256: fakeSha('repo-review-tree-v1'),
  };

  /* 三个内置技能（项目技能页要求它们始终排在最前）+ 本项目的两条自定义技能。 */
  const listedBuiltins: SkillDetail[] = [
    builtinSeed({
      id: 'sk-builtin-issue-format',
      name: '/issue-format',
      description: '把 issue 正文整理成固定结构：现象、复现步骤、期望行为、环境。',
      body: ISSUE_FORMAT_BODY,
      bytes: 1_840,
      repo: 'acme/widgets',
    }),
    builtinSeed({
      id: 'sk-builtin-label-triage',
      name: '/label-triage',
      description: '按标签词表给 issue 打标签；与人工标签冲突时保留人工的那一个。',
      body: LABEL_TRIAGE_BODY,
      bytes: 1_620,
      repo: 'acme/widgets',
    }),
    builtinSeed({
      id: 'sk-builtin-issue-analysis',
      name: '/issue-analysis',
      description: '读代码与日志给出一句话结论，不猜实现细节。',
      body: ISSUE_ANALYSIS_BODY,
      bytes: 2_100,
      repo: 'acme/widgets',
    }),
  ];

  const releaseNotes: SkillDetail = {
    ...builtinSeed({
      id: 'sk-release-notes',
      name: '/release-notes',
      description: '按合并日志生成发布说明草稿，只写用户可见的变更。',
      body: RELEASE_NOTES_BODY,
      bytes: 1_480,
      repo: 'acme/widgets',
    }),
    scope: 'repo',
    repo: 'acme/widgets',
    source: 'upload',
    currentVersion: 2,
    updatedAt: isoAt(-45 * 60 * 1000),
    treeSha256: fakeSha('release-notes-v2'),
    // 两级目录：`references/guides/versioning.md` 用来验证文件树的嵌套缩进
    files: RELEASE_NOTES_FILES,
    sizeBytes: RELEASE_NOTES_FILES.reduce((sum, file) => sum + file.bytes, 0),
  };

  // 全部种子走同一段「详情 + 版本 + 文件全文」的装配，避免两处字段漂移
  records = new Map<string, SkillRecord>();
  for (const seeded of [...listedBuiltins, releaseNotes, repoReview]) {
    records.set(seeded.id, {
      detail: seeded,
      fileTexts: seededFiles(seeded),
      versions: [
        {
          version: seeded.currentVersion,
          treeSha256: seeded.treeSha256,
          files: seeded.files,
          validation: seeded.validation,
          createdAt: seeded.updatedAt,
        },
      ],
    });
  }
}

resetSkillsMock();

/* ── 与 handler 共用的纯函数（测试里覆写拦截器时也调用它们，保持同一份状态） ────────── */

/**
 * 列表：按 spec §6 的查询串过滤（缺省 = 全部，不默认只看启用的）。
 *
 * 技能只属于项目，所以 `repo` 是主过滤器；三个内置技能（`source='builtin'`、`repo=null`）
 * 对**任何**项目都可见 —— 它们在界面上恒等于「引擎自带的三个」。
 */
export function listSkillsMock(params?: URLSearchParams): SkillsResponse {
  const source = params?.get('source') ?? '';
  const enabled = params?.get('enabled') ?? '';
  const repo = params?.get('repo') ?? '';

  const skills = [...records.values()]
    .map((record) => toListItem(record.detail))
    .filter((item) => (source === '' ? true : item.source === source))
    .filter((item) => (enabled === '' ? true : String(item.enabled) === enabled))
    .filter((item) => repo === '' || item.repo === repo)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { generatedAt: new Date().toISOString(), skills };
}

/** 详情 = 列表行 + frontmatter/正文/文件/校验；保存过原文的技能把 `text` 一起带回去。 */
export type SkillDetailMock = SkillDetail & { text?: string };

export function skillDetailMock(id: string): SkillDetailMock | null {
  const record = records.get(id);
  if (record === undefined) return null;
  return record.text === undefined ? record.detail : { ...record.detail, text: record.text };
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

/** 极简 frontmatter 解析（mock 用）：只认 `key: value` 与标量列表，真实解析在服务端。 */
function parseSkillTextMock(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/u.exec(text);
  if (match === null) return { frontmatter: {}, body: text };

  const frontmatter: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const item = /^\s+-\s*(.*)$/u.exec(line);
    if (item !== null && listKey !== null) {
      const current = frontmatter[listKey];
      const list = Array.isArray(current) ? current : [];
      list.push(scalarMock(item[1] ?? ''));
      frontmatter[listKey] = list;
      continue;
    }
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/u.exec(line);
    if (entry === null) continue;
    const key = entry[1] ?? '';
    const raw = (entry[2] ?? '').trim();
    if (raw === '') {
      frontmatter[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    frontmatter[key] = scalarMock(raw);
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

function scalarMock(raw: string): string | number | boolean {
  const unquoted = raw.replace(/^['"]|['"]$/gu, '');
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^-?\d+$/u.test(unquoted)) return Number(unquoted);
  return unquoted;
}

/**
 * 整份 SKILL.md 的最小校验：真实规则在 `packages/contract` 的 `skillFrontmatterSchema`。
 * 这里只挡住「一眼就不是 SKILL.md」的输入，让 400 + `SKILL_FRONTMATTER_INVALID`
 * 这条错误路径在面板上可以复现（面板的错误文案就靠它验证）。
 */
export function validateSkillTextMock(text: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/u.exec(text);
  if (match === null) return ['缺少 YAML frontmatter（必须以 --- 开头、--- 结尾）'];

  const block = match[1] ?? '';
  const problems: string[] = [];
  const name = (/^name:\s*(.+)$/mu.exec(block)?.[1] ?? '').trim().replace(/^['"]|['"]$/gu, '');
  if (!/^\/[a-z][a-z0-9-]{0,62}$/u.test(name)) {
    problems.push(`name 不合法：${name === '' ? '（缺失）' : name}`);
  }
  const description = (/^description:\s*(.+)$/mu.exec(block)?.[1] ?? '').trim();
  if (description.length < 10) problems.push('description 至少 10 个字符且必须单行');
  if (!/^outputs:/mu.test(block)) problems.push('缺少 outputs');
  return problems;
}

/** `PUT /api/skills/:id`：整份覆盖（版本 +1，frontmatter 与正文一起换）。 */
export function saveSkillTextMock(id: string, text: string): SkillDetail | null {
  const record = records.get(id);
  if (record === undefined) return null;

  const parsed = parseSkillTextMock(text);
  const description = parsed.frontmatter['description'];
  const updatedAt = new Date().toISOString();
  const next: SkillDetail = {
    ...record.detail,
    updatedAt,
    currentVersion: record.detail.currentVersion + 1,
    frontmatter:
      Object.keys(parsed.frontmatter).length === 0 ? record.detail.frontmatter : parsed.frontmatter,
    body: parsed.body,
    description:
      typeof description === 'string' && description !== '' ? description : record.detail.description,
  };

  record.detail = next;
  record.text = text;
  record.fileTexts = replaceFileText(record.fileTexts, 'SKILL.md', text);
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
  return next;
}
/**
 * `POST /api/skills`：真正解包不在面板 mock 的范围里，这里只按字节数决定版本号，
 * 让「同项目同名再传 = 版本 +1」这条交互在页面上看得见。
 *
 * `repo` 由 handler 校验后传入（缺失就是 400，绝不会走到这里）。
 */
export function uploadSkillMock(bytes: Uint8Array, repo: string): SkillUploadResponse {
  // 不同项目是不同的技能行：id 里带仓库，免得「传了 A 项目、B 项目也跟着变」
  const slug = repo.replace(/[^A-Za-z0-9]+/gu, '-');
  const id = `sk-uploaded-demo-${slug}`;
  const existing = records.get(id);
  const name = '/uploaded-demo';
  const validation: SkillValidation = { ok: true, errors: [], warnings: [] };
  const version = existing === undefined ? 1 : existing.detail.currentVersion + 1;
  const files = [fileMeta('SKILL.md', bytes.byteLength), fileMeta('assets/README.md', 180)];

  const detail: SkillDetail = {
    id,
    name,
    description: '面板上传的示例技能（mock：真实内容在 zip 里，面板只展示元数据）。',
    scope: 'repo',
    repo,
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

  records.set(id, { detail, versions, fileTexts: seededFiles(detail) });
  return { skill: toListItem(detail), version, validation };
}


/* ── 模态框编辑器：按文件读写 + 多技能导入（docs/plan-skill-editor-modal.md） ───────── */

/**
 * 技能内相对路径的规范化 —— 与 `apps/server/src/skills/files.ts::normalizeSkillFilePath` 同规则
 * （无绝对路径 / 无 `.` `..` / 每段 `[A-Za-z0-9._-]{1,80}`）。
 * 面板这一层只为「非法目标先在树上标出来」，真正的门禁仍在服务端（400 原文照显示）。
 */
function normalizeSkillFilePathMock(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/gu, '/');
  if (trimmed === '' || trimmed.length > 300 || trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9._-]{1,80}$/u.test(segment))) return null;
  return segments.join('/');
}

/** 文件全文列表 → meta（字节按 UTF-8 现算；sha256 仍是假值，契约只约束长度与字符集）。 */
function skillFilesMeta(files: readonly SkillFileText[]): SkillFileMeta[] {
  return [...files]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map((file) => fileMeta(file.path, utf8ByteLength(file.text)));
}

/** 替换（或追加）一个文件，返回新数组（不改入参）。 */
function replaceFileText(files: readonly SkillFileText[], path: string, text: string): SkillFileText[] {
  return [...files.filter((file) => file.path !== path), { path, text }];
}

/** `GET /api/skills/:id/files` 的数据源。 */
export function skillFilesMock(id: string): SkillFilesResponse | null {
  const record = records.get(id);
  if (record === undefined) return null;
  return {
    generatedAt: new Date().toISOString(),
    skillId: id,
    files: record.fileTexts.map((file) => ({ path: file.path, text: file.text })),
  };
}

export type SkillFileWriteResult =
  | { readonly ok: true; readonly detail: SkillDetail }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/**
 * `PUT /api/skills/:id/files`：替换一个文件 → 版本号 +1。
 *
 * 这三条 400 的**文案与真实服务端一致**（面板就是靠它们验证「服务端原文照显示」）：
 * 非法路径 / 非文本扩展名 / 改了技能名 / 校验不通过。
 */
export function saveSkillFileMock(id: string, write: { path: string; text: string }): SkillFileWriteResult {
  const record = records.get(id);
  if (record === undefined) {
    return { ok: false, status: 404, code: 'not-found', message: `技能不存在：${id}` };
  }

  const path = normalizeSkillFilePathMock(write.path);
  if (path === null) {
    return { ok: false, status: 400, code: 'bad-request', message: `非法的文件路径：${write.path.slice(0, 120)}` };
  }
  if (!isEditableSkillPath(path)) {
    return {
      ok: false,
      status: 400,
      code: 'bad-request',
      message: `只支持编辑文本文件（md / txt / json / yaml / toml）：${path}`,
    };
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string } | null = null;
  if (path === 'SKILL.md') {
    const problems = validateSkillTextMock(write.text);
    if (problems.length > 0) {
      return { ok: false, status: 400, code: 'bad-request', message: `技能校验不通过：${problems.join('；')}` };
    }
    parsed = parseSkillTextMock(write.text);
    const name = typeof parsed.frontmatter['name'] === 'string' ? parsed.frontmatter['name'] : '';
    if (name !== record.detail.name) {
      return {
        ok: false,
        status: 400,
        code: 'bad-request',
        message: `不允许在编辑器里改技能名（当前 ${record.detail.name}，收到 ${name}）：请新建技能后再删旧的`,
      };
    }
  }

  const fileTexts = replaceFileText(record.fileTexts, path, write.text);
  const files = skillFilesMeta(fileTexts);
  const version = record.detail.currentVersion + 1;
  const updatedAt = new Date().toISOString();
  const description = parsed === null ? record.detail.description : parsed.frontmatter['description'];

  const detail: SkillDetail = {
    ...record.detail,
    currentVersion: version,
    updatedAt,
    sizeBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    ...(parsed === null ? {} : { frontmatter: parsed.frontmatter, body: parsed.body }),
    description:
      typeof description === 'string' && description !== ''
        ? description.slice(0, 200)
        : record.detail.description,
    treeSha256: fakeSha(`${record.detail.id}-v${String(version)}`),
  };

  record.detail = detail;
  record.fileTexts = fileTexts;
  if (path === 'SKILL.md') record.text = write.text;
  record.versions = [
    ...record.versions,
    {
      version,
      treeSha256: detail.treeSha256,
      files,
      validation: detail.validation,
      createdAt: updatedAt,
    },
  ];
  return { ok: true, detail };
}

/**
 * `POST /api/skills/:id/versions`：zip 覆盖**这一个**技能（名字是否一致由服务端判定）。
 *
 * mock 不解 zip：只把版本号 +1，并在 `validation.warnings` 里说清这件事，
 * 免得「覆盖成功但文件没变」看起来像 bug。
 */
export function overwriteSkillMock(id: string, bytes: Uint8Array): SkillUploadResponse | null {
  const record = records.get(id);
  if (record === undefined) return null;

  const version = record.detail.currentVersion + 1;
  const updatedAt = new Date().toISOString();
  const validation: SkillValidation = {
    ok: true,
    errors: [],
    warnings: [`（mock）zip 未真正解包（${String(bytes.byteLength)} 字节），文件内容沿用旧版`],
  };
  const detail: SkillDetail = {
    ...record.detail,
    currentVersion: version,
    updatedAt,
    validation,
    treeSha256: fakeSha(`${record.detail.id}-zip-v${String(version)}`),
  };
  record.detail = detail;
  record.versions = [
    ...record.versions,
    {
      version,
      treeSha256: detail.treeSha256,
      files: detail.files,
      validation,
      createdAt: updatedAt,
    },
  ];
  return { skill: toListItem(detail), version, validation };
}

/**
 * zip 里的技能目录名：zip 的中央目录把路径**未压缩**地存着，所以按 latin1 读原始字节
 * 再扫 `…/SKILL.md` 就能拿到 `alpha` / `beta` 这样的目录名（同名去重）。
 *
 * 这是 mock 的近似（真实解包在服务端）：正则只收安全字符，二进制垃圾基本进不来。
 */
function skillDirsInZip(bytes: Uint8Array): string[] {
  const text = new TextDecoder('latin1').decode(bytes);
  const dirs = new Set<string>();
  for (const match of text.matchAll(/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/SKILL\.md/gu)) {
    const segments = (match[1] ?? '').split('/').filter((segment) => segment !== '');
    const dir = segments.at(-1) ?? '';
    if (dir !== '') dirs.add(dir);
  }
  return [...dirs];
}

/** 目录名 → 存储名（`/xxx`）；不符合 `SKILL_NAME_RE` 的返回 `null`（该目录只报错不导入）。 */
function skillNameOfDir(dir: string): string | null {
  const normalized = dir.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{0,62}$/u.test(normalized) ? `/${normalized}` : null;
}

/**
 * `POST /api/skills/import`：一个 zip 里每个含 `SKILL.md` 的目录 = 一个技能。
 *
 * 同项目同名覆盖成新版本（`created=false`），这正是「上传 zip 新增/覆盖」的语义；
 * 目录名不能当技能名的只进 `errors`，其余照常导入（部分成功是常态）。
 *
 * `repo` 由 handler 校验后传入（缺失就是 400，绝不会走到这里）。
 */
export function importSkillsMock(
  bytes: Uint8Array,
  repo: string,
  enabled = true,
): SkillImportResponse {

  const imported: SkillImportResponse['imported'] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const dirs = skillDirsInZip(bytes);
  if (dirs.length === 0) {
    errors.push('zip 里没有找到任何 SKILL.md：请把「技能目录/SKILL.md」按目录打进 zip');
  }

  for (const dir of dirs.slice(0, 50)) {
    const name = skillNameOfDir(dir);
    if (name === null) {
      errors.push(`${dir}/SKILL.md：目录名不能作为技能名（需小写字母/数字/连字符，且以字母开头）`);
      continue;
    }

    const slug = name.replace(/^\//u, '');
    const repoSlug = `-${repo.replace(/[^A-Za-z0-9]+/gu, '-')}`;
    const id = `sk-import-${slug}${repoSlug}`;
    const existing = records.get(id);
    const version = existing === undefined ? 1 : existing.detail.currentVersion + 1;
    const description = `（mock 导入）来自 zip 目录 ${dir} 的技能。`;
    const detail: SkillDetail = {
      id,
      name,
      description,
      scope: 'repo',
      repo,
      source: 'upload',
      enabled,
      currentVersion: version,
      overriddenBy: null,
      sizeBytes: 0,
      updatedAt: new Date().toISOString(),
      frontmatter: { name, description, 'allowed-tools': ['Read'], outputs: ['comment'] },
      body: `（mock）${dir}/SKILL.md 的正文。\n`,
      files: [],
      validation: { ok: true, errors: [], warnings: [] },
      treeSha256: fakeSha(`import-${slug}-v${String(version)}`),
    };
    const fileTexts = seededFiles(detail);
    detail.files = skillFilesMeta(fileTexts);
    detail.sizeBytes = detail.files.reduce((sum, file) => sum + file.bytes, 0);

    records.set(id, {
      detail,
      fileTexts,
      versions: [
        ...(existing?.versions ?? []),
        {
          version,
          treeSha256: detail.treeSha256,
          files: detail.files,
          validation: detail.validation,
          createdAt: detail.updatedAt,
        },
      ],
    });

    imported.push({ id, name, version, created: existing === undefined });
    if (existing !== undefined) warnings.push(`同名技能已存在，已覆盖成新版本：${name}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    imported,
    errors: errors.slice(0, 50),
    warnings: [...new Set(warnings)].slice(0, 50),
  };
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

/**
 * 写 zip 接口共用的三道闸（`POST /api/skills`、`/:id/versions`、`/import` 完全一致）：
 * `Content-Type: application/zip` → ≤5 MB → `PK` 魔数。返回 `Response` 表示被拒。
 */
async function readZipBytes(request: Request): Promise<Uint8Array | Response> {
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
  return bytes;
}

/**
 * 写接口的 `repo` 闸：技能只属于项目，缺 `?repo=owner/name` 一律 400。
 * 返回 `Response` 表示被拒（与 `readZipBytes` 同一个约定）。
 */
function requireRepo(request: Request): string | Response {
  const repo = new URL(request.url).searchParams.get('repo') ?? '';
  if (repo.trim() === '') {
    return errorResponse(400, 'bad-request', '缺少 repo：技能只属于项目，必须带 ?repo=owner/name');
  }
  return repo;
}

export const skillsHandlers: HttpHandler[] = [
  // 具体路径在前（`/versions` / `/files` / `/import` 不会被 `/api/skills/:id` 抢走，
  // 但顺序约定与 index.ts 一致：段数多的在前）

  /** 技能目录里每个文本文件的全文（模态框左树右编辑器）。 */
  http.get('/api/skills/:id/files', ({ params }) => {
    const result = skillFilesMock(String(params.id));
    if (result === null) return errorResponse(404, 'not-found', '技能不存在');
    return scenarioResponse({ data: result });
  }),

  /**
   * 保存一个文件 → 200 裸 `SkillDetail`（不是 `{ skill }`，与真实服务端一致）。
   * 400 的 `message` 直接来自 mock 的同一份纯函数，测试据此断言「服务端原文照显示」。
   */
  http.put('/api/skills/:id/files', async ({ request, params }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const body = (await request.json()) as { path?: unknown; text?: unknown };
    if (typeof body.path !== 'string' || typeof body.text !== 'string') {
      return errorResponse(400, 'bad-request', 'body 必须是 { path: string, text: string }');
    }
    const result = saveSkillFileMock(String(params.id), { path: body.path, text: body.text });
    if (!result.ok) return errorResponse(result.status, result.code, result.message);
    return HttpResponse.json(result.detail);
  }),

  /** 一个 zip 里多个技能目录的批量导入（部分成功也是 200；`repo` 必填）。 */
  http.post('/api/skills/import', async ({ request }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const repo = requireRepo(request);
    if (repo instanceof Response) return repo;

    const bytes = await readZipBytes(request);
    if (bytes instanceof Response) return bytes;
    const enabled = new URL(request.url).searchParams.get('enabled') !== 'false';
    return HttpResponse.json(importSkillsMock(bytes, repo, enabled));
  }),

  /** 用 zip 覆盖**这一个**技能（同名才能覆盖，名字不一致由真实服务端拒绝）。 */
  http.post('/api/skills/:id/versions', async ({ request, params }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const bytes = await readZipBytes(request);
    if (bytes instanceof Response) return bytes;
    const result = overwriteSkillMock(String(params.id), bytes);
    if (result === null) return errorResponse(404, 'not-found', '技能不存在');
    return HttpResponse.json(result, { status: 201 });
  }),

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

  /** 上传 zip（原始二进制；`repo` 必填，缺失 400）。 */
  http.post('/api/skills', async ({ request }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const repo = requireRepo(request);
    if (repo instanceof Response) return repo;

    const bytes = await readZipBytes(request);
    if (bytes instanceof Response) return bytes;

    return HttpResponse.json(uploadSkillMock(bytes, repo), { status: 201 });
  }),

  // 整份 SKILL.md 覆盖保存（`{ text }` → `{ skill }`）：与 PATCH 的分工见 `lib/api.ts`
  http.put('/api/skills/:id', async ({ request, params }) => {
    const rejected = csrfRejected(request);
    if (rejected !== null) return rejected;

    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== 'string') {
      return errorResponse(400, 'bad-request', 'body 必须是 { text: string }');
    }
    const problems = validateSkillTextMock(body.text);
    if (problems.length > 0) {
      return errorResponse(400, 'SKILL_FRONTMATTER_INVALID', problems.join('；'));
    }
    const detail = saveSkillTextMock(String(params.id), body.text);
    if (detail === null) return errorResponse(404, 'not-found', '技能不存在');
    return HttpResponse.json({ skill: detail });
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

    // ?hard=true 只对面板上传的技能有效（内置副本不能硬删：会被重新播种）
    if (new URL(request.url).searchParams.get('hard') === 'true' && record.source !== 'upload') {
      return errorResponse(409, 'conflict', '内置技能不能硬删（先停用）');
    }

    deleteSkillMock(id);
    return new HttpResponse(null, { status: 204 });
  }),
];
