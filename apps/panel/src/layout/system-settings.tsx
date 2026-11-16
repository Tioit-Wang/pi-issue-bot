/**
 * 全局设置两块的**出口**（`AC-32` / `CFG-8.1` / `CFG-8.2`）。
 *
 * 为什么要这个只有两行 re-export 的文件：`routes/system.tsx` 从 `layout/` 取这两块，
 * 而实现已经按「供应商（含编辑表单）」与「执行模型」拆成 `components/settings/` 下两个模块
 * （各自 240~380 行，合成一个文件会超过仓库的 500 行上限，也会让两件事的注释挤在一起）。
 * 这里只保留入口路径，页面不需要知道拆分细节。
 *
 * 单价格式化在 `components/settings/unit-price.ts`：供应商目录与执行模型同一口径。
 */
export { ExecutionModelSection } from '../components/settings/execution-model-panel.tsx';
export { ProvidersSection } from '../components/settings/providers-panel.tsx';
