import { tableFeatures } from '@tanstack/react-table';

/**
 * 表格特性集合（TanStack Table **v9** 要求显式声明，v8 的隐式行为已取消）。
 *
 * 面板的表格全是「服务端分页 + 只读」：排序/筛选/分页都由后端做，前端只用核心行模型，
 * 所以这里是空对象。将来要加排序（例如成本表按列排）时，
 * 在这里加 `rowSortingFeature` + `sortedRowModel: createSortedRowModel()`，一个地方生效。
 *
 * **必须模块级单例**：每次渲染新建 `features` 会让行模型缓存全部失效（v9 的稳定输入要求）。
 */
export const panelTableFeatures = tableFeatures({});
