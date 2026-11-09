/**
 * `host_credentials` 的**真库**验收（dev-plan §13.2 E11：本机有 PostgreSQL，不许只用假执行器）。
 *
 * 这里验的是三件只有真 PG 才能证明的事：
 *  1. `createSqlHostCredentialStore` 的 SQL 在真实表上可执行（列名、类型、`ON CONFLICT` 都对）；
 *  2. 落库的确实是密文（`token_enc` 里没有 `pdt1.` 明文，解回来才是设备令牌）；
 *  3. 重复引导（`--repair`）是幂等的：一行被覆盖，不会插出第二行。
 *
 * 连不上库就整体 skip（不把环境问题算成代码失败），并在测试名里写明连接串来源。
 */
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { createSqlHostCredentialStore, readDeviceToken } from '../src/runtime/bootstrap.ts';
import type { HostCredentialRow } from '../src/runtime/bootstrap.ts';
import { decryptSecret, encryptSecret } from '../src/runtime/crypto.ts';
import { closePool, createPool, ping } from '../src/db/pool.ts';

const CONNECTION_STRING =
  process.env['PI_BOT_TEST_DATABASE_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/pi_issue_bot_test';
const KEY = new Uint8Array(32).fill(23);
const TOKEN_ONE = 'pdt1.first-device-token-aaaaaaa';
const TOKEN_TWO = 'pdt1.second-device-token-bbbbbb';

const pool = createPool({ connectionString: CONNECTION_STRING, max: 2, connectionTimeoutMillis: 1_500, applicationName: 'pi-bot-runtime-test' });

let available = false;
try {
  await ping(pool);
  available = true;
} catch {
  available = false;
}

const hostId = `runtime-test-${randomUUID()}`;
const store = createSqlHostCredentialStore(pool);

afterAll(async () => {
  if (available) {
    await pool.query(`DELETE FROM host_credentials WHERE host_id LIKE 'runtime-test-%'`);
  }
  await closePool(pool);
});

describe.skipIf(!available)('host_credentials（真实 PostgreSQL）', () => {
  it('upsert → find：密文原样往返，能解回设备令牌，且库里没有明文', async () => {
    const tokenEnc = encryptSecret(TOKEN_ONE, { key: KEY });
    await store.upsert({ hostId, tokenEnc, version: 1, expiresAt: new Date('2026-12-01T00:00:00.000Z') });

    const found = await store.find(hostId);
    expect(found).toBeDefined();
    expect(found?.tokenEnc).toBe(tokenEnc);
    expect(found?.version).toBe(1);
    expect(found?.expiresAt?.toISOString()).toBe('2026-12-01T00:00:00.000Z');

    // 解密路径（serve 启动时用）
    expect(readDeviceToken(found as HostCredentialRow, KEY)).toBe(TOKEN_ONE);

    // 直接读原始列：确认库里存的是密文而不是明文
    const raw = await pool.query<{ token_enc: string }>(
      'SELECT token_enc FROM host_credentials WHERE host_id = $1',
      [hostId],
    );
    expect(raw.rows[0]?.token_enc.startsWith('v1:')).toBe(true);
    expect(raw.rows[0]?.token_enc).not.toContain('pdt1.');
    expect(decryptSecret(raw.rows[0]?.token_enc ?? '', { key: KEY })).toBe(TOKEN_ONE);
  });

  it('重复 upsert 是幂等的（--repair 覆盖同一行，不插第二行）', async () => {
    await store.upsert({
      hostId,
      tokenEnc: encryptSecret(TOKEN_TWO, { key: KEY }),
      version: 1,
      expiresAt: null,
    });

    const count = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM host_credentials WHERE host_id = $1',
      [hostId],
    );
    expect(count.rows[0]?.n).toBe('1');

    const found = await store.find(hostId);
    expect(decryptSecret(found?.tokenEnc ?? '', { key: KEY })).toBe(TOKEN_TWO);
    expect(found?.expiresAt).toBeNull();
  });

  it('查不到的行返回 undefined（引导时用来判 replacedExisting）', async () => {
    expect(await store.find(`runtime-test-missing-${randomUUID()}`)).toBeUndefined();
  });
});
