import { describe, expect, it } from 'vitest';
import * as shared from './index.ts';

// 骨架阶段的冒烟测试：证明本包的 vitest 配置继承了根配置、并且能直接跑 TS 源码。
// TODO(后端 owner session)：换成真实单元测试。
describe('@pi-issue-bot/shared 骨架', () => {
  it('模块可以加载（当前只有占位导出）', () => {
    expect(shared).toBeTypeOf('object');
  });
});
