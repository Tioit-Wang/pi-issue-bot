/**
 * `@pi-issue-bot/racp-client` —— RACP-WS 客户端（tech-plan §4 / §2.5 自研项 S1）。
 *
 * 对外只经本文件导出，分五层，装配顺序也是这个顺序：
 *
 * | 模块 | 职责 | 装配时你会用到的 |
 * |---|---|---|
 * | `frames.ts` | JSON-RPC 2.0 帧编解码、严格校验、id 序列、在飞表 | 基本不用；`RacpClient` 已在内部用 |
 * | `transport.ts` | 三个握手常量、loopback/Bearer 前置校验、连接生命周期 | `RACP_WS_PATH` / `RACP_WS_SUBPROTOCOL` / `buildRacpUrl` / `buildAuthorizationHeader`（doctor、PIN 校验） |
 * | `client.ts` | 请求/响应配对、每调用超时、断线拒在飞、事件分发 | `new RacpClient({ port, token, expectedHostVersion })` → `connect()` → `onEvent()` |
 * | `ops.ts` | tech-plan §4.4 白名单 operation 的类型化方法 | `new RacpOps(client)` → `sessionCreate()` / `turnStart()` … |
 * | `errors.ts` / `schema.ts` / `redact.ts` | 错误分类、契约守卫、值级脱敏 | `RacpError.code` / `failureClass`；`Session`/`Turn`/`EventEnvelope` 类型 |
 *
 * 三条装配纪律（写在这里是因为最容易踩）：
 * 1. `connect()` 只做「建连 + initialize + 版本比对」；`events/subscribe` 要自己调，游标自己存。
 * 2. 断线后**不会**自动重连、不会重发在飞调用（`HOST_DISCONNECTED`）；重连与重试用
 *    `apps/server/src/runtime` 的退避逻辑，重试必须带同一个 `idempotencyKey`。
 * 3. 本包不引 logger；错误消息与 `details` 已在 `RacpError` 构造时做过值级脱敏。
 */

export * from './errors.ts';
export * from './schema.ts';
export * from './redact.ts';
export * from './frames.ts';
export * from './transport.ts';
export * from './client.ts';
export * from './ops.ts';
