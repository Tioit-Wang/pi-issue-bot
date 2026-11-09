/**
 * 模型端点配置（`PI_BOT_MODEL_*` / `OPENAI_*` / `DEEPSEEK_*` 别名）。
 *
 * 为什么值得单测：这是「换供应商只改环境变量」的唯一入口；拼错一个字母的后果是
 * 启动成功、第一个任务失败，而那条错误发生在 pi-host 里，很难直接指回配置项。
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../src/config/index.ts';
import { describeAppConfig, hostModelEnv, readAppConfig } from '../src/app/index.ts';

const base = {
  PI_BOT_PG_DSN: 'postgres://pi:secret@127.0.0.1:5432/pi_bot',
  PI_BOT_WEBHOOK_SECRET: 'whsec',
  PI_BOT_DATA_DIR: '/var/lib/pi-bot',
} as const;

describe('模型端点配置', () => {
  it('PI_BOT_MODEL_* 三件套被读取，base URL 去掉尾部斜杠', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_MODEL_API_KEY: 'sk-test',
      PI_BOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1/',
      PI_BOT_MODEL_NAME: 'deepseek-chat',
    });

    expect(config.model.apiKey).toBe('sk-test');
    expect(config.model.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(config.model.name).toBe('deepseek-chat');
  });

  it('标准别名可用：OPENAI_API_KEY / OPENAI_BASE_URL / PI_BOT_MODEL', () => {
    const config = readAppConfig({
      ...base,
      OPENAI_API_KEY: 'sk-openai',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      PI_BOT_MODEL: 'gpt-4o-mini',
    });

    expect(config.model.apiKey).toBe('sk-openai');
    expect(config.model.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.model.name).toBe('gpt-4o-mini');
  });

  it('DEEPSEEK_* 别名可用，且我们自己的名字优先', () => {
    const config = readAppConfig({
      ...base,
      DEEPSEEK_API_KEY: 'sk-ds',
      PI_BOT_MODEL_API_KEY: 'sk-ours',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      PI_BOT_MODEL_NAME: 'deepseek-chat',
    });

    expect(config.model.apiKey).toBe('sk-ours');
    expect(config.model.baseUrl).toBe('https://api.deepseek.com/v1');
  });

  it('配了 key 却没配模型名 → ConfigError，且提示里点名变量', () => {
    expect(() => readAppConfig({ ...base, PI_BOT_MODEL_API_KEY: 'sk-x' })).toThrow(ConfigError);
    expect(() => readAppConfig({ ...base, PI_BOT_MODEL_API_KEY: 'sk-x' })).toThrow(/PI_BOT_MODEL_NAME/u);
  });

  it('base URL 非法 / 带查询串 / 非 http(s) → ConfigError（不静默修正）', () => {
    expect(() => readAppConfig({ ...base, PI_BOT_MODEL_BASE_URL: 'not-a-url' })).toThrow(ConfigError);
    expect(() =>
      readAppConfig({ ...base, PI_BOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1?x=1' }),
    ).toThrow(ConfigError);
    expect(() => readAppConfig({ ...base, PI_BOT_MODEL_BASE_URL: 'ftp://host/v1' })).toThrow(ConfigError);
  });

  it('什么都没配 → 三项都是 null（本机 dry-run 合法）', () => {
    const config = readAppConfig({ ...base });
    expect(config.model.apiKey).toBeNull();
    expect(config.model.baseUrl).toBeNull();
    expect(config.model.name).toBeNull();
  });

  it('脱敏摘要只报 base/name 与「key 配没配」，不含 key 值', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_MODEL_API_KEY: 'sk-super-secret',
      PI_BOT_MODEL_BASE_URL: 'https://api.deepseek.com/v1',
      PI_BOT_MODEL_NAME: 'deepseek-chat',
    });
    const summary = describeAppConfig(config);

    expect(JSON.stringify(summary)).not.toContain('sk-super-secret');
    expect(summary['model']).toMatchObject({ name: 'deepseek-chat', keyConfigured: true });
  });
});

describe('hostModelEnv（模型端点 → pi-host 环境）', () => {
  it('三项都配时输出六个变量（我们自己的名字 + 标准 OpenAI 名）', () => {
    const config = readAppConfig({
      ...base,
      PI_BOT_MODEL_API_KEY: 'sk-1',
      PI_BOT_MODEL_BASE_URL: 'https://api.mimo.example/v1',
      PI_BOT_MODEL_NAME: 'mimo-7b',
    });

    expect(hostModelEnv(config)).toEqual({
      PI_BOT_MODEL_API_KEY: 'sk-1',
      OPENAI_API_KEY: 'sk-1',
      PI_BOT_MODEL_BASE_URL: 'https://api.mimo.example/v1',
      OPENAI_BASE_URL: 'https://api.mimo.example/v1',
      PI_BOT_MODEL_NAME: 'mimo-7b',
      OPENAI_MODEL: 'mimo-7b',
    });
  });

  it('没配的项不出现（不写空字符串）', () => {
    const config = readAppConfig({ ...base, PI_BOT_MODEL_NAME: 'gpt-4o-mini' });
    expect(hostModelEnv(config)).toEqual({ PI_BOT_MODEL_NAME: 'gpt-4o-mini', OPENAI_MODEL: 'gpt-4o-mini' });
  });
});
