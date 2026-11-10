/**
 * 技能的持久化（PG + 磁盘）—— `docs/spec/skill-management.md` §5/§6 的实现。
 *
 * 三层职责别混：
 *  - `bundle.ts`：一个 zip → 一个「技能包」（纯内存，不落盘、不碰库）。
 *  - **本文件**：技能包 → 库里三行 + 磁盘上一棵目录树。唯一做 I/O 的地方。
 *  - `http/api/skills.ts`：鉴权、CSRF、zod 序列化，不写 SQL。
 *
 * 四条实现约定：
 *  1. **只参数化 SQL**；`jsonb` 列显式 `JSON.stringify` + `::jsonb`（`pg` 会把 JS 数组按
 *     Postgres 数组编码成 `{a,b}`，直接塞 jsonb 列就是坏数据）。
 *  2. **磁盘先写、库后写**：库失败最多留一个孤儿版本目录（下次覆盖同名版本会重建），
 *     反过来「库里有版本、盘上没文件」会让装配期读到空正文，更难查。
 *  3. **正文只存盘**：`skill_versions.files` 只存 `{path,bytes,sha256}` 清单（§5）。
 *  4. **每个写动作都进 `skills_audit`**：上传即生效且没有审批流（spec D0/D6），
 *     审计是唯一的事后追溯手段。
 *
 * 已知边界（写在这里而不是留在人脑子里）：
 *  - `patch({description})` 只改库里的 `skills.description`，**不回写磁盘 SKILL.md 的
 *    frontmatter**（本包不引 yaml 库，回写 YAML 没有可靠做法）。正文与提示词不受影响。
 *  - 本表只管理**面板上传**的技能；内置与仓库文件技能是只读的，仍由 `/api/system` 展示。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

import type {
  SkillDetail,
  SkillFileMeta,
  SkillListItem,
  SkillPatch,
  SkillScope,
  SkillSourceKind,
  SkillValidation,
  SkillVersion,
} from '../../../../packages/contract/src/index.ts';
import type { SqlExecutor } from '../db/index.ts';
import type { SkillBundle } from './bundle.ts';
import { splitFrontmatter } from './frontmatter.ts';

/** 审计动作（`skills_audit.action`）。取值刻意与 HTTP 动词不同名：它描述**语义**，不是路由。 */
export type SkillAuditAction =
  | 'upload'
  | 'new-version'
  | 'enable'
  | 'disable'
  | 'edit-description'
  | 'edit-body'
  | 'rollback'
  | 'delete'
  | 'purge';

/** 存储层的失败。HTTP 层负责翻译成契约错误码（`invalid-skill` → 400、`conflict` → 409 等）。 */
export class SkillStoreError extends Error {
  readonly code: 'invalid-skill' | 'not-found' | 'conflict' | 'bad-request';

  constructor(code: 'invalid-skill' | 'not-found' | 'conflict' | 'bad-request', message: string) {
    super(message);
    this.name = 'SkillStoreError';
    this.code = code;
  }
}

export interface SkillStoreOptions {
  readonly pool: SqlExecutor;
  /** `PI_BOT_DATA_DIR`：技能内容落 `<dataDir>/skills/<id>/<version>/`。 */
  readonly dataDir: string;
  readonly now?: () => Date;
}

export type SkillListFilter = {
  readonly scope?: SkillScope;
  readonly repo?: string;
  readonly enabled?: boolean;
  readonly source?: SkillSourceKind;
};

export type SkillUploadInput = {
  readonly bundle: SkillBundle;
  readonly scope: SkillScope;
  readonly repo: string | null;
  readonly enabled: boolean;
  readonly actor: string | null;
};

export type SkillUploadResult = {
  readonly skill: SkillListItem;
  readonly version: number;
  readonly validation: SkillValidation;
  readonly created: boolean;
};

/** 装配期需要的最小形状：与 `skills/types.ts` 的 `SkillFile` 同形（path + text）。 */
export type SkillFileText = { readonly path: string; readonly text: string };

