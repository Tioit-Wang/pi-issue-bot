/**
 * 由 zod 契约生成 OpenAPI 3.1 文档（E8 裁定：单一事实源是 `packages/contract/src/**`）。
 *
 * 运行：
 *   pnpm --filter @pi-issue-bot/contract gen:openapi      # 或根 `pnpm gen:openapi`
 *
 * 产物：`openapi/pi-bot.openapi.json`（入 git，面板用 `openapi-typescript` 生成类型）。
 * 之所以入 git 而不是构建期生成：面板 session 与后端 session 并行，产物必须在仓库里可读，
 * 否则面板只能等后端跑起来才能开工。
 *
 * 三条约定：
 * 1. 组件名 = `src/schemas.ts` 注册表的键，**只许加不许改名**；
 * 2. 生成结果必须确定性（组件名排序、2 空格缩进、结尾换行），否则每次 diff 都是噪音；
 * 3. 不手写任何 DTO：查询参数也从 zod 推导，避免「文档说一套、校验做一套」。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

import { CONTRACT_VERSION, AUDIT_EXPORT_LIMIT } from '../src/index.ts';
import { querySchemas, responseSchemas } from '../src/schemas.ts';

type Json = Record<string, unknown>;

interface Endpoint {
  method: 'get' | 'post';
  path: string;
  operationId: string;
  tag: string;
  summary: string;
  /** 查询参数来自哪个 zod schema（推导 parameters）。 */
  query?: keyof typeof querySchemas;
  /** 路径参数名。 */
  pathParam?: string;
  /** 200 响应体的组件名。 */
  response?: keyof typeof responseSchemas;
  /** 非 JSON 响应（CSV）时的 content-type 与说明。 */
  nonJson?: { contentType: string; description: string };
  /** 是否要请求体（webhook）。 */
  requestBody?: boolean;
  /** 是否需要面板会话鉴权（/api/* 需要）。 */
  authenticated: boolean;
  /** 额外的错误状态码。 */
  errors: number[];
}

const ENDPOINTS: readonly Endpoint[] = [
  {
    method: 'get',
    path: '/api/overview',
    operationId: 'getOverview',
    tag: 'panel',
    summary: '吞吐、结果分布、p50/p95、队列深度、熔断状态、doctor 摘要',
    query: 'overviewQuery',
    response: 'OverviewResponse',
    authenticated: true,
    errors: [400, 401, 403, 503],
  },
  {
    method: 'get',
    path: '/api/tasks',
    operationId: 'listTasks',
    tag: 'panel',
    summary: '任务列表（仓库/状态/失败分类/时间范围/命令类型 + 游标分页）',
    query: 'tasksQuery',
    response: 'TasksResponse',
    authenticated: true,
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/api/tasks/{id}',
    operationId: 'getTask',
    tag: 'panel',
    summary: '任务详情：runs、事件时间线、信封、动作、diff',
    pathParam: 'id',
    response: 'TaskDetailResponse',
    authenticated: true,
    errors: [400, 401, 403, 404],
  },
  {
    method: 'get',
    path: '/api/costs',
    operationId: 'getCosts',
    tag: 'panel',
    summary: '按仓库/命令/模型拆分的 token 与金额，以及最贵十个任务',
    query: 'costsQuery',
    response: 'CostsResponse',
    authenticated: true,
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/api/quality/reverts',
    operationId: 'getReverts',
    tag: 'panel',
    summary: '「自动执行后被人改回」的次数与比例，按命令与仓库',
    query: 'qualityQuery',
    response: 'RevertsResponse',
    authenticated: true,
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/api/audit',
    operationId: 'getAudit',
    tag: 'panel',
    summary: '审计查询：谁触发、跑哪个 sha、写了什么、审批判定',
    query: 'auditQuery',
    response: 'AuditResponse',
    authenticated: true,
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/api/audit/export.csv',
    operationId: 'exportAuditCsv',
    tag: 'panel',
    summary: `审计流式导出（CSV，最多 ${AUDIT_EXPORT_LIMIT} 行）`,
    query: 'auditQuery',
    nonJson: {
      contentType: 'text/csv; charset=utf-8',
      description: 'CSV 文本，首行为表头（列顺序见 `packages/contract/src/api.ts` 的 AUDIT_CSV_COLUMNS）',
    },
    authenticated: true,
    errors: [400, 401, 403],
  },
  {
    method: 'get',
    path: '/api/system',
    operationId: 'getSystem',
    tag: 'panel',
    summary: 'host 版本与能力、pi-host 状态、队列配置、保留期、仓库与技能清单',
    response: 'SystemResponse',
    authenticated: true,
    errors: [401, 403],
  },
  {
    method: 'post',
    path: '/webhook',
    operationId: 'receiveWebhook',
    tag: 'webhook',
    summary: 'GitHub 投递（原始 body 验签 → 去重 → 入队；handler 内 10 秒内应答）',
    response: 'WebhookAcceptedResponse',
    requestBody: true,
    authenticated: false,
    errors: [400, 401, 413, 503],
  },
];

