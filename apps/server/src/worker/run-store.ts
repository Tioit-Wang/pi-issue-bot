/**
 * `RunStore` 的 PG 实现（`runs` / `run_events` / `envelopes` / `actions` / `degeneracy_hits`）。
 *
 * 三条实现约定：
 *  1. **只用参数化 SQL**，`jsonb` 列显式 `JSON.stringify` + `::jsonb`：
 *     `pg` 会把 JS 数组按 Postgres 数组编码（`{a,b}`），那写进 jsonb 列就是坏数据。
 *  2. **不建外键，关联完整性由写入方保证**（tech-plan §7.2）：所以 `runs` 行必须在
 *     `run_events` / `envelopes` / `actions` 之前插入（`beginRun()` 是第一个动作）。
 *  3. **`envelopes` 每 run 一行**（唯一索引在 `run_id` 上）：用 `ON CONFLICT DO UPDATE`，
 *     这样「先落一份不合规的、之后又补了一份合规的」不会炸成唯一键冲突。
 *
 * 依赖方向：本文件只依赖 `db/`（`SqlExecutor`），不碰 queries / http。
 */
import type { SqlExecutor } from '../db/index.ts';
import type { RunStore } from './types.ts';

export interface PgRunStoreOptions {
  /** 连接池（`db/pool.ts` 的 `createPool` 结果天然满足）。 */
  readonly pool: SqlExecutor;
}

/** JSON 参数：`undefined` / `null` 保持 SQL NULL，其余序列化成 `::jsonb`。 */
function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function createPgRunStore(options: PgRunStoreOptions): RunStore {
  const pool = options.pool;

  return {
    async beginRun(input) {
      await pool.query('insert into runs (id, task_id, attempt, started_at) values ($1, $2, $3, $4)', [
        input.runId,
        input.taskId,
        input.attempt,
        input.startedAt,
      ]);
    },

    async appendEvent(input) {
      await pool.query(
        'insert into run_events (run_id, cursor, kind, payload) values ($1, $2, $3, $4::jsonb)',
        [input.runId, input.cursor, input.kind, json(input.payload)],
      );
    },

    async recordEnvelope(record) {
      await pool.query(
        `insert into envelopes (run_id, verdict, actions, usage, valid, errors)
         values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6::jsonb)
         on conflict (run_id) do update
           set verdict = excluded.verdict,
               actions = excluded.actions,
               usage = excluded.usage,
               valid = excluded.valid,
               errors = excluded.errors`,
        [
          record.runId,
          json(record.verdict),
          json(record.actions),
          json(record.usage),
          record.valid,
          json(record.errors),
        ],
      );
    },

    async recordAction(record) {
      await pool.query(
        `insert into actions (run_id, intent, target, external_ref, applied_at, audit)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          record.runId,
          record.intent,
          record.target,
          record.externalRef,
          record.appliedAt,
          json(record.audit),
        ],
      );
    },

    /**
     * 用量与费用落库。
     *
     * 一个 run 一行：同一 run 重复写会变成多行（金额列是 numeric，累加会失真），
     * 所以调用方只在 turn 结束后写一次；重试是新 run id，天然分开。
     */
    async recordUsage(input) {
      await pool.query(
        `insert into usage_costs (run_id, model, input_tokens, output_tokens, cost_usd)
         values ($1, $2, $3, $4, $5::numeric)`,
        [input.runId, input.model, input.inputTokens, input.outputTokens, input.costUsd],
      );
    },

    async recordDegeneracyHit(input) {
      await pool.query(
        'insert into degeneracy_hits (run_id, criterion, detail, created_at) values ($1, $2, $3::jsonb, $4)',
        [input.runId, input.hit.criterion, json(input.hit.detail), new Date(input.hit.at)],
      );
    },

    async finishRun(input) {
      await pool.query(
        `update runs
            set outcome = $2,
                failure_class = $3,
                failure_detail = $4::jsonb,
                ended_at = $5,
                session_id = coalesce($6, session_id),
                turn_id = coalesce($7, turn_id)
          where id = $1`,
        [
          input.runId,
          input.outcome,
          input.failureClass,
          json(input.failureDetail),
          input.endedAt,
          input.sessionId ?? null,
          input.turnId ?? null,
        ],
      );
    },

    async markTask(input) {
      await pool.query(
        `update tasks
            set status = $2,
                ended_at = $3,
                updated_at = $3,
                container_name = coalesce($4, container_name)
          where id = $1`,
        [input.taskId, input.status, input.endedAt, input.containerName ?? null],
      );
    },
  };
}
