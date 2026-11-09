import { defineConfig } from 'vitest/config';

/**
 * 根 Vitest 配置：只放共享默认值。
 * 各包用自己的 vitest.config.ts 通过 mergeConfig 继承本文件并**覆盖 include**
 * （include 是相对各自 root 的，直接继承根模式会一个测试都匹配不到）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: [
      'apps/**/*.test.ts',
      'apps/**/*.spec.ts',
      'packages/**/*.test.ts',
      'packages/**/*.spec.ts',
      'scripts/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    clearMocks: true,
    restoreMocks: true,
    reporters: ['default'],
  },
});
