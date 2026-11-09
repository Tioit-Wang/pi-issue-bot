import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config.ts';

/**
 * 面板测试：**jsdom 环境**（组件测试要 DOM），其余继承根配置（`mergeConfig`，根配置改动自动生效）。
 *
 * 为什么 include 写成相对 `apps/panel` 的两组：`src/**` 放与被测代码同目录的单测（`format.test.ts`），
 * `test/**` 放需要夹具的组件/路由测试，避免和源码混在一起。
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: '@pi-issue-bot/panel',
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'test/**/*.test.ts',
        'test/**/*.test.tsx',
        'src/**/*.spec.ts',
        'test/**/*.spec.ts',
      ],
    },
  }),
);
