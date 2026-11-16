/**
 * 全局设置 · 供应商（`CFG-8.1` / `AC-32`）：一条一行，可改、可测连通性。
 *
 * 四条硬约束，改这个文件前先读：
 *
 * 1. **key 只显示掩码**。契约 `ModelProvider` 没有 `key` 字段（只有 `key_configured`
 *    与 `key_mask`），所以这不是「记得别显示」，是拿不到；写入时明文只在一次请求里
 *    存在，服务端落库前加密（`I9`）。表单本身在 `provider-form.tsx`。
 * 2. **连通性测试失败也是正常结果**：服务端即便测不通也回 200 + `status:'fail'`，
 *    这一行画状态点与原因，不当错误横幅；只有请求本身被拒才是错误。
 * 3. **测完以本次结果为准**：列表 15s 才轮询回来，测完还显示旧点会让人以为没生效。
 * 4. 单价挂在**模型**上（执行模型的单价从目录解析），所以目录跟着供应商一起编辑。
 */
import { useState } from 'react';
import type { ModelProvider } from '../../lib/contract.ts';
import { EMPTY, formatDuration, formatTimeCell } from '../../lib/format.ts';
import { useCheckModelProvider, useModelProviders } from '../../lib/queries.ts';
import { Section } from '../Section.tsx';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { StatusBadge, StatusDot } from '../ui/status-badge.tsx';
import { describeWriteFailure } from './failures.ts';
import { ProviderEditor } from './provider-form.tsx';
import { formatModelLimits } from './token-size.ts';
import { formatUnitPrice } from './unit-price.ts';

const PROVIDER_STATUS_LABEL: Record<ModelProvider['status'], string> = {
  ok: '连通',
  fail: '不通',
  unknown: '未测',
};

const PROVIDER_STATUS_TONE: Record<ModelProvider['status'], 'success' | 'danger' | 'neutral'> = {
  ok: 'success',
  fail: 'danger',
  unknown: 'neutral',
};

