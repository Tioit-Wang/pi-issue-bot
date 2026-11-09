/**
 * 查询层的**注入形状**（PM 裁定 E12 已冻结，这里只是消费方声明）。
 *
 * 两条取舍：
 *  1. **类型从 `queries/` 取，不在这里手抄一份**：E12 要求「双向必须一致」，两份声明必然漂移。
 *     这里只做一处 `export type` 转出，http 各路由 import 的是同一个类型。
 *  2. **值仍然靠注入**（`registerApiRoutes(app, { queries, requireAuth })`）：http 只认「能回答这些问题的对象」，
 *     不认它的构造函数 —— `serve` 里 `createQueries({ pool })` 装配，测试里传假实现，两边都不用改路由。
 *
 * 为什么 `import type` 而不用相对路径取实现：`import type` 在编译后完全擦除，
 * http 与 queries 之间不存在运行期耦合；真正的耦合点在装配处（`buildServer` 的 `queries` 字段）。
 */
export type { Queries } from '../../queries/index.ts';