export interface SkillStore {
  list(filter?: SkillListFilter): Promise<SkillListItem[]>;
  get(id: string): Promise<SkillDetail | null>;
  versions(id: string): Promise<SkillVersion[]>;
  upload(input: SkillUploadInput): Promise<SkillUploadResult>;
  patch(input: { id: string; patch: SkillPatch; actor: string | null }): Promise<SkillDetail | null>;
  remove(input: { id: string; hard: boolean; actor: string | null }): Promise<boolean>;
  rollback(input: { id: string; version: number; actor: string | null }): Promise<SkillVersion | null>;
  /**
   * 装配用：把「当前启用的上传技能」按优先级（仓库 > 全局）读成 `{path,text}` 列表。
   * 正文只在 SKILL.md 里，所以这里做一次磁盘读；调用方（enricher）只关心顺序。
   */
  activeSkillFiles(repo: string | null): Promise<SkillFileText[]>;
  /** 当前启用的上传技能名（`['/demo']`）：供 webhook 的命令门禁放行。 */
  activeSkillNames(repo: string | null): Promise<string[]>;
}

/* ── 行形状 ──────────────────────────────────────────────────────────────── */

type SkillRow = {
  id: string;
  name: string;
  scope: string;
  repo: string | null;
  source: string;
  enabled: boolean;
  current_version: number;
  description: string;
  frontmatter: unknown;
  updated_at: Date | string;
};