export function ProvidersSection() {
  const providers = useModelProviders();
  const items = providers.data?.items ?? [];
  const [creating, setCreating] = useState(false);

  return (
    <Section
      title="供应商"
      count={providers.data === undefined ? undefined : items.length}
      description="base URL · key 掩码 · 连通性 · 可用 model；单价单位是 USD / 1M tokens。密钥真值只在宿主进程里解密使用，面板永远拿不到。"
      actions={
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setCreating(true);
          }}
          disabled={creating}
          title={creating ? '正在新增一家供应商' : '登记一家新的 OpenAI 兼容端点（自建端点按同一表单填）'}
          data-testid="system-provider-add"
        >
          新增
        </Button>
      }
      footnote="key 加密存储、只在宿主进程解密；这里显示的掩码是服务端算的，面板既没有密钥也没有解密能力。"
    >
      {creating ? (
        <div className="mb-2 rounded-md border border-border bg-card/40 p-2">
          <ProviderEditor
            provider={null}
            onClose={() => {
              setCreating(false);
            }}
          />
        </div>
      ) : null}

      {providers.isLoading ? (
        <p className="text-xs text-muted-foreground">读取供应商清单…</p>
      ) : providers.isError ? (
        <p className="text-xs text-danger-fg" data-testid="system-providers-error">
          供应商清单读取失败：{providers.error instanceof Error ? providers.error.message : '未知错误'}
        </p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="system-providers-empty">
          还没有登记任何供应商（迁移 0013 之后才有这张表；库里为空）。点右上「新增」登记一家。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="system-providers">
          {items.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** 一行：只读信息（`AC-32` 断言的那些）+ 测连通性 + 展开编辑。 */
function ProviderRow({ provider }: { provider: ModelProvider }) {
  const [editing, setEditing] = useState(false);
  const check = useCheckModelProvider();
  const failure = check.error === null ? null : describeWriteFailure(check.error, '测试连通性');
  // 测过之后以本次结果为准（列表 15s 后才轮询回来，不该让用户对着旧点发呆）
  const status = check.data?.status ?? provider.status;
  const latency = check.data === undefined ? provider.latency_ms : check.data.latency_ms;
  const checkError = check.data === undefined ? provider.check_error : check.data.error;

  return (
    <li data-testid={`system-provider-${provider.id}`} className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs font-semibold text-foreground">{provider.name}</span>
        <span className="font-mono text-2xs text-faint">{provider.id}</span>
        <StatusBadge tone={provider.enabled ? 'success' : 'neutral'} dot>
          {provider.enabled ? '启用' : '停用'}
        </StatusBadge>
        {/* 连通性：状态点 + 延迟（CFG-8.1「状态点 + 延迟，可手动测试」） */}
        <span
          className="inline-flex items-center gap-1 text-2xs"
          data-testid={`system-provider-status-${provider.id}`}
        >
          <StatusDot tone={PROVIDER_STATUS_TONE[status]} label={PROVIDER_STATUS_LABEL[status]} />
          <span className="text-muted-foreground">{PROVIDER_STATUS_LABEL[status]}</span>
          <span className="tabular text-foreground">{formatDuration(latency)}</span>
          {check.data !== undefined ? (
            <span className="text-faint">· 刚测于 {formatTimeCell(check.data.checked_at).text}</span>
          ) : provider.checked_at === null ? null : (
            <span className="text-faint">· 测于 {formatTimeCell(provider.checked_at).text}</span>
          )}
        </span>
        {checkError === null ? null : (
          <span className="min-w-0 flex-1 truncate text-2xs text-danger-fg" title={checkError}>
            {checkError}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              check.mutate(provider.id);
            }}
            disabled={check.isPending}
            aria-busy={check.isPending}
            title={
              provider.key_configured
                ? '向这家端点发一次最小请求，量往返延迟'
                : '还没配 key：测试会失败并告诉你缺什么'
            }
            data-testid={`system-provider-check-${provider.id}`}
          >
            {check.isPending ? '测试中…' : '测连通性'}
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setEditing((current) => !current);
            }}
            title={editing ? '收起编辑' : '改名称 / base URL / key / 模型目录'}
            data-testid={`system-provider-edit-${provider.id}`}
          >
            {editing ? '收起' : '编辑'}
          </Button>
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={provider.base_url ?? undefined}>
          baseURL {provider.base_url ?? `${EMPTY}（用 pi-host 默认端点）`}
        </span>
        <span className="font-mono" data-testid={`system-provider-key-${provider.id}`}>
          {provider.key_configured ? `key ${provider.key_mask ?? '已存（无掩码）'}` : 'key 未配置'}
        </span>
      </div>

      {/* 可用 model 列表 + 单价（CFG-8.1「该家可用的 model 列表」） */}
      {provider.models.length === 0 ? (
        <span className="text-2xs text-faint">没有登记可用 model（目录为空）</span>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-1" data-testid={`system-provider-models-${provider.id}`}>
          {provider.models.map((entry) => (
            <li key={entry.model} className="flex items-baseline gap-1 rounded-sm bg-muted px-1.5 py-0.5">
              <span className="font-mono text-2xs text-foreground">{entry.model}</span>
              <span className="tabular text-2xs text-faint">
                {formatUnitPrice(entry.price.input_usd_per_mtok, entry.price.output_usd_per_mtok)}
              </span>
              {/*
                参数（CFG-8.1 扩展）：未知就整段不渲染 —— 显示「上下文 未知 · 输出 未知」会把
                每个 chip 都撑长一倍，而「没填」本身就是这一行的现状。
              */}
              {formatModelLimits(entry.context_window, entry.max_output_tokens) === null ? null : (
                <span
                  className="tabular text-2xs text-faint"
                  data-testid={`system-provider-limits-${provider.id}-${entry.model}`}
                  title={`精确值：上下文 ${entry.context_window === undefined ? '未知' : String(entry.context_window)} / 输出 ${entry.max_output_tokens === undefined ? '未知' : String(entry.max_output_tokens)} token`}
                >
                  {formatModelLimits(entry.context_window, entry.max_output_tokens)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {failure === null ? null : (
        <Alert className="bg-card" data-testid={`system-provider-check-error-${provider.id}`}>
          <AlertDescription>
            <span className="text-danger-fg">{failure.message}</span>
          </AlertDescription>
        </Alert>
      )}

      {editing ? (
        <div className="mt-1 rounded-md border border-border bg-card/40 p-2">
          <ProviderEditor
            provider={provider}
            onClose={() => {
              setEditing(false);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
