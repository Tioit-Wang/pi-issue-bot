/**
 * V17 的**迁移真跑**（`docs/test-plan-fixed-pipeline.md` §6.2 P2-2 / `docs/plan-fixed-pipeline.md`
 * §4.5 / Q4 / §12 V17）。
 *
 * `migrations/0005_pipeline.sql` 里的 Q4 段是一条 `WITH … UPDATE repos`：把存量 `repos.settings`
 * 重置为新形状（删已废弃键、`pipeline` 只留 4 个已知键、`managers` 空则种入仓库 owner、
 * `labels.vocabulary` 丢弃缺 `role` 的整条）。现有用例只断言这条 SQL 的**文本**，所以
 * `jsonb` 运算写错（少删一个键、role 过滤反了）不会有任何红。
 *
 * 这里从迁移文件里**原样读出那一段**（不整库 migrate，避免把别的 DDL 也跑一遍），在真 PG 上执行：
 * ```
 * ① 旧形状行 → 被删的键全没了 / pipeline 只剩 4 个键 / managers = 仓库 owner
 *              / 无 role 的词条被丢弃 / labels.map 与 prompt.current_version 原样保留
 * ② 再跑一次 → rowCount = 0（幂等：结尾的 `IS DISTINCT FROM` 闸门）
 * ③ 结果喂 `repoSettingsSchema`：缺角色的行**预期失败**（Q4 明确不回填 role，由面板重新配置），
 *    角色齐全的行**预期通过**（「迁移后存量是新形状」这一半）
 * ```
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { repoSettingsSchema } from '../../../packages/contract/src/index.ts';
import { openTestDb } from './helpers/queries-db.ts';
import type { TestDb } from './helpers/queries-db.ts';

const MIGRATION_PATH = fileURLToPath(
  new URL('../../../migrations/0005_pipeline.sql', import.meta.url),
);

const LEGACY_REPO = 'acme/widgets';
const ROLEFUL_REPO = 'globex/api';

/**
 * 「旧形状」的 `repos.settings`（0004 之前的样子）：
 *  - `triggers.faces`（P7 已删，服务端零消费）
 *  - `pipeline.enabled` / `close_after_hours` / `max_runs_per_stage`（E1 去掉项目级开关，Q2 收为系统常量）
 *  - `labels.vocabulary` 两条**没有 role** 的词条（Q4：不回填，整条丢弃）
 *  - `labels.map` 与 `prompt.current_version` 有值（必须原样保留）
 */
const LEGACY_SETTINGS = {
  version: 1,
  dry_run: false,
  triggers: { enabled: true, faces: ['issue', 'pull_request'], users: ['alice'] },
  pipeline: { enabled: true, close_after_hours: 48, max_runs_per_stage: 5 },
  labels: {
    vocabulary: [
      { name: '需求', meaning: '新功能' },
      { name: '缺陷', meaning: '功能坏了' },
    ],
    map: { requirement: '需求', defect: '缺陷' },
    max_per_issue: 3,
  },
  prompt: { enabled: true, current_version: 3 },
  commands: { enabled: false },
};

/** 第二行：`managers` 非空 + 词表角色齐全（只多一条无 role 的，迁移后应当仍可解析）。 */
const ROLEFUL_SETTINGS = {
  version: 1,
  pipeline: { managers: ['bob'], format_prompt_version: 2 },
  labels: {
    vocabulary: [
      { name: '需求', role: 'requirement' },
      { name: '旧词条' },
      { name: '缺陷', role: 'defect' },
    ],
  },
};

/** 从迁移文件里抠出 Q4 那一整段（`WITH "s0" AS ( … UPDATE "repos" …;`）。 */
async function readQ4Statement(): Promise<string> {
  const sql = await readFile(MIGRATION_PATH, 'utf8');
  const start = sql.indexOf('WITH "s0" AS (');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  const statement = sql.slice(start, end + 1);
  // 防呆：抠出来的必须就是「重置 settings」那条，而不是别的 WITH
  expect(statement).toContain('UPDATE "repos"');
  expect(statement).toContain('"settings_updated_at" = now()');
  return statement;
}

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.sql('truncate table repos cascade');
  await db.sql(
    `insert into repos (repo_full_name, enabled, dry_run, settings, settings_valid)
     values ($1, true, false, $2::jsonb, true), ($3, true, false, $4::jsonb, true)`,
    [LEGACY_REPO, JSON.stringify(LEGACY_SETTINGS), ROLEFUL_REPO, JSON.stringify(ROLEFUL_SETTINGS)],
  );
});

async function settingsOf(repo: string): Promise<Record<string, unknown>> {
  const rows = await db.sql('select settings from repos where repo_full_name = $1', [repo]);
  expect(rows).toHaveLength(1);
  return rows[0]?.['settings'] as Record<string, unknown>;
}