/** 递归收集 `$defs`，并把 `#/$defs/X` 改写成 `#/components/schemas/X`。 */
function extractDefs(node: unknown, defs: Map<string, Json>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => extractDefs(item, defs));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const record = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === '$defs' && value !== null && typeof value === 'object') {
      for (const [defName, defValue] of Object.entries(value as Json)) {
        const collected = extractDefs(defValue, defs) as Json;
        const existing = defs.get(defName);
        if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(collected)) {
          throw new Error(`组件名冲突：${defName} 在两处生成出了不同结构，必须改名（契约只许加不许改）`);
        }
        defs.set(defName, collected);
      }
      continue;
    }
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
      out[key] = `#/components/schemas/${value.slice('#/$defs/'.length)}`;
      continue;
    }
    if (key === '$schema') {
      // OpenAPI 3.1 的文档级 $schema 已经声明 2020-12，组件内不再重复。
      continue;
    }
    out[key] = extractDefs(value, defs);
  }
  return out;
}

function toJsonSchema(schema: z.ZodType, io: 'input' | 'output', defs: Map<string, Json>): Json {
  const generated = schema.toJSONSchema({ target: 'draft-2020-12', io }) as Json;
  return extractDefs(generated, defs) as Json;
}

/** 从查询 schema 推导 OpenAPI 的 query 参数（不手写第二份）。 */
function queryParameters(name: keyof typeof querySchemas, defs: Map<string, Json>): Json[] {
  const schema = toJsonSchema(querySchemas[name], 'input', defs);
  const properties = (schema['properties'] ?? {}) as Record<string, Json>;
  const required = new Set((schema['required'] as string[] | undefined) ?? []);
  return Object.entries(properties).map(([paramName, paramSchema]) => ({
    name: paramName,
    in: 'query',
    required: required.has(paramName),
    description: typeof paramSchema['description'] === 'string' ? paramSchema['description'] : undefined,
    schema: paramSchema,
  }));
}

/** 错误响应的说明文案（按状态码查表，不写嵌套三元）。 */
const ERROR_DESCRIPTION: Readonly<Record<number, string>> = {
  400: '参数不合法（`{error:{code:"bad-request"}}`）',
  401: '未登录 / 会话过期 / 签名校验失败（`{error:{code:"unauthorized"}}`）',
  403: '已登录但不是组织成员（`{error:{code:"forbidden"}}`）',
  404: '资源不存在（`{error:{code:"not-found"}}`）',
  413: '请求体过大（`{error:{code:"payload-too-large"}}`）',
  503: '服务降级（`{error:{code:"unavailable"}}`，例如 doctor fail 或 DB 不可用）',
};

function errorResponse(status: number): Json {
  return {
    description: ERROR_DESCRIPTION[status] ?? '错误',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/ErrorBody' } },
    },
  };
}

