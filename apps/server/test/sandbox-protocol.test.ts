/**
 * 线协议与能力边界的断言（tech-plan §4.5「端点与协议的五条规定」+ E3）。
 *
 * 这不是「格式测试」，是**能力边界测试**：代理只接受 `{argv, cwd, clientPid}`，
 * 多一个键就必须报错——静默忽略等于把边界一点点放宽，而它是全机能触达 docker 的唯一入口。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXIT_CODE_BY_ERROR_CODE,
  exitCodeForErrorCode,
} from '../src/sandbox/errors.ts';
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  EXEC_REQUEST_KEYS,
  createFrameDecoder,
  createOutputBudget,
  encodeFrame,
  parseExecRequest,
} from '../src/sandbox/protocol.ts';

const CLIENT_FILE = path.join(import.meta.dirname, '..', 'src', 'sandbox', 'exec-client.mjs');

describe('parseExecRequest：白名单', () => {
  it('接受 {argv, cwd, clientPid}', () => {
    const parsed = parseExecRequest({ argv: ['bash', '-lc', 'pwd'], cwd: '/j', clientPid: 42 });
    expect(parsed.argv).toEqual(['bash', '-lc', 'pwd']);
    expect(parsed.cwd).toBe('/j');
    expect(parsed.clientPid).toBe(42);
  });

  it('clientPid 可省略', () => {
    expect(parseExecRequest({ argv: ['-lc', 'pwd'], cwd: '/j' }).clientPid).toBeUndefined();
  });

  it.each([
    ['不收 shell 字符串', { argv: ['-lc', 'pwd'], cwd: '/j', shell: 'bash -lc pwd' }],
    ['不收命令字符串字段', { argv: ['-lc', 'pwd'], cwd: '/j', cmd: 'rm -rf /' }],
    ['不收容器名', { argv: ['-lc', 'pwd'], cwd: '/j', container: 'pi-job-x' }],
    ['不透传 env', { argv: ['-lc', 'pwd'], cwd: '/j', env: { GITHUB_TOKEN: 'x' } }],
    ['不收超时覆盖', { argv: ['-lc', 'pwd'], cwd: '/j', timeoutMs: 999_999 }],
  ])('%s', (_label, payload) => {
    expect(() => parseExecRequest(payload)).toThrow(/不接受字段/);
  });

  it('argv / cwd 的形状校验', () => {
    expect(() => parseExecRequest({ cwd: '/j' })).toThrow(/argv/);
    expect(() => parseExecRequest({ argv: [], cwd: '/j' })).toThrow(/argv/);
    expect(() => parseExecRequest({ argv: ['-lc', 42], cwd: '/j' })).toThrow(/argv/);
    expect(() => parseExecRequest({ argv: ['-lc', 'pwd'], cwd: '' })).toThrow(/cwd/);
    expect(() => parseExecRequest({ argv: ['-lc', 'pwd'], cwd: '/j', clientPid: 1.5 })).toThrow(/clientPid/);
    expect(() => parseExecRequest('not-an-object')).toThrow(/JSON 对象/);
    expect(() => parseExecRequest([1, 2, 3])).toThrow(/JSON 对象/);
  });

  it('白名单常量就是那三个键', () => {
    expect([...EXEC_REQUEST_KEYS].sort()).toEqual(['argv', 'clientPid', 'cwd']);
  });
});

describe('帧编解码（NDJSON）', () => {
  it('encodeFrame 是单行 JSON', () => {
    const line = encodeFrame({ stream: 'stdout', data: Buffer.from('hi').toString('base64') });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({ stream: 'stdout', data: 'aGk=' });
  });

  it('decoder 能跨 chunk 拼帧，且忽略空行', () => {
    const decode = createFrameDecoder();
    expect(decode('{"exitCo')).toEqual([]);
    expect(decode('de":0}\n\n{"stream":"stderr","data":""}\n')).toEqual([
      { exitCode: 0 },
      { stream: 'stderr', data: '' },
    ]);
  });

  it('畸形帧报 BAD_REQUEST（不静默丢弃）', () => {
    const decode = createFrameDecoder();
    expect(() => decode('{oops}\n')).toThrow(/不是合法 JSON/);
  });
});

describe('输出上限：1 MB 合计，超出截断并标 truncated', () => {
  it('上限常量是 1 MB', () => {
    expect(EXEC_OUTPUT_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('先按字节发，超出部分不再转发', () => {
    const budget = createOutputBudget(10);
    expect(budget.take(4)).toBe(4);
    expect(budget.truncated).toBe(false);
    expect(budget.take(4)).toBe(4);
    expect(budget.take(4)).toBe(2);
    expect(budget.truncated).toBe(true);
    expect(budget.sent).toBe(10);
    expect(budget.take(1)).toBe(0);
    expect(budget.sent).toBe(10);
  });
});

describe('退出码映射（dev-plan §11 E7）', () => {
  it('CWD_OUTSIDE_JOB → 3，NO_EXEC_ENDPOINT → 2，其余 1', () => {
    expect(exitCodeForErrorCode('CWD_OUTSIDE_JOB')).toBe(3);
    expect(exitCodeForErrorCode('NO_EXEC_ENDPOINT')).toBe(2);
    expect(exitCodeForErrorCode('EXEC_FAILED')).toBe(1);
    expect(EXIT_CODE_BY_ERROR_CODE.NO_EXEC_ENDPOINT).toBe(2);
    expect(EXIT_CODE_BY_ERROR_CODE.CWD_OUTSIDE_JOB).toBe(3);
  });

  it('exec-client.mjs 里的映射与 TS 侧一致（客户端是独立文件，不能回引 TS）', async () => {
    const source = await readFile(CLIENT_FILE, 'utf8');
    expect(source).toMatch(/NO_EXEC_ENDPOINT:\s*2/);
    expect(source).toMatch(/CWD_OUTSIDE_JOB:\s*3/);
  });
});
