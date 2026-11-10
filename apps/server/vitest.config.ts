import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.config.ts';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: '@pi-issue-bot/server',
      include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'src/**/*.spec.ts', 'test/**/*.spec.ts'],
      /**
       * 真 PG 用例共用一个库（`pi_issue_bot_test`）：`truncate` 与断言交错时，
       * 并行的测试文件会互相把对方的行删掉，表现为随机失败（本机反复复现：
       * config-repo-config / http-server / sandbox-shim 轮流红，单独跑必绿）。
       * 这里按文件串行，代价约 20 秒，换确定性。
       */
      fileParallelism: false,
    },
  }),
);
