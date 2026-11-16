/**
 * 供应商编辑表单（`CFG-8.1`）：名称 / base URL / key / 启用 / 模型目录（含参数）。
 *
 * 四条不可让渡的规则：
 *
 * 1. **三态 key 必须显式**：不填 = 保持不变、填了 = 换新、勾「清空」= 抹掉。三者的请求体
 *    形状不同（无 `key` / 有 `key` / `clear_key: true`），所以状态也分开存，绝不用空串
 *    兼表「清空」—— 一次误触就会把 key 弄没，而后果要等下一次调用才炸（需求 §6.8 note）。
 * 2. **单价挂在模型上**：执行模型的单价从目录解析，所以目录在行内编辑、跟着供应商一起存。
 * 3. **key 明文只在这一次请求里**：表单不写 localStorage、不放进 URL；保存成功后立刻随
 *    折叠卸载（`ProviderEditor` 由父级 `editing/creating` 状态控制）。
 * 4. **参数（上下文窗口 / 输出上限）空着就是「未知」**：`查参数` 只回填空白的格子，
 *    已有值（通常是手填）不覆盖；也不会把「查不到」写成 0 —— 0 会让压缩预算直接崩。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import {
  MAX_CONTEXT_WINDOW_TOKENS,
  MAX_MODEL_OUTPUT_TOKENS,
  MAX_PRICE_USD_PER_MTOK,
  MODEL_NAME_MAX_CHARS,
  MODEL_PROVIDER_ID_RE,
  MODEL_PROVIDER_NAME_MAX_CHARS,
} from '../../../../../packages/contract/src/index.ts';
import type { ModelLookupResponse, ModelProvider, SaveModelProviderRequest } from '../../lib/contract.ts';
import { formatCount } from '../../lib/format.ts';
import { useLookupProviderModels, useSaveModelProvider } from '../../lib/queries.ts';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field.tsx';
import { Input } from '../ui/input.tsx';
import { describeWriteFailure } from './failures.ts';
import { SwitchField, TextField } from './form.tsx';

/** 目录里一行模型的编辑态（数字保持字符串：输入中间态 `0.` 不该被吞掉）。 */
type ModelDraft = {
  model: string;
  input: string;
  output: string;
  /** 上下文窗口（token）；空串 = 未知。 */
  contextWindow: string;
  /** 单次输出上限（token）；空串 = 未知。 */
  maxOutputTokens: string;
};

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  /** 明文新 key；空串 = 保持不变（绝不用空串表示清空）。 */
  key: string;
  clearKey: boolean;
  enabled: boolean;
  models: ModelDraft[];
};

function draftOf(provider: ModelProvider | null): ProviderDraft {
  if (provider === null) {
    return { id: '', name: '', baseUrl: '', key: '', clearKey: false, enabled: true, models: [] };
  }
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.base_url ?? '',
    key: '',
    clearKey: false,
    enabled: provider.enabled,
    models: provider.models.map((entry) => ({
      model: entry.model,
      input: String(entry.price.input_usd_per_mtok),
      output: String(entry.price.output_usd_per_mtok),
      contextWindow: entry.context_window === undefined ? '' : String(entry.context_window),
      maxOutputTokens: entry.max_output_tokens === undefined ? '' : String(entry.max_output_tokens),
    })),
  };
}

/** 一个 token 数字：空串 = 未知（合法）；否则必须是 1..max 的整数。 */
function tokenIssue(raw: string, label: string, max: number): string | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return `${label}：要填 1–${String(max)} 的整数，不填就是「未知」`;
  }
  return null;
}

