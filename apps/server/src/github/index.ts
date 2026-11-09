/**
 * `github/` 的公开出口（B12）。
 *
 * http session（B10）与 worker session（B13）只从这里 import，不直接摸 `github/*.ts`：
 *  - 取客户端：`createGithubClient` + `createGithubWriteApi`
 *  - 认证：`createAppAuthStrategy` / `createInstallationTokenProvider`
 *  - 错误与限流：`classifyGithubError` / `GithubError` / `parseRateLimitHeaders`
 *  - 写执行器：`dispatchWriteAction` 及各个纯判定函数
 * 依赖方向（tech-plan §8.2）：http/webhook 与 worker 可依赖本目录；本目录**只**依赖 node 内置
 * 与 octokit 相关包，不依赖 db / queue / runtime / sandbox / git，也不依赖 `packages/contract`。
 */
export * from './types.ts';
export * from './headers.ts';
export * from './errors.ts';
export * from './auth.ts';
export * from './octokit.ts';
export * from './executor.ts';