/** 只有 `$ref` 一项且指向自己 → 这是「收集 $defs 时先占位」的 stub，要用真实定义覆盖。 */
function isSelfRef(name: string, value: Json): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && value['$ref'] === `#/components/schemas/${name}`;
}

function buildDocument(): Json {
  const defs = new Map<string, Json>();
  const components = {} as Record<string, Json>;
  for (const name of Object.keys(responseSchemas).sort()) {
    const schema = responseSchemas[name as keyof typeof responseSchemas];
    components[name] = toJsonSchema(schema, 'output', defs);
  }

  const paths: Record<string, Json> = {};
  for (const endpoint of ENDPOINTS) {
    const parameters: Json[] = [];
    if (endpoint.pathParam !== undefined) {
      parameters.push({
        name: endpoint.pathParam,
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 64 },
      });
    }
    if (endpoint.query !== undefined) {
      parameters.push(...queryParameters(endpoint.query, defs));
    }

    const responses: Json = {};
    if (endpoint.nonJson !== undefined) {
      responses['200'] = {
        description: endpoint.nonJson.description,
        content: { [endpoint.nonJson.contentType]: { schema: { type: 'string' } } },
      };
    } else if (endpoint.response !== undefined) {
      responses['200'] = {
        description: '成功',
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/${endpoint.response}` } },
        },
      };
    }
    for (const status of endpoint.errors) {
      responses[String(status)] = errorResponse(status);
    }

    const operation: Json = {
      operationId: endpoint.operationId,
      summary: endpoint.summary,
      tags: [endpoint.tag],
      parameters,
      responses,
    };
    if (endpoint.authenticated) {
      operation['security'] = [{ sessionCookie: [] }];
    }
    if (endpoint.requestBody === true) {
      operation['requestBody'] = {
        required: true,
        description: 'GitHub webhook 原始载荷（验签用 raw body，不能先经 JSON 反序列化）',
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
      };
      operation['security'] = [{ githubSignature: [] }];
    }

    paths[endpoint.path] = {
      ...(paths[endpoint.path] ?? {}),
      [endpoint.method]: operation,
    };
  }

  // `$defs` 里收集到的子 schema 也要进组件表（排序保证确定性）。
  for (const name of [...defs.keys()].sort()) {
    const current = components[name];
    if (current === undefined || isSelfRef(name, current)) {
      components[name] = defs.get(name) as Json;
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'pi-issue-bot · 面板 API + webhook',
      version: CONTRACT_VERSION,
      description: [
        '单一事实源：`packages/contract/src/**`（zod）。本文件由 `pnpm gen:openapi` 生成，不要手改。',
        '全局约定：时间 ISO8601 UTC（带 Z）、金额 USD 保留 4 位、token 与耗时是整数（耗时单位毫秒）、',
        '比例 0–1（不乘 100）、`null` 与 `0` 必须可区分、游标分页 `cursor`/`limit`、',
        '错误统一 `{error:{code,message,details?}}`。',
      ].join('\n'),
    },
    servers: [{ url: '/', description: '单机部署，Caddy 反代到 127.0.0.1:3000' }],
    tags: [
      { name: 'panel', description: '面板只读接口（需要面板会话）' },
      { name: 'webhook', description: 'GitHub 投递入口（HMAC 验签）' },
    ],
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sid',
          description: '面板会话（服务端 `panel_sessions` 表，cookie 只放 sid；401 = 未登录，403 = 非组织成员）',
        },
        githubSignature: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Hub-Signature-256',
          description: 'GitHub webhook HMAC-SHA256（`sha256=<hex>`），校验失败一律 401',
        },
      },
    },
  };
}

function main(): void {
  const document = buildDocument();
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const outFile = join(repoRoot, 'openapi', 'pi-bot.openapi.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const pathCount = Object.keys(document['paths'] as Json).length;
  const schemaCount = Object.keys((document['components'] as Json)['schemas'] as Json).length;
  process.stdout.write(`openapi: ${pathCount} paths / ${schemaCount} schemas -> ${outFile}\n`);
}

main();
