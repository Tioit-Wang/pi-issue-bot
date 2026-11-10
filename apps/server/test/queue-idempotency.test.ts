/**
 * 幂等键的单测（tech-plan §7.2 的 F9 公式）。
 *
 * 四个必须钉死的性质：
 *  1. 锚只由**数据**决定：有 `head_sha` 用它，否则用 issue 版本 hash
 *     （旧的「按 kind 名选锚 / `compliance` 特例」已按 `docs/impl-multi-repo.md`
 *     §4 W2-E 第 6 条删掉）。
 *  2. 同输入同输出（否则 unique 索引形同虚设，webhook 重投就会重复评论）。
 *  3. 不同 `trigger_actor` 不同键（人工 `/retry` 不能被 webhook 重投的唯一键吃掉）。
 *  4. 键固定 32 位 hex（列宽与索引的既定口径）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MISSING_ANCHOR, anchorFor, buildIdempotencyKey, idempotencyParts } from '../src/queue/idempotency.ts';
import type { IdempotencyInput } from '../src/queue/idempotency.ts';

const reviewPr: IdempotencyInput = {
  kind: 'command:/review-pr',
  repo: 'acme/widget',
  target: 'pr#456',
  headSha: 'a'.repeat(40),
  triggerActor: 'alice',
};

/** issue 判定类：没有提交可锚，锚是 webhook 给的 issue 版本 hash。 */
const triage: IdempotencyInput = {
  kind: 'triage',
  repo: 'acme/widget',
  target: 'issue#123',
  missingSetHash: 'issue-version-abc123',
  triggerActor: 'alice',
};

describe('anchor 选择', () => {
  it('没有 head_sha（issue 判定类）→ 用 issue 版本 hash', () => {
    expect(anchorFor(triage)).toBe('issue-version-abc123');
  });

  it('有 head_sha（PR / 命令类）→ 用 head_sha', () => {
    expect(anchorFor(reviewPr)).toBe('a'.repeat(40));
    expect(anchorFor({ ...reviewPr, kind: 'create_issue' })).toBe('a'.repeat(40));
  });

  it('锚缺失时退化成 none，不抛错（入队路径不能因少字段 500）', () => {
    expect(anchorFor({ ...triage, missingSetHash: null })).toBe(MISSING_ANCHOR);
    expect(anchorFor({ ...reviewPr, headSha: undefined })).toBe(MISSING_ANCHOR);
  });

  it('两种锚不再按 kind 混用：给了 head_sha 就用它，不再看 kind 名字', () => {
    // 旧口径下 `triage` / `compliance` 无论有没有 head_sha 都只用缺失项集合；
    // 现在锚跟数据走：有提交就锚提交。
    expect(anchorFor({ ...triage, headSha: 'b'.repeat(40) })).toBe('b'.repeat(40));
    expect(anchorFor({ ...reviewPr, missingSetHash: 'issue-version-abc123' })).toBe('a'.repeat(40));
  });
});

describe('buildIdempotencyKey', () => {
  it('同输入同输出（确定性）', () => {
    expect(buildIdempotencyKey(reviewPr)).toBe(buildIdempotencyKey({ ...reviewPr }));
    expect(buildIdempotencyKey(triage)).toBe(buildIdempotencyKey({ ...triage }));
  });

  it('不同 trigger_actor → 不同键（/retry 与 webhook 重投必须能区分）', () => {
    const byHuman = buildIdempotencyKey(reviewPr);
    const byWebhook = buildIdempotencyKey({ ...reviewPr, triggerActor: 'github-actions[bot]' });
    expect(byHuman).not.toBe(byWebhook);
  });

  it('kind / repo / target / anchor 任一变化都会换键', () => {
    const base = buildIdempotencyKey(reviewPr);
    expect(buildIdempotencyKey({ ...reviewPr, kind: 'command:/retry' })).not.toBe(base);
    expect(buildIdempotencyKey({ ...reviewPr, repo: 'acme/other' })).not.toBe(base);
    expect(buildIdempotencyKey({ ...reviewPr, target: 'pr#457' })).not.toBe(base);
    expect(buildIdempotencyKey({ ...reviewPr, headSha: 'c'.repeat(40) })).not.toBe(base);
  });

  it('issue 版本 hash 变化 → 换键（正文改了就该重新判定）', () => {
    const before = buildIdempotencyKey(triage);
    const after = buildIdempotencyKey({ ...triage, missingSetHash: 'issue-version-def456' });
    expect(before).not.toBe(after);
  });

  it('键是 32 位小写 hex，且等于公式的 sha256 前 32 位', () => {
    const key = buildIdempotencyKey(triage);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const expected = createHash('sha256')
      .update(['triage', 'acme/widget', 'issue#123', 'issue-version-abc123', 'alice'].join('\n'), 'utf8')
      .digest('hex')
      .slice(0, 32);
    expect(key).toBe(expected);
  });

  it('五项顺序固定：kind, repo, target, anchor, trigger_actor', () => {
    expect(idempotencyParts(reviewPr)).toEqual([
      'command:/review-pr',
      'acme/widget',
      'pr#456',
      'a'.repeat(40),
      'alice',
    ]);
  });
});
