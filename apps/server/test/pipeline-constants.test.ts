/**
 * 固定流水线数据层（S0-b）的门禁测试：**不连库、不读 env**。
 *
 * 钉住四件事，否则后面的切片会各自理解一套：
 *  1. `config/pipeline-constants.ts` 的阈值就是规划里的数值，且 `createPipelineLimits()` 是纯函数
 *     （V12 / V19 要求注入 `0.01` 小时与 `2` 次）；
 *  2. `queue/definitions.ts` 的 `pipeline:` 前缀走三档 `expireInSeconds`，且值只来自常量（不重复字面量）；
 *  3. `0005_pipeline.sql` 的 DDL 与 `db/schema.ts` 不漂移：新表、新列、新旧索引交替都在；
 *  4. 0005 的 Q4 数据重置是「一条 UPDATE、可重复执行」（断言它带 `IS DISTINCT FROM` 且不是 PL/pgSQL）。
 *
 * 为什么一半看 drizzle 对象、一半看 SQL 文本：列是否存在看对象最直接；复合主键与索引名在 drizzle
 * 对象里是内部符号，读生成产物更稳——而生成产物才是真正跑在目标机上的东西（与 `db-schema.test.ts` 同理）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  JOB_PIPELINE_CLOSE_SCHEDULE,
  PIPELINE_CLASSIFY_MAX_MINUTES,
  PIPELINE_CLOSE_AFTER_HOURS,
  PIPELINE_COMMAND_EXPIRE_SECONDS,
  PIPELINE_FORMAT_MAX_FAILS,
  PIPELINE_GATE_NOTICE_INTERVAL_SECONDS,
  PIPELINE_LIMITS,
  PIPELINE_RECHECK_COOLDOWN_SECONDS,
  PIPELINE_SESSION_MAX_AGE_DAYS,
  PIPELINE_SESSION_MAX_TURNS,
  PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS,
  PIPELINE_SUPPLEMENT_MAX_ITEMS,
  PIPELINE_TARGET_BODY_MAX_CHARS,
  createPipelineLimits,
} from '../src/config/pipeline-constants.ts';
import type { PipelineLimits } from '../src/config/pipeline-constants.ts';
import {
  EXPIRE_IN_SECONDS_DEFAULT,
  EXPIRE_IN_SECONDS_REVIEW_PR,
  PIPELINE_COMMAND_PREFIX,
  REVIEW_PR_COMMAND,
  expireInSecondsForCommand,
  pipelineStageOfCommand,
} from '../src/queue/definitions.ts';
import { envelopes, issuePipeline, promptVersions, tasks } from '../src/db/schema.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATION_0005 = path.join(REPO_ROOT, 'migrations', '0005_pipeline.sql');

/** 去掉整行注释后的 SQL（回滚说明写在注释块里，不该参与「有没有 DROP」这类断言）。 */
function stripCommentLines(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

async function readMigration0005(): Promise<string> {
  return readFile(MIGRATION_0005, 'utf8');
}

describe('pipeline-constants：阈值与规划一致（§9 / §5 / §16.2 / §4.6）', () => {
  it('默认值与文档定案逐项对齐', () => {
    expect(PIPELINE_CLOSE_AFTER_HOURS).toBe(48);
    expect(PIPELINE_FORMAT_MAX_FAILS).toBe(5);
    expect(PIPELINE_RECHECK_COOLDOWN_SECONDS).toBe(120);
    expect(PIPELINE_GATE_NOTICE_INTERVAL_SECONDS).toBe(3600);
    expect(PIPELINE_SESSION_MAX_TURNS).toBe(30);
    expect(PIPELINE_SESSION_MAX_AGE_DAYS).toBe(7);
    expect(PIPELINE_SUPPLEMENT_MAX_ITEMS).toBe(3);
    expect(PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS).toBe(1000);
    expect(PIPELINE_TARGET_BODY_MAX_CHARS).toBe(8000);
    expect(PIPELINE_CLASSIFY_MAX_MINUTES).toBe(30);
    expect(PIPELINE_COMMAND_EXPIRE_SECONDS).toEqual({ format: 600, classify: 1800, notice: 300 });
  });

  it('单个常量与聚合常量是同一份值（改值只需改一处）', () => {
    expect(PIPELINE_CLOSE_AFTER_HOURS).toBe(PIPELINE_LIMITS.closeAfterHours);
    expect(PIPELINE_FORMAT_MAX_FAILS).toBe(PIPELINE_LIMITS.formatMaxFails);
    expect(PIPELINE_RECHECK_COOLDOWN_SECONDS).toBe(PIPELINE_LIMITS.recheckCooldownSeconds);
    expect(PIPELINE_GATE_NOTICE_INTERVAL_SECONDS).toBe(PIPELINE_LIMITS.gateNoticeIntervalSeconds);
    expect(PIPELINE_SESSION_MAX_TURNS).toBe(PIPELINE_LIMITS.sessionMaxTurns);
    expect(PIPELINE_SESSION_MAX_AGE_DAYS).toBe(PIPELINE_LIMITS.sessionMaxAgeDays);
    expect(PIPELINE_SUPPLEMENT_MAX_ITEMS).toBe(PIPELINE_LIMITS.supplementMaxItems);
    expect(PIPELINE_SUPPLEMENT_ITEM_MAX_CHARS).toBe(PIPELINE_LIMITS.supplementItemMaxChars);
    expect(PIPELINE_TARGET_BODY_MAX_CHARS).toBe(PIPELINE_LIMITS.targetBodyMaxChars);
    expect(PIPELINE_CLASSIFY_MAX_MINUTES).toBe(PIPELINE_LIMITS.classifyMaxMinutes);
    expect(PIPELINE_COMMAND_EXPIRE_SECONDS).toBe(PIPELINE_LIMITS.commandExpireSeconds);
  });

  it('pipeline-close 作业是每 10 分钟（5 段 cron，UTC 由调度方给）', () => {
    expect(JOB_PIPELINE_CLOSE_SCHEDULE).toBe('*/10 * * * *');
    expect(JOB_PIPELINE_CLOSE_SCHEDULE.trim().split(/\s+/)).toHaveLength(5);
  });

  it('常量对象是冻结的：运行期改默认值会抛错（阈值只该走注入）', () => {
    expect(Object.isFrozen(PIPELINE_LIMITS)).toBe(true);
    expect(Object.isFrozen(PIPELINE_LIMITS.commandExpireSeconds)).toBe(true);
  });
});

describe('createPipelineLimits：纯函数式注入（V12 / V19）', () => {
  it('不传参时等于默认值', () => {
    const limits = createPipelineLimits();
    expect(limits.closeAfterHours).toBe(PIPELINE_LIMITS.closeAfterHours);
    expect(limits.formatMaxFails).toBe(PIPELINE_LIMITS.formatMaxFails);
    expect(limits.commandExpireSeconds).toEqual(PIPELINE_LIMITS.commandExpireSeconds);
  });

  it('注入 closeAfterHours 0.01 / formatMaxFails 2，其余保持默认', () => {
    const limits = createPipelineLimits({ closeAfterHours: 0.01, formatMaxFails: 2 });
    expect(limits.closeAfterHours).toBe(0.01);
    expect(limits.formatMaxFails).toBe(2);
    // 没覆盖的项不受影响
    expect(limits.recheckCooldownSeconds).toBe(120);
    expect(limits.commandExpireSeconds).toEqual({ format: 600, classify: 1800, notice: 300 });
  });

  it('commandExpireSeconds 是浅合并：只改一档不会把另外两档变成 undefined', () => {
    const limits = createPipelineLimits({ commandExpireSeconds: { format: 60 } as never });
    expect(limits.commandExpireSeconds).toEqual({ format: 60, classify: 1800, notice: 300 });
  });

  it('不改入参、不污染默认值（两次注入互不影响）', () => {
    const overrides: Partial<PipelineLimits> = { closeAfterHours: 0.5 };
    const first = createPipelineLimits(overrides);
    const second = createPipelineLimits({ closeAfterHours: 1 });
    expect(first.closeAfterHours).toBe(0.5);
    expect(second.closeAfterHours).toBe(1);
    expect(PIPELINE_LIMITS.closeAfterHours).toBe(48);
    // 返回值也是冻结的：作业里顺手改阈值应当立刻炸，而不是悄悄生效
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe('queue/definitions：pipeline 前缀的执行期硬上限（§4.6 / §10.6）', () => {
  it('前缀常量与三档取值', () => {
    expect(PIPELINE_COMMAND_PREFIX).toBe('pipeline:');
    expect(expireInSecondsForCommand('pipeline:format')).toBe(PIPELINE_COMMAND_EXPIRE_SECONDS.format);
    expect(expireInSecondsForCommand('pipeline:classify')).toBe(PIPELINE_COMMAND_EXPIRE_SECONDS.classify);
    expect(expireInSecondsForCommand('pipeline:notice')).toBe(PIPELINE_COMMAND_EXPIRE_SECONDS.notice);
    // 三档互不相同且不等于默认值，否则「分档」等于没做
    expect(new Set([600, 1800, 300]).size).toBe(3);
    expect([600, 1800, 300]).not.toContain(EXPIRE_IN_SECONDS_DEFAULT);
  });

  it('老命令不受影响：/review-pr 30min，其余自动通道 20min', () => {
    expect(expireInSecondsForCommand(REVIEW_PR_COMMAND)).toBe(EXPIRE_IN_SECONDS_REVIEW_PR);
    expect(expireInSecondsForCommand('auto:triage')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
    expect(expireInSecondsForCommand('/issue-triage')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
  });

  it('认不出的 pipeline 子命令与空后缀回落默认值（拼错不享受长闸）', () => {
    expect(expireInSecondsForCommand('pipeline:unknown')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
    expect(expireInSecondsForCommand('pipeline:')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
    expect(pipelineStageOfCommand('pipeline:unknown')).toBeNull();
    expect(pipelineStageOfCommand('auto:triage')).toBeNull();
    expect(pipelineStageOfCommand('pipeline:format')).toBe('format');
  });

  it('前缀匹配不会把「以 pipeline 开头的其它命令」误认（`pipelineX:format`）', () => {
    expect(pipelineStageOfCommand('pipelineX:format')).toBeNull();
    expect(expireInSecondsForCommand('pipelineX:format')).toBe(EXPIRE_IN_SECONDS_DEFAULT);
  });
});

describe('db/schema：固定流水线的列', () => {
  it('issue_pipeline 表名与 §4.3 的列一一对应', () => {
    expect(getTableName(issuePipeline)).toBe('issue_pipeline');
    const columns = getTableColumns(issuePipeline);
    expect(Object.keys(columns).sort()).toEqual(
      [
        'repo',
        'issueNumber',
        'stage',
        'state',
        'category',
        'formatAttempts',
        'formatFailCount',
        'classifyAttempts',
        'issueVersion',
        'infoRequestedAt',
        'lastRecheckAt',
        'mentionSentAt',
        'mentionCategory',
        'gateNoticeAt',
        'sessionId',
        'sessionCursor',
        'sessionTurns',
        'sessionStartedAt',
        'staleAt',
        'blockedReason',
        'readyAt',
        'closedAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('默认值与可空性与 §4.3 一致（stage=format / state=pending / 三个计数从 0 起）', () => {
    const columns = getTableColumns(issuePipeline);
    expect(columns.repo.notNull).toBe(true);
    expect(columns.issueNumber.notNull).toBe(true);
    expect(columns.stage.notNull).toBe(true);
    expect(columns.stage.default).toBe('format');
    expect(columns.state.notNull).toBe(true);
    expect(columns.state.default).toBe('pending');
    expect(columns.formatAttempts.default).toBe(0);
    expect(columns.formatFailCount.default).toBe(0);
    expect(columns.classifyAttempts.default).toBe(0);
    expect(columns.sessionCursor.default).toBe(0);
    expect(columns.sessionTurns.default).toBe(0);
    // 两种 awaiting_info 语义靠 info_requested_at 区分，所以它必须可空
    expect(columns.infoRequestedAt.notNull).toBe(false);
    expect(columns.category.notNull).toBe(false);
    expect(columns.closedAt.notNull).toBe(false);
  });

  it('tasks 的正文 / 补充快照：title/body 可空，target_supplement 是 NOT NULL 的 jsonb 数组', () => {
    const columns = getTableColumns(tasks);
    expect(columns.targetTitle.notNull).toBe(false);
    expect(columns.targetBody.notNull).toBe(false);
    expect(columns.targetSupplement.notNull).toBe(true);
    // 默认 '[]'：读侧不必分支，写侧永远整体替换
    expect(columns.targetSupplement.default).toEqual([]);
    expect(columns.targetSupplement.columnType).toBe('PgJsonb');
  });

  it('envelopes 有阶段投影列，prompt_versions 有 kind（默认 project）', () => {
    const envelopeColumns = getTableColumns(envelopes);
    expect(envelopeColumns.stageName.notNull).toBe(false);
    expect(envelopeColumns.stageResult.notNull).toBe(false);

    const promptColumns = getTableColumns(promptVersions);
    expect(promptColumns.kind.notNull).toBe(true);
    expect(promptColumns.kind.default).toBe('project');
  });
});

describe('migrations/0005_pipeline.sql', () => {
  it('建 issue_pipeline + 关闭扫描索引，主键是 (repo, issue_number)', async () => {
    const sql = await readMigration0005();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "issue_pipeline"');
    expect(sql).toContain(
      'CONSTRAINT "issue_pipeline_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "issue_pipeline_close_scan_idx" ON "issue_pipeline" USING btree ("state","info_requested_at")',
    );
    // 时间列一律 timestamptz（与 0000 的约定一致）
    const bareTimestamps = [...sql.matchAll(/^\t"[a-z_]+" timestamp (?!with time zone)/gm)];
    expect(bareTimestamps).toEqual([]);
  });

  it('增量列与 schema 对齐（tasks / envelopes / prompt_versions）', async () => {
    const sql = await readMigration0005();
    for (const column of ['target_title', 'target_body']) {
      expect(sql).toContain(`ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "${column}" text`);
    }
    expect(sql).toContain(
      `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "target_supplement" jsonb DEFAULT '[]'::jsonb NOT NULL`,
    );
    for (const column of ['stage_name', 'stage_result']) {
      expect(sql).toContain(`ALTER TABLE "envelopes" ADD COLUMN IF NOT EXISTS "${column}" text`);
    }
    expect(sql).toContain(`ALTER TABLE "prompt_versions" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'project' NOT NULL`);
  });

  it('旧唯一索引被 DROP，新唯一索引带 kind', async () => {
    const sql = await readMigration0005();
    expect(sql).toContain('DROP INDEX IF EXISTS "prompt_versions_repo_version_uidx"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_repo_kind_version_uq" ON "prompt_versions" USING btree ("repo","kind","version")',
    );
    // DROP 必须在 CREATE 之前：先进后出会留一个「无唯一键」的窗口
    expect(sql.indexOf('DROP INDEX IF EXISTS "prompt_versions_repo_version_uidx"')).toBeLessThan(
      sql.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "prompt_versions_repo_kind_version_uq"'),
    );
  });

  it('Q4 数据重置是单条 UPDATE 且可重复执行（IS DISTINCT FROM），不用 PL/pgSQL', async () => {
    const sql = await readMigration0005();
    expect(sql).toContain('UPDATE "repos" AS "r"');
    expect(sql).toContain('"r"."settings" IS DISTINCT FROM "final"."settings"');
    // 用 jsonb 运算符而不是函数：迁移文件里不该出现 CREATE FUNCTION / DO $$
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).not.toMatch(/\bDO\s+\$\$/i);
    // 只允许一条 UPDATE（多段 UPDATE 会让「跑到一半」变成半新半旧）
    expect([...sql.matchAll(/^\s*UPDATE\s/gm)]).toHaveLength(1);
    // 计数只在一条语句里出现一次：`IS DISTINCT FROM` 是幂等的唯一保证
    expect(sql).toContain('"settings_updated_at" = now()');
  });

  it('Q4 重置覆盖四个已废弃键、managers 播种、缺 role 的词条丢弃', async () => {
    const sql = await readMigration0005();
    // ① 删 triggers.faces（`-` 运算符，不是「置 null」）
    expect(sql).toContain(`("settings" -> 'triggers') - 'faces'`);
    // ② pipeline 段只保留 4 个已知键：enabled / close_after_hours / max_runs_per_stage 自然被丢掉
    expect(sql).toContain(`'format_prompt_version', "settings" -> 'pipeline' -> 'format_prompt_version'`);
    expect(sql).toContain(`'classify_prompt_version', "settings" -> 'pipeline' -> 'classify_prompt_version'`);
    expect(sql).toContain(`'agent_prompt_version', "settings" -> 'pipeline' -> 'agent_prompt_version'`);
    expect(sql).not.toContain(`'close_after_hours'`);
    expect(sql).not.toContain(`'max_runs_per_stage'`);
    expect(sql).not.toContain(`'enabled', "settings" -> 'pipeline'`);
    // ③ managers 为空时种入仓库 owner，已有值不覆盖
    expect(sql).toContain(`split_part("repo", '/', 1)`);
    expect(sql).toContain('jsonb_array_length("pipeline_known" -> \'managers\') > 0');
    // ④ vocabulary 丢弃缺 role 的整条
    expect(sql).toContain(`"entry" ? 'role'`);
    expect(sql).toContain(`jsonb_typeof("entry") = 'object'`);
  });

  it('语句之间用 statement-breakpoint 分隔（migrate.ts 按它切分）', async () => {
    const sql = await readMigration0005();
    const statements = sql
      .split('--> statement-breakpoint')
      .map((chunk) => stripCommentLines(chunk).trim())
      .filter((chunk) => chunk !== '');
    expect(statements.length).toBeGreaterThanOrEqual(11);
    // 每条切出来的语句都以分号收尾（否则说明 breakpoint 漏了一个）
    for (const statement of statements) {
      expect(statement.endsWith(';')).toBe(true);
    }
  });

  it('正向语句里没有 DROP TABLE / DROP COLUMN（回滚只写在注释块里）', async () => {
    const sql = await readMigration0005();
    const forward = stripCommentLines(sql);
    expect(forward).not.toMatch(/DROP TABLE/i);
    expect(forward).not.toMatch(/DROP COLUMN/i);
    // 确实是「回滚（手工）」注释块承载了这些语句
    expect(sql).toMatch(/-- ── 回滚（手工）/);
    expect(sql).toMatch(/--\s+DROP TABLE IF EXISTS "issue_pipeline"/);
    expect(sql).toMatch(/--\s+ALTER TABLE "tasks" DROP COLUMN IF EXISTS "target_supplement"/);
  });
});
