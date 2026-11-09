import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config.ts';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: '@pi-issue-bot/racp-client',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'src/**/*.spec.ts', 'test/**/*.spec.ts'],
    },
  }),
);