/** 本地校验：这些错误发出去只会换来一个 400，不如就地说清是哪个字段。 */
export function draftIssues(draft: ProviderDraft, creating: boolean): string[] {
  const issues: string[] = [];
  if (creating && !MODEL_PROVIDER_ID_RE.test(draft.id)) {
    issues.push('id：小写字母数字起头，只含 a-z 0-9 . _ -（≤40 字符）');
  }
  const name = draft.name.trim();
  if (name === '') issues.push('名称：不能为空');
  else if (name.length > MODEL_PROVIDER_NAME_MAX_CHARS) {
    issues.push(`名称：不能超过 ${String(MODEL_PROVIDER_NAME_MAX_CHARS)} 字符`);
  }
  if (draft.key !== '' && draft.key.length < 8) issues.push('key：至少 8 个字符（不填则保持原值）');
  if (draft.key !== '' && draft.clearKey) issues.push('key：换新与清空只能选一个');

  const seen = new Set<string>();
  draft.models.forEach((entry, index) => {
    const at = `第 ${String(index + 1)} 行`;
    const model = entry.model.trim();
    if (model === '') issues.push(`${at}：模型名不能为空`);
    else if (model.length > MODEL_NAME_MAX_CHARS) {
      issues.push(`${at}：模型名超过 ${String(MODEL_NAME_MAX_CHARS)} 字符`);
    } else if (seen.has(model)) issues.push(`${at}：模型名重复（${model}）`);
    if (model !== '') seen.add(model);
    for (const [label, raw] of [
      ['输入', entry.input],
      ['输出', entry.output],
    ] as const) {
      const value = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE_USD_PER_MTOK) {
        issues.push(`${at}：${label}单价格式不对（0–${String(MAX_PRICE_USD_PER_MTOK)} USD / 1M tokens）`);
      }
    }
    for (const [label, raw, max] of [
      ['上下文窗口', entry.contextWindow, MAX_CONTEXT_WINDOW_TOKENS],
      ['最大输出', entry.maxOutputTokens, MAX_MODEL_OUTPUT_TOKENS],
    ] as const) {
      const issue = tokenIssue(raw, `${at}：${label}`, max);
      if (issue !== null) issues.push(issue);
    }
  });
  return issues;
}

/**
 * 请求体：只给**要改的**字段。
 *
 * `base_url` 空串 → `null`（= 用 pi-host 默认端点，这不是「没填」）；`key` 只在填了才带，
 * `clear_key` 只在勾了才带 —— 两个都不带等于「保持原 key」，服务端按这个语义处理。
 * 参数同理：空串不带（`undefined` 表示「还不知道」），不是 0。
 */
export function bodyOf(draft: ProviderDraft): SaveModelProviderRequest {
  const body: SaveModelProviderRequest = {
    name: draft.name.trim(),
    base_url: draft.baseUrl.trim() === '' ? null : draft.baseUrl.trim(),
    enabled: draft.enabled,
    models: draft.models.map((entry) => ({
      model: entry.model.trim(),
      price: {
        input_usd_per_mtok: Number(entry.input),
        output_usd_per_mtok: Number(entry.output),
      },
      ...(entry.contextWindow.trim() === '' ? {} : { context_window: Number(entry.contextWindow) }),
      ...(entry.maxOutputTokens.trim() === '' ? {} : { max_output_tokens: Number(entry.maxOutputTokens) }),
    })),
  };
  if (draft.key !== '') body.key = draft.key;
  if (draft.clearKey) body.clear_key = true;
  return body;
}