type VersionRow = {
  version: number;
  files: unknown;
  tree_sha256: string;
  validation: unknown;
  created_at: Date | string;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const asFiles = (value: unknown): SkillFileMeta[] => {
  if (!Array.isArray(value)) return [];
  const out: SkillFileMeta[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record['path'] === 'string' ? record['path'] : null;
    const sha256 = typeof record['sha256'] === 'string' ? record['sha256'] : null;
    const bytes = typeof record['bytes'] === 'number' ? record['bytes'] : 0;
    if (path === null || sha256 === null) continue;
    out.push({ path, bytes, sha256 });
  }
  return out;
};

const asValidation = (value: unknown): SkillValidation => {
  const empty: SkillValidation = { ok: true, errors: [], warnings: [] };
  if (value === null || typeof value !== 'object') return empty;
  const record = value as Record<string, unknown>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  return {
    ok: record['ok'] === true,
    errors: strings(record['errors']),
    warnings: strings(record['warnings']),
  };
};

/** 目录树哈希：`path\0sha256\n` 排序串接后再 sha256（与 `bundle.ts` 的算法必须一致）。 */
export function treeHashOf(files: readonly SkillFileMeta[]): string {
  const lines = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.sha256}\n`)
    .join('');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

const sha256Hex = (buffer: Buffer | string): string => createHash('sha256').update(buffer).digest('hex');

/* ── 实现 ────────────────────────────────────────────────────────────────── */

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  const pool = options.pool;
  const dataDir = options.dataDir;
  const now = options.now ?? ((): Date => new Date());

  const skillsRoot = (): string => nodePath.join(dataDir, 'skills');
  const versionDir = (skillId: string, version: number): string =>
    nodePath.join(skillsRoot(), skillId, String(version));

  /** 写一棵版本目录。路径已经过 `bundle.ts` 规范化，这里再做一次「不许逃逸」的兜底断言。 */
  async function writeVersionTree(
    skillId: string,
    version: number,
    files: readonly { path: string; text: string }[],
  ): Promise<void> {
    const dir = versionDir(skillId, version);
    await mkdir(dir, { recursive: true });
    const rootWithSep = dir.endsWith(nodePath.sep) ? dir : `${dir}${nodePath.sep}`;
    for (const file of files) {
      const target = nodePath.resolve(dir, file.path);
      if (!target.startsWith(rootWithSep)) {
        throw new SkillStoreError('bad-request', `技能文件路径逃出目录：${file.path}`);
      }
      await mkdir(nodePath.dirname(target), { recursive: true });
      await writeFile(target, file.text, 'utf8');
    }
  }

  /** 把 `<id>/<version>/` 整棵读回内存（回滚与正文补丁都要用）。 */
  async function readVersionTree(
    skillId: string,
    version: number,
    files: readonly SkillFileMeta[],
  ): Promise<{ path: string; text: string }[]> {
    const dir = versionDir(skillId, version);
    const out: { path: string; text: string }[] = [];
    for (const file of files) {
      out.push({ path: file.path, text: await readFile(nodePath.join(dir, file.path), 'utf8') });
    }
    return out;
  }

  async function audit(input: {
    skillId: string;
    action: SkillAuditAction;
    actor: string | null;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      'insert into skills_audit (skill_id, action, actor, detail) values ($1, $2, $3, $4::jsonb)',
      [input.skillId, input.action, input.actor, JSON.stringify(input.detail)],
    );
  }

  const SELECT_COLUMNS = `s.id, s.name, s.scope, s.repo, s.source, s.enabled,
       s.current_version, s.description, s.frontmatter, s.updated_at`;

  async function rowById(id: string): Promise<SkillRow | null> {
    const result = await pool.query(
      `select ${SELECT_COLUMNS} from skills s where s.id = $1 and s.deleted_at is null`,
      [id],
    );
    const rows = result.rows as SkillRow[];
    return rows[0] ?? null;
  }

  async function versionByNumber(id: string, version: number): Promise<VersionRow | null> {
    const result = await pool.query(
      'select version, files, tree_sha256, validation, created_at from skill_versions where skill_id = $1 and version = $2',
      [id, version],
    );
    const rows = result.rows as VersionRow[];
    return rows[0] ?? null;
  }

  async function currentVersionRow(id: string, currentVersion: number): Promise<VersionRow | null> {
    return versionByNumber(id, currentVersion);
  }

  /** 行 + 当前版本 → 列表项。`overriddenBy` 由 `list()` 统一补。 */
  function toListItem(row: SkillRow, files: readonly SkillFileMeta[], overriddenBy: string | null): SkillListItem {
    const sizeBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      scope: row.scope === 'repo' ? 'repo' : 'global',
      repo: row.repo,
      source: row.source === 'repo-file' || row.source === 'builtin' ? row.source : 'upload',
      enabled: row.enabled,
      currentVersion: row.current_version,
      overriddenBy,
      sizeBytes,
      updatedAt: iso(row.updated_at),
    };
  }

  return {
    async list(filter = {}) {
      const result = await pool.query(
        `select ${SELECT_COLUMNS}, v.files
           from skills s
           left join skill_versions v on v.skill_id = s.id and v.version = s.current_version
          where s.deleted_at is null
            and ($1::text is null or s.scope = $1)
            and ($2::text is null or s.repo = $2)
            and ($3::boolean is null or s.enabled = $3)
            and ($4::text is null or s.source = $4)
          order by s.name asc, s.scope asc`,
        [
          filter.scope ?? null,
          filter.repo ?? null,
          filter.enabled ?? null,
          filter.source ?? null,
        ],
      );
      const rows = result.rows as (SkillRow & { files: unknown })[];

      // 覆盖关系（§7 优先级：面板-仓库 > 面板全局 > 仓库文件 > 内置）。
      // 本表只有上传技能，所以「高优先级」= 同名且启用的 repo 作用域行压过 global 行。
      const winnerByName = new Map<string, string>();
      for (const row of rows) {
        if (!row.enabled) continue;
        const current = winnerByName.get(row.name);
        if (current === undefined) {
          winnerByName.set(row.name, row.id);
          continue;
        }
        const currentIsRepo = rows.find((candidate) => candidate.id === current)?.scope === 'repo';
        if (!currentIsRepo && row.scope === 'repo') winnerByName.set(row.name, row.id);
      }

      return rows.map((row) => {
        const winner = winnerByName.get(row.name);
        const overriddenBy = row.enabled && winner !== undefined && winner !== row.id ? winner : null;
        return toListItem(row, asFiles(row.files), overriddenBy);
      });
    },

    async get(id) {
      const row = await rowById(id);
      if (row === null) return null;
      const version = await currentVersionRow(id, row.current_version);
      const files = asFiles(version?.files);
      const skillMd = files.find((file) => file.path === 'SKILL.md');
      let body = '';
      if (skillMd !== undefined) {
        try {
          const text = await readFile(nodePath.join(versionDir(id, row.current_version), 'SKILL.md'), 'utf8');
          const split = splitFrontmatter(text);
          body = split.ok ? split.body.trim() : text.trim();
        } catch {
          body = '';
        }
      }
      const frontmatter =
        row.frontmatter !== null && typeof row.frontmatter === 'object'
          ? (row.frontmatter as Record<string, unknown>)
          : {};
      return {
        ...toListItem(row, files, null),
        frontmatter,
        body,
        files,
        validation: asValidation(version?.validation),
        treeSha256: version?.tree_sha256 ?? treeHashOf(files),
      };
    },

    async versions(id) {
      const result = await pool.query(
        'select version, files, tree_sha256, validation, created_at from skill_versions where skill_id = $1 order by version desc',
        [id],
      );
      return (result.rows as VersionRow[]).map((row) => ({
        version: row.version,
        treeSha256: row.tree_sha256,
        files: asFiles(row.files),
        validation: asValidation(row.validation),
        createdAt: iso(row.created_at),
      }));
    },

    async upload(input) {
      const { bundle } = input;
      if (!bundle.validation.ok) {
        throw new SkillStoreError('invalid-skill', bundle.validation.errors.join('；'));
      }
      if (bundle.name === '' || !bundle.name.startsWith('/')) {
        throw new SkillStoreError('invalid-skill', `技能名不合规：${bundle.name}`);
      }
      if (input.scope === 'repo' && (input.repo === null || input.repo === '')) {
        throw new SkillStoreError('bad-request', 'scope=repo 时必须给 repo=owner/name');
      }

      const files: SkillFileMeta[] = bundle.files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      }));
      const treeSha = bundle.treeSha256 === '' ? treeHashOf(files) : bundle.treeSha256;
      const repo = input.scope === 'repo' ? input.repo : null;

      const existing = await pool.query(
        `select id, current_version, scope from skills
          where name = $1 and scope = $2 and coalesce(repo, '') = coalesce($3, '') and deleted_at is null`,
        [bundle.name, input.scope, repo],
      );
      const found = (existing.rows as { id: string; current_version: number }[])[0];

      if (found === undefined) {
        const id = randomUUID();
        const version = 1;
        await writeVersionTree(id, version, bundle.files);
        await pool.query(
          `insert into skills (id, name, scope, repo, source, enabled, current_version, description, frontmatter, created_by, created_at, updated_at)
           values ($1, $2, $3, $4, 'upload', $5, $6, $7, $8::jsonb, $9, $10, $10)`,
          [
            id,
            bundle.name,
            input.scope,
            repo,
            input.enabled,
            version,
            bundle.description === '' ? bundle.name : bundle.description,
            JSON.stringify(bundle.frontmatter),
            input.actor,
            now(),
          ],
        );
        await pool.query(
          `insert into skill_versions (skill_id, version, files, tree_sha256, validation, created_by, created_at)
           values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
          [
            id,
            version,
            JSON.stringify(files),
            treeSha,
            JSON.stringify(bundle.validation),
            input.actor,
            now(),
          ],
        );
        await audit({
          skillId: id,
          action: 'upload',
          actor: input.actor,
          detail: {
            name: bundle.name,
            scope: input.scope,
            repo,
            enabled: input.enabled,
            version,
            treeSha256: treeSha,
            files: files.length,
            bytes: files.reduce((sum, file) => sum + file.bytes, 0),
          },
        });
        const created = await rowById(id);
        if (created === null) throw new SkillStoreError('not-found', '刚插入的技能读不回来');
        return {
          skill: toListItem(created, files, null),
          version,
          validation: bundle.validation,
          created: true,
        };
      }

      // 同名同作用域已存在 → 新版本（上传即新的 current_version，spec R4）。
      const version = found.current_version + 1;
      await writeVersionTree(found.id, version, bundle.files);
      await pool.query(
        `update skills set current_version = $2, description = $3, frontmatter = $4::jsonb,
                enabled = $5, source = 'upload', updated_at = $6
          where id = $1`,
        [
          found.id,
          version,
          bundle.description === '' ? bundle.name : bundle.description,
          JSON.stringify(bundle.frontmatter),
          input.enabled,
          now(),
        ],
      );
      await pool.query(
        `insert into skill_versions (skill_id, version, files, tree_sha256, validation, created_by, created_at)
         values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
        [found.id, version, JSON.stringify(files), treeSha, JSON.stringify(bundle.validation), input.actor, now()],
      );
      await audit({
        skillId: found.id,
        action: 'new-version',
        actor: input.actor,
        detail: {
          name: bundle.name,
          version,
          treeSha256: treeSha,
          files: files.length,
          bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        },
      });
      const updated = await rowById(found.id);
      if (updated === null) throw new SkillStoreError('not-found', '刚更新的技能读不回来');
      return { skill: toListItem(updated, files, null), version, validation: bundle.validation, created: false };
    },

    async patch(input) {
      const row = await rowById(input.id);
      if (row === null) return null;
      const patch = input.patch;

      if (patch.enabled !== undefined && patch.enabled !== row.enabled) {
        await pool.query('update skills set enabled = $2, updated_at = $3 where id = $1', [
          input.id,
          patch.enabled,
          now(),
        ]);
        await audit({
          skillId: input.id,
          action: patch.enabled ? 'enable' : 'disable',
          actor: input.actor,
          detail: { name: row.name, enabled: patch.enabled },
        });
      }

      if (patch.description !== undefined && patch.description !== row.description) {
        await pool.query('update skills set description = $2, updated_at = $3 where id = $1', [
          input.id,
          patch.description,
          now(),
        ]);
        await audit({
          skillId: input.id,
          action: 'edit-description',
          actor: input.actor,
          detail: { from: row.description, to: patch.description },
        });
      }

      if (patch.body !== undefined) {
        const nextBody = patch.body.trim();
        if (nextBody === '') throw new SkillStoreError('bad-request', '正文不能为空');
        const version = await currentVersionRow(input.id, row.current_version);
        const files = asFiles(version?.files);
        const tree = await readVersionTree(input.id, row.current_version, files);
        const skillMdIndex = tree.findIndex((file) => file.path === 'SKILL.md');
        const original = skillMdIndex >= 0 ? (tree[skillMdIndex]?.text ?? '') : '';
        const split = splitFrontmatter(original);
        // 保留原 frontmatter 原文（本包不引 yaml，回写 YAML 没有可靠做法），只换正文。
        const frontmatterBlock = split.ok ? original.slice(0, original.length - split.body.length) : '';
        const nextSkillMd = `${frontmatterBlock}${nextBody}\n`;

        const nextFilesText: { path: string; text: string }[] = tree.map((file) =>
          file.path === 'SKILL.md' ? { path: 'SKILL.md', text: nextSkillMd } : file,
        );
        if (skillMdIndex < 0) nextFilesText.push({ path: 'SKILL.md', text: nextSkillMd });

        const nextMeta: SkillFileMeta[] = nextFilesText.map((file) => ({
          path: file.path,
          bytes: Buffer.byteLength(file.text, 'utf8'),
          sha256: sha256Hex(file.text),
        }));
        const treeSha = treeHashOf(nextMeta);
        const nextVersion = row.current_version + 1;
        await writeVersionTree(input.id, nextVersion, nextFilesText);
        await pool.query(
          `insert into skill_versions (skill_id, version, files, tree_sha256, validation, created_by, created_at)
           values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
          [
            input.id,
            nextVersion,
            JSON.stringify(nextMeta),
            treeSha,
            JSON.stringify({ ok: true, errors: [], warnings: [] }),
            input.actor,
            now(),
          ],
        );
        await pool.query('update skills set current_version = $2, updated_at = $3 where id = $1', [
          input.id,
          nextVersion,
          now(),
        ]);
        await audit({
          skillId: input.id,
          action: 'edit-body',
          actor: input.actor,
          detail: { name: row.name, version: nextVersion, treeSha256: treeSha, bytes: nextMeta.reduce((s, f) => s + f.bytes, 0) },
        });
      }

      return this.get(input.id);
    },

    async remove(input) {
      const row = await rowById(input.id);
      if (row === null) return false;
      if (input.hard) {
        if (row.source !== 'upload') {
          throw new SkillStoreError('conflict', '只有面板上传的技能能硬删；内置/仓库文件技能是只读的');
        }
        await pool.query('delete from skill_versions where skill_id = $1', [input.id]);
        await pool.query('delete from skills where id = $1', [input.id]);
        await rm(nodePath.join(skillsRoot(), input.id), { recursive: true, force: true });
        await audit({
          skillId: input.id,
          action: 'purge',
          actor: input.actor,
          detail: { name: row.name, scope: row.scope, repo: row.repo },
        });
        return true;
      }
      await pool.query('update skills set deleted_at = $2, enabled = false, updated_at = $2 where id = $1', [
        input.id,
        now(),
      ]);
      await audit({
        skillId: input.id,
        action: 'delete',
        actor: input.actor,
        detail: { name: row.name, scope: row.scope, repo: row.repo, soft: true },
      });
      return true;
    },

    async rollback(input) {
      const row = await rowById(input.id);
      if (row === null) return null;
      const target = await versionByNumber(input.id, input.version);
      if (target === null) return null;
      const files = asFiles(target.files);
      const tree = await readVersionTree(input.id, input.version, files);
      const nextVersion = row.current_version + 1;
      await writeVersionTree(input.id, nextVersion, tree);
      await pool.query(
        `insert into skill_versions (skill_id, version, files, tree_sha256, validation, created_by, created_at)
         values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
        [
          input.id,
          nextVersion,
          JSON.stringify(files),
          target.tree_sha256,
          JSON.stringify(target.validation),
          input.actor,
          now(),
        ],
      );
      await pool.query('update skills set current_version = $2, updated_at = $3 where id = $1', [
        input.id,
        nextVersion,
        now(),
      ]);
      await audit({
        skillId: input.id,
        action: 'rollback',
        actor: input.actor,
        detail: { name: row.name, from: row.current_version, to: input.version, createdVersion: nextVersion },
      });
      return {
        version: nextVersion,
        treeSha256: target.tree_sha256,
        files,
        validation: asValidation(target.validation),
        createdAt: now().toISOString(),
      };
    },

    /** 当前启用的上传技能名：webhook 的命令门禁靠它放行（`/demo` 不必进仓库配置）。 */
    async activeSkillNames(repo) {
      const result = await pool.query(
        `select distinct name from skills
          where deleted_at is null
            and enabled = true
            and ((scope = 'repo' and repo = $1) or scope = 'global')
          order by name asc`,
        [repo],
      );
      return (result.rows as { name: string }[]).map((row) => row.name);
    },

    async activeSkillFiles(repo) {
      const result = await pool.query(
        `select ${SELECT_COLUMNS}, v.files
           from skills s
           left join skill_versions v on v.skill_id = s.id and v.version = s.current_version
          where s.deleted_at is null
            and s.enabled = true
            and (
              (s.scope = 'repo' and s.repo = $1)
              or s.scope = 'global'
            )
          order by case when s.scope = 'repo' then 0 else 1 end asc, s.name asc`,
        [repo],
      );
      const rows = result.rows as (SkillRow & { files: unknown })[];
      const picked = new Map<string, SkillFileText>();
      for (const row of rows) {
        if (picked.has(row.name)) continue; // 仓库作用域先出现，先到先得
        const dir = versionDir(row.id, row.current_version);
        try {
          const text = await readFile(nodePath.join(dir, 'SKILL.md'), 'utf8');
          picked.set(row.name, { path: `upload:${row.name}`, text });
        } catch {
          // 盘上没文件（孤儿行）就跳过：装配期不该因为一条坏行整体失败
        }
      }
      return [...picked.values()];
    },
  };
}
