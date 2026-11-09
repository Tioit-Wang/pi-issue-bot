/**
 * 信封校验器：Ajv 2020-12 + ajv-formats 的单实例（tech-plan §2.1）。
 *
 * 一个实例到底，理由同 tech-plan：信封与（将来）`racp.schema.json` 用同一份 Ajv 配置，
 * 避免「同一个 JSON 在两套校验器里结论不同」。schema 只编译一次（模块级），
 * 每次校验都是热路径。
 */
// ajv 的 2020 入口是 CJS 包：在 nodenext 下默认导入会被 TS 当成命名空间，
// 因此用**命名导入**（ajv 的 dist/2020.js 显式 `exports.Ajv2020`），运行期与类型都稳。
import { Ajv2020 } from 'ajv/dist/2020.js';
// ajv-formats 只有 default 导出（`module.exports` 就是插件函数本身）。
// nodenext 下 CJS 命名空间的推断不可靠，这里显式标一次类型，运行期取 `default`。
import * as ajvFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { ENVELOPE_JSON_SCHEMA, type TaskEnvelope } from './schema.ts';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

export const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  // 信封不含默认值语义：校验只判断「形状对不对」，不改写数据。
  useDefaults: false,
  coerceTypes: false,
});
addFormats(ajv);

const compiledEnvelope = ajv.compile<TaskEnvelope>(ENVELOPE_JSON_SCHEMA);

/** 一条校验错误（已拍平成可落库的形状）。 */
export interface EnvelopeIssue {
  /** JSON Pointer 风格路径，例如 `/actions/0/body`。 */
  path: string;
  /** Ajv 的 keyword（`required` / `pattern` / `oneOf` …）。 */
  keyword: string;
  message: string;
}

export type EnvelopeValidationResult =
  | { ok: true; envelope: TaskEnvelope }
  | { ok: false; issues: EnvelopeIssue[] };

function toPath(instancePath: string): string {
  return instancePath === '' ? '/' : instancePath;
}

/** 校验一个已解析的值。成功时返回原对象（类型收窄为 `TaskEnvelope`）。 */
export function validateEnvelope(value: unknown): EnvelopeValidationResult {
  const valid = compiledEnvelope(value);
  if (valid) {
    return { ok: true, envelope: value as TaskEnvelope };
  }
  const issues = (compiledEnvelope.errors ?? []).map((error) => ({
    path: toPath(error.instancePath),
    keyword: error.keyword,
    message: error.message ?? '校验失败',
  }));
  return { ok: false, issues };
}

/**
 * 校验一段 JSON 文本（agent 的原始产出）。
 * JSON 语法错误也走同一个返回形状——调用方只需要区分「能入库」与「不能入库」。
 */
export function parseEnvelopeJson(text: string): EnvelopeValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '/', keyword: 'json-parse', message: error instanceof Error ? error.message : 'JSON 解析失败' }],
    };
  }
  return validateEnvelope(parsed);
}

/** 把校验错误压成一行，用于日志与 `run_events.payload.reason`（CLAUDE 风格的短摘要）。 */
export function summarizeIssues(issues: readonly EnvelopeIssue[]): string {
  const head = issues.slice(0, 3).map((issue) => `${issue.path} ${issue.keyword}: ${issue.message}`);
  const rest = issues.length > 3 ? ` …（共 ${issues.length} 条）` : '';
  return head.join('; ') + rest;
}
