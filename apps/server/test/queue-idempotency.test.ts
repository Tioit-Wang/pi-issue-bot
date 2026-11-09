/**
 * 幂等键的单测（tech-plan §7.2 的 F9 公式）。
 *
 * 四个必须钉死的性质：
 *  1. 两种 anchor：issue 判定类用 `missing_set_hash`，PR/命令类用 `head_sha`。
 *  2. 同输入同输出（否则 unique 索引形同虚设，webhook 重投就会重复评论）。
 *  3. 不同 `trigger_actor` 不同键（人工 `/retry` 不能被 webhook 重投的唯一键吃掉）。
 *  4. 键固定 32 位 hex（列宽与索引的既定口径）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MISSING_ANCHOR,
  anchorFor,
  buildIdempotencyKey,
  idempotencyParts,
  usesMissingSetAnchor,
} from '../src/queue/idempotency.ts';
import type { IdempotencyInput } from '../src/queue/idempotency.ts';

const reviewPr: IdempotencyInput = {
  kind: 'command:/review-pr',
  repo: 'acme/widget',
  target: 'pr#456',
  headSha: 'a'.repeat(40),
  triggerActor: 'alice',
};

const compliance: IdempotencyInput = {
  kind: 'compliance',
  repo: 'acme/widget',
  target: 'issue#123',
  missingSetHash: 'missing-abc123',
  triggerActor: 'alice',
};

describe('anchor 选择', () => {
  it('issue 判定类（triage / compliance）用 missing_set_hash', () => {
    expect(usesMissingSetAnchor('compliance')).toBe(true);
    expect(usesMissingSetAnchor('triage')).toBe(true);
    expect(anchorFor(compliance)).toBe('missing-abc123');
  });

  it('PR / 命令类用 head_sha', () => {
    expect(usesMissingSetAnchor('command:/review-pr')).toBe(false);
    expect(anchorFor(reviewPr)).toBe('a'.repeat(40));
    expect(anchorFor({ ...reviewPr, kind: 'create_issue' })).toBe('a'.repeat(40));
  });

  it('锚缺失时退化成 none，不抛错（入队路径不能因少字段 500）', () => {
    expect(anchorFor({ ...compliance, missingSetHash: null })).toBe(MISSING_ANCHOR);
    expect(anchorFor({ ...reviewPr, headSha: undefined })).toBe(MISSING_ANCHOR);
  });

  it('判定类即使带了 head_sha 也只用 missing_set_hash（两种锚不混用）', () => {
    expect(anchorFor({ ...compliance, headSha: 'b'.repeat(40) })).toBe('missing-abc123');
  });
});

describe('buildIdempotencyKey', () => {
  it('同输入同输出（确定性）', () => {
    expect(buildIdempotencyKey(reviewPr)).toBe(buildIdempotencyKey({ ...reviewPr }));
    expect(buildIdempotencyKey(compliance)).toBe(buildIdempotencyKey({ ...compliance }));
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

  it('缺失项集合变化 → 换键（同一句话不催第二次，但换了缺失项要再回复）', () => {
    const before = buildIdempotencyKey(compliance);
    const after = buildIdempotencyKey({ ...compliance, missingSetHash: 'missing-def456' });
    expect(before).not.toBe(after);
  });

  it('键是 32 位小写 hex，且等于公式的 sha256 前 32 位', () => {
    const key = buildIdempotencyKey(compliance);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    const expected = createHash('sha256')
      .update(['compliance', 'acme/widget', 'issue#123', 'missing-abc123', 'alice'].join('\n'), 'utf8')
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
