/**
 * 从 pi-host 的 sqlite 读用量（`cost/host-usage.ts`）。
 *
 * 这里用**真的 sqlite 文件**（node:sqlite 造一个最小 `turns` 表），因为这一层最容易
 * 悄悄退化成「永远 null 但没人发现」。三个必须成立的边界：
 *  1. 正常行 → 拿到 in/out/cacheRead 三个数；
 *  2. 行不存在 / 库不存在 / 表不存在 → `null`（**不能抛**，否则会把任务带崩）；
 *  3. 全 0 的用量 → `null`（那不是「花了 0 元」，是「没采到」）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHostUsageReader } from '../src/cost/index.ts';

let dir = '';
let dataDir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-bot-usage-'));
  dataDir = join(dir, 'hostdata');
  mkdirSync(dataDir, { recursive: true });

  const db = new DatabaseSync(join(dataDir, 'pi.sqlite'));
  db.exec(`
    create table turns (
      id text primary key,
      session_id text,
      model_id text,
      input_tokens integer,
      output_tokens integer,
      usage_json text
    );
  `);
  const insert = db.prepare(
    'insert into turns (id, session_id, model_id, input_tokens, output_tokens, usage_json) values (?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    'turn-with-usage',
    'session-1',
    'deepseek-v4.1-flash',
    12223,
    688,
    JSON.stringify({ inputTokens: 12223, outputTokens: 688, cacheReadTokens: 30976 }),
  );
  insert.run('turn-zero', 'session-2', 'deepseek-v4.1-flash', 0, 0, JSON.stringify({}));
  insert.run('turn-broken-json', 'session-3', 'deepseek-v4.1-flash', 100, 20, '{not json');
  db.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createHostUsageReader', () => {
  it('读到真实 token（cacheRead 从 usage_json 里取）', async () => {
    const read = createHostUsageReader({ dataDir });
    await expect(read('turn-with-usage')).resolves.toEqual({
      modelId: 'deepseek-v4.1-flash',
      inputTokens: 12223,
      cacheReadTokens: 30976,
      outputTokens: 688,
    });
  });

  it('全 0 的行返回 null（「没采到」不是「花了 0 元」）', async () => {
    const read = createHostUsageReader({ dataDir });
    await expect(read('turn-zero')).resolves.toBeNull();
  });

  it('usage_json 坏了也不抛，退化成 cacheRead=0', async () => {
    const read = createHostUsageReader({ dataDir });
    await expect(read('turn-broken-json')).resolves.toEqual({
      modelId: 'deepseek-v4.1-flash',
      inputTokens: 100,
      cacheReadTokens: 0,
      outputTokens: 20,
    });
  });

  it('行不存在 / 空 id → null', async () => {
    const read = createHostUsageReader({ dataDir });
    await expect(read('turn-missing')).resolves.toBeNull();
    await expect(read('')).resolves.toBeNull();
  });

  it('库不存在 → null（不抛）', async () => {
    const read = createHostUsageReader({ dataDir: join(dir, 'nope') });
    await expect(read('turn-with-usage')).resolves.toBeNull();
  });

  it('表结构不对 → null（host 升级不再兼容时的兜底）', async () => {
    const other = join(dir, 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'pi.sqlite'), '');
    const read = createHostUsageReader({ dataDir: other });
    await expect(read('turn-with-usage')).resolves.toBeNull();
  });
});