describe('V17：0005 的 Q4 数据重置真跑一遍（P2-2）', () => {
  it('旧形状 → 新形状：废弃键删净、pipeline 只剩 4 键、managers 种 owner、无 role 词条丢弃、map/current_version 保留', async () => {
    const q4 = await readQ4Statement();

    const first = await db.pool.query(q4);
    // 两行都变了（都带 IS DISTINCT FROM 闸门）
    expect(first.rowCount).toBe(2);

    const legacy = await settingsOf(LEGACY_REPO);
    const triggers = legacy['triggers'] as Record<string, unknown>;
    const pipeline = legacy['pipeline'] as Record<string, unknown>;
    const labels = legacy['labels'] as Record<string, unknown>;
    const prompt = legacy['prompt'] as Record<string, unknown>;

    // ① 已删的键全没了（`triggers` 段保留，只少了 faces；`pipeline` 的旧键全丢）
    expect(Object.hasOwn(triggers, 'faces')).toBe(false);
    expect(triggers['enabled']).toBe(true);
    expect(triggers['users']).toEqual(['alice']);
    for (const key of ['enabled', 'close_after_hours', 'max_runs_per_stage']) {
      expect(Object.hasOwn(pipeline, key)).toBe(false);
    }

    // ② `pipeline` 只剩 4 个已知键（多一个 = 旧配置漏删；少一个 = 面板指针失效）
    expect(Object.keys(pipeline).sort()).toEqual([
      'agent_prompt_version',
      'classify_prompt_version',
      'format_prompt_version',
      'managers',
    ]);
    // ③ `managers` 缺省 → 种入仓库 owner（`acme/widgets` 的 owner 是 `acme`）
    expect(pipeline['managers']).toEqual(['acme']);
    // 四条版本线铺底为 0（原配置里没有这些键）
    expect(pipeline['format_prompt_version']).toBe(0);
    expect(pipeline['classify_prompt_version']).toBe(0);
    expect(pipeline['agent_prompt_version']).toBe(0);

    // ④ 无 role 的词条整条丢弃（Q4 不回填：留半条只会让「同 role 打哪个标签」变成不确定）
    expect(labels['vocabulary']).toEqual([]);
    // ⑤ `labels.map` 与其余 labels 键原样保留
    expect(labels['map']).toEqual({ requirement: '需求', defect: '缺陷' });
    expect(labels['max_per_issue']).toBe(3);
    // ⑥ `prompt.current_version` 原样保留（版本指针不属于 Q4 的重置范围）
    expect(prompt['current_version']).toBe(3);
    // 其余顶层键也不许被动（`dry_run` / `commands`）
    expect(legacy['dry_run']).toBe(false);
    expect(legacy['commands']).toEqual({ enabled: false });

    // ⑦ 第二行：非空 managers 原样保留、有 role 的词条保留、无 role 的被丢
    const roleful = await settingsOf(ROLEFUL_REPO);
    const rolefulPipeline = roleful['pipeline'] as Record<string, unknown>;
    const rolefulLabels = roleful['labels'] as Record<string, unknown>;
    expect(rolefulPipeline['managers']).toEqual(['bob']);
    expect(rolefulPipeline['format_prompt_version']).toBe(2);
    expect((rolefulLabels['vocabulary'] as Array<Record<string, unknown>>).map((entry) => entry['name'])).toEqual([
      '需求',
      '缺陷',
    ]);

    // ⑧ ★ 可重复执行：第二次匹配 0 行（不会无端刷新 `settings_updated_at`）
    const second = await db.pool.query(q4);
    expect(second.rowCount).toBe(0);
    // 跑第二遍之后内容一模一样
    expect(await settingsOf(LEGACY_REPO)).toEqual(legacy);
    expect(await settingsOf(ROLEFUL_REPO)).toEqual(roleful);

    // ⑨ 结果喂新契约：缺角色的行**预期失败**（Q4 不兼容老配置，由面板重新配置后 `settings_valid` 才会转真）
    const parsedLegacy = repoSettingsSchema.safeParse(legacy);
    expect(parsedLegacy.success).toBe(false);
    if (!parsedLegacy.success) {
      // 失败原因必须是「缺 role」，不是 JSON 形状或已删键的其它意外
      const messages = parsedLegacy.error.issues.map((issue) => issue.message).join('\n');
      expect(messages).toContain("缺 role='requirement'");
      expect(messages).toContain("role='defect'");
      // `managers` 已在迁移里种上 owner，所以失败项只能落在词表上
      const paths = parsedLegacy.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).not.toContain('pipeline.managers');
      expect(paths).toContain('labels.vocabulary');
    }

    // ⑩ 角色齐全的那一行**能过**新契约（「迁移后存量 settings 全部是新形状」这一半）
    const parsedRoleful = repoSettingsSchema.safeParse(roleful);
    expect(parsedRoleful.success).toBe(true);
  });
});
