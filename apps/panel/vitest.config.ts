import { fileURLToPath } from 'node:url';
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
    /*
     * `@/*` 别名：面板源码（含 shadcn 官方组件）用 `@/components/ui/x.tsx` 这样的路径，
     * vite.config.ts 里已给 bundler 配了同一份别名；测试走 vitest 自己的解析，
     * 不在这里配一次，组件测试会因为找不到 `@/...` 直接炸（不是断言失败，是解析失败）。
     */
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
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