/** 新增 / 编辑表单：`provider === null` 表示新增（id 可填）。 */
export function ProviderEditor({ provider, onClose }: { provider: ModelProvider | null; onClose: () => void }) {
  const save = useSaveModelProvider();
  const lookup = useLookupProviderModels();
  const [draft, setDraft] = useState<ProviderDraft>(() => draftOf(provider));
  const [lookupResult, setLookupResult] = useState<{
    readonly data: ModelLookupResponse;
    readonly filled: number;
    readonly skipped: number;
  } | null>(null);
  const creating = provider === null;
  const issues = draftIssues(draft, creating);
  const failure = save.error === null ? null : describeWriteFailure(save.error, '保存供应商');
  const lookupFailure = lookup.error === null ? null : describeWriteFailure(lookup.error, '查参数');

  const patch = (next: Partial<ProviderDraft>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const setModel = (index: number, next: Partial<ModelDraft>): void => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((entry, at) => (at === index ? { ...entry, ...next } : entry)),
    }));
  };

  /**
   * 「查参数」：只回填**空白**格子。
   *
   * 为什么不无脑覆盖：手填过的值是「我知道这家就是 128K」这种本地事实，联网库很可能没有
   * 这家自建端点的条目；覆盖等于把用户的判断擦掉。`skipped` 就在结果里如实报出来。
   */
  const runLookup = (): void => {
    if (provider === null) return;
    const snapshot = draft.models;
    lookup.mutate(provider.id, {
      onSuccess: (data) => {
        let filled = 0;
        let skipped = 0;
        const models = snapshot.map((entry) => {
          const hit = data.items.find((item) => item.model === entry.model.trim());
          if (hit === undefined || !hit.found) return entry;
          const next = { ...entry };
          if (hit.context_window !== null) {
            if (entry.contextWindow.trim() === '') {
              next.contextWindow = String(hit.context_window);
              filled += 1;
            } else {
              skipped += 1;
            }
          }
          if (hit.max_output_tokens !== null) {
            if (entry.maxOutputTokens.trim() === '') {
              next.maxOutputTokens = String(hit.max_output_tokens);
              filled += 1;
            } else {
              skipped += 1;
            }
          }
          return next;
        });
        setDraft((current) => ({ ...current, models }));
        setLookupResult({ data, filled, skipped });
        toast.success(
          filled === 0
            ? '查完了：没有可回填的空格子（已有值不覆盖）'
            : `已回填 ${formatCount(filled)} 条参数`,
        );
      },
    });
  };

  const submit = (): void => {
    if (issues.length > 0) return;
    save.mutate(
      { id: draft.id, body: bodyOf(draft) },
      {
        onSuccess: () => {
          toast.success(creating ? `已新增供应商 ${draft.id}` : `已保存供应商 ${draft.id}`);
          onClose();
        },
      },
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="system-provider-form">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {creating ? (
          <TextField
            id="provider-id"
            label="id"
            mono
            value={draft.id}
            placeholder="anthropic"
            onChange={(next) => {
              patch({ id: next.trim() });
            }}
            hint="路由片段：小写字母数字与 . _ -"
          />
        ) : (
          <TextField
            id="provider-id"
            label="id（不可改）"
            mono
            value={draft.id}
            onChange={() => {
              // id 是路由片段（`/api/settings/providers/:id`）：改名等于换一家，不提供
            }}
            disabled
            disabledReason="id 是接口路径的一部分，不能改；要换 id 请新增一家"
          />
        )}
        <TextField
          id="provider-name"
          label="名称"
          value={draft.name}
          placeholder="Anthropic"
          onChange={(next) => {
            patch({ name: next });
          }}
        />
        <TextField
          id="provider-base-url"
          label="base URL（留空 = pi-host 默认端点）"
          mono
          type="url"
          value={draft.baseUrl}
          placeholder="https://api.anthropic.com/v1"
          onChange={(next) => {
            patch({ baseUrl: next });
          }}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <Field className="min-w-0">
          <FieldLabel htmlFor="provider-key">
            {provider === null || !provider.key_configured ? 'key' : 'key（留空 = 保持现有）'}
          </FieldLabel>
          <Input
            id="provider-key"
            type="password"
            autoComplete="off"
            value={draft.key}
            placeholder={provider === null ? 'sk-…' : (provider.key_mask ?? '已存（无掩码）')}
            disabled={draft.clearKey}
            title={
              draft.clearKey
                ? '已勾选清空：先取消勾选再填新 key'
                : '明文只在这一次请求里存在，服务端落库前加密'
            }
            className="font-mono"
            onChange={(event) => {
              patch({ key: event.target.value });
            }}
          />
          <FieldDescription id="provider-key-hint">
            填了 = 换新；留空 = 保持原值；勾「清空」= 抹掉。三者互斥，避免一次误触把 key 弄没。
          </FieldDescription>
          <FieldLabel className="mt-1 flex items-center gap-1.5 text-xs font-normal" htmlFor="provider-clear-key">
            <input
              id="provider-clear-key"
              type="checkbox"
              checked={draft.clearKey}
              onChange={(event) => {
                patch({ clearKey: event.target.checked, key: event.target.checked ? '' : draft.key });
              }}
            />
            清空已存的 key
          </FieldLabel>
        </Field>

        <SwitchField
          id="provider-enabled"
          label="启用"
          description="停用后不会选它来跑（角色绑定仍在，改回来不用重配）"
          checked={draft.enabled}
          onChange={(next) => {
            patch({ enabled: next });
          }}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="micro-label">模型目录（{formatCount(draft.models.length)} 条）</p>
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              onClick={runLookup}
              disabled={creating || lookup.isPending || draft.models.length === 0}
              aria-busy={lookup.isPending}
              title={
                creating
                  ? '先保存这家供应商，再查参数（查询要用到已存的模型名单）'
                  : draft.models.length === 0
                    ? '目录是空的：先加一行模型'
                    : '联网取上下文窗口与最大输出（OpenRouter 公共库 → 内置表兜底），只填空格子'
              }
              data-testid="system-provider-lookup"
            >
              {lookup.isPending ? '查询中…' : '查参数'}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                patch({
                  models: [
                    ...draft.models,
                    { model: '', input: '0', output: '0', contextWindow: '', maxOutputTokens: '' },
                  ],
                });
              }}
              title="加一行模型；单价是执行模型显示的依据"
              data-testid="system-provider-model-add"
            >
              加一行
            </Button>
          </span>
        </div>

        {lookupResult === null ? null : (
          <Alert className="bg-card" data-testid="system-provider-lookup-note">
            <AlertDescription>
              {`来源：${lookupResult.data.fetched === 'openrouter' ? 'OpenRouter 公共库（刚查到）' : '内置表（DeepSeek v4 / MiMo v2.6）'}`}
              {` · 回填 ${formatCount(lookupResult.filled)} 条`}
              {lookupResult.skipped === 0 ? null : ` · 跳过 ${formatCount(lookupResult.skipped)} 条已有值`}
              {lookupResult.data.note === null ? null : ` · ${lookupResult.data.note}`}
            </AlertDescription>
          </Alert>
        )}

        {draft.models.length === 0 ? (
          <p className="text-2xs text-faint">目录为空：这一家的模型不能被执行模型绑定（服务端会拒）。</p>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5rem_2rem] items-center gap-1 text-2xs text-faint">
              <span>模型</span>
              <span>输入 $/1M</span>
              <span>输出 $/1M</span>
              <span title="上下文窗口（token）；留空 = 未知">上下文</span>
              <span title="单次输出上限（token）；留空 = 未知">最大输出</span>
              <span className="sr-only">操作</span>
            </div>
            {draft.models.map((entry, index) => (
              <div
                key={`${String(index)}-${entry.model}`}
                className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem_5rem_5rem_2rem] items-center gap-1"
              >
                <Input
                  aria-label={`模型 ${String(index + 1)} 名称`}
                  value={entry.model}
                  placeholder="deepseek-v4.1-flash"
                  className="font-mono"
                  onChange={(event) => {
                    setModel(index, { model: event.target.value });
                  }}
                />
                <Input
                  aria-label={`模型 ${String(index + 1)} 输入单价`}
                  type="number"
                  min={0}
                  max={MAX_PRICE_USD_PER_MTOK}
                  step="0.01"
                  value={entry.input}
                  className="tabular"
                  onChange={(event) => {
                    setModel(index, { input: event.target.value });
                  }}
                />
                <Input
                  aria-label={`模型 ${String(index + 1)} 输出单价`}
                  type="number"
                  min={0}
                  max={MAX_PRICE_USD_PER_MTOK}
                  step="0.01"
                  value={entry.output}
                  className="tabular"
                  onChange={(event) => {
                    setModel(index, { output: event.target.value });
                  }}
                />
                <Input
                  aria-label={`模型 ${String(index + 1)} 上下文窗口`}
                  type="number"
                  min={1}
                  max={MAX_CONTEXT_WINDOW_TOKENS}
                  placeholder="未知"
                  value={entry.contextWindow}
                  className="tabular"
                  onChange={(event) => {
                    setModel(index, { contextWindow: event.target.value });
                  }}
                />
                <Input
                  aria-label={`模型 ${String(index + 1)} 最大输出`}
                  type="number"
                  min={1}
                  max={MAX_MODEL_OUTPUT_TOKENS}
                  placeholder="未知"
                  value={entry.maxOutputTokens}
                  className="tabular"
                  onChange={(event) => {
                    setModel(index, { maxOutputTokens: event.target.value });
                  }}
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`删除模型 ${String(index + 1)}`}
                  title="从目录移除这一行（已绑定的角色会变成单价未知）"
                  onClick={() => {
                    patch({ models: draft.models.filter((_entry, at) => at !== index) });
                  }}
                >
                  <span aria-hidden="true">×</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {issues.length > 0 ? (
        <FieldError data-testid="system-provider-form-issues">
          <ul className="flex flex-col gap-0.5">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </FieldError>
      ) : null}

      {lookupFailure === null ? null : (
        <Alert className="bg-card" data-testid="system-provider-lookup-error">
          <AlertDescription>
            <span className="text-danger-fg">{lookupFailure.message}</span>
          </AlertDescription>
        </Alert>
      )}

      {failure === null ? null : (
        <Alert className="bg-card" data-testid="system-provider-form-error">
          <AlertDescription>
            <span className="text-danger-fg">{failure.message}</span>
            {failure.issues.length === 0 ? null : (
              <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
                {failure.issues.map((issue, index) => (
                  <li key={`${issue.path ?? 'issue'}-${String(index)}`}>
                    {issue.path === null ? null : (
                      <code className="mr-1 bg-foreground/10 px-1">{issue.path}</code>
                    )}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={submit}
          disabled={issues.length > 0 || save.isPending}
          aria-busy={save.isPending}
          title={issues.length > 0 ? '上面还有校验问题' : '只发送改动过的字段'}
          data-testid="system-provider-save"
        >
          {save.isPending ? '保存中…' : '保存'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={save.isPending}>
          取消
        </Button>
      </div>
    </div>
  );
}
