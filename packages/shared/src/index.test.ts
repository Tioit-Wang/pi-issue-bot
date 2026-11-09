import { describe, expect, it } from 'vitest';
import * as shared from './index.ts';

describe('@pi-issue-bot/shared 出口', () => {
  it('导出下游要用的四类能力：日志、脱敏、取消、失败', () => {
    for (const name of [
      'createLogger',
      'createNullLogger',
      'redactSecrets',
      'redactValue',
      'runWithDeadline',
      'AppError',
      'ok',
      'err',
    ] as const) {
      expect(shared[name], `缺少导出 ${name}`).toBeTypeOf('function');
    }
    expect(shared.FAILURE_CLASSES.length).toBeGreaterThan(0);
    expect(shared.REDACTED).toBe('<redacted>');
  });

  it('叶子包不依赖其它 workspace 包（源码里没有 @pi-issue-bot/* 的 import）', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const dir = new URL('./', import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    for (const file of files) {
      const source = await readFile(new URL(file, dir), 'utf8');
      expect(source, `${file} 不得 import 其它 workspace 包`).not.toMatch(/from\s+'@pi-issue-bot\//);
    }
  });
});
