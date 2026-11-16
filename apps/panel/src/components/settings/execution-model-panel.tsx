/**
 * 全局设置 · **执行模型**（`CFG-8.2` / `AC-32`）：一行读视图 + 展开编辑。
 *
 * 四条：
 *
 * 1. **只有一档**。执行只有一个模型槽位（pi-host 的 `session/create` / `turn/start` 里没有
 *    模型参数），所以这里不做「四行角色表」——那是「配了也不生效」的界面。
 * 2. **没配也看得见**。未配置时显示「未配置（pi-host 用部署级 env）」，不隐藏 ——
 *    「现在到底用哪个模型」必须一直能回答。
 * 3. **单价来自供应商的模型目录**，目录里没有这个模型时显示 `—`，不写 `$0`
 *    （`$0` 会让人以为这次没花钱）。悬停说明原因。
 * 4. **下拉的选项就是供应商的模型目录本身**：服务端拒「目录里没有的模型」，
 *    面板不该给一个必然被拒的选项；当前值若已经不在目录里（有人删了模型），照样显示并标注。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { ModelProvider, ModelSetting, SaveModelRequest } from '../../lib/contract.ts';
import { EMPTY } from '../../lib/format.ts';
import { useModelProviders, useModelSetting, useSaveModel } from '../../lib/queries.ts';
import { Section } from '../Section.tsx';
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { StatusBadge } from '../ui/status-badge.tsx';
import { describeWriteFailure } from './failures.ts';
import { formatUnitPrice } from './unit-price.ts';

export function ExecutionModelSection() {
  const setting = useModelSetting();
  const providers = useModelProviders();
  const [editing, setEditing] = useState(false);
  const value = setting.data;

  return (
    <Section
      title="执行模型"
      description="pi-host 每个会话只用一个模型：这里是全局默认，项目「执行」里可以覆盖。单价来自所属供应商的模型目录（USD / 1M tokens）；目录里没有这个模型时显示 —，不写 0。"
      actions={<StatusBadge tone="neutral">单档</StatusBadge>}
      footnote="只有一档：pi-host 的协议里没有 per-session 模型参数，多出来的档位会变成「界面上有、实际没用」。"
    >
      {setting.isLoading || providers.isLoading ? (
        <p className="text-xs text-muted-foreground">读取执行模型…</p>
      ) : setting.isError ? (
        <p className="text-xs text-danger-fg" data-testid="system-model-error-load">
          执行模型读取失败：{setting.error instanceof Error ? setting.error.message : '未知错误'}
        </p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="system-model-setting">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-faint">供应商</span>
            <span className="font-mono text-foreground">
              {value?.configured === true ? (value.provider_name ?? value.provider_id ?? EMPTY) : '未配置'}
            </span>
            <span className="text-faint">模型</span>
            <span className="font-mono text-foreground">{value?.configured === true ? (value.model ?? EMPTY) : EMPTY}</span>
            <span className="text-faint">单价（入 / 出）</span>
            {value?.price === null || value === undefined ? (
              <span className="text-faint" title="供应商模型目录里没有这个模型，单价未知（不是 0）">
                {EMPTY}
              </span>
            ) : (
              <span className="tabular text-foreground">
                {formatUnitPrice(value.price.input_usd_per_mtok, value.price.output_usd_per_mtok)}
              </span>
            )}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setEditing((current) => !current);
              }}
              title={editing ? '收起' : '改执行模型用的供应商与模型'}
              data-testid="system-model-edit"
            >
              {editing ? '收起' : '改'}
            </Button>
          </div>
          {value?.configured === true ? null : (
            <p className="text-2xs text-faint">
              未配置时 pi-host 用部署级 env（`PI_BOT_MODEL_*`）：这里配一次就会覆盖它。
            </p>
          )}
          {editing ? (
            <ModelEditor
              setting={value ?? null}
              providers={providers.data?.items ?? []}
              onClose={() => {
                setEditing(false);
              }}
            />
          ) : null}
        </div>
      )}
    </Section>
  );
}

function ModelEditor({
  setting,
  providers,
  onClose,
}: {
  setting: ModelSetting | null;
  providers: readonly ModelProvider[];
  onClose: () => void;
}) {
  const save = useSaveModel();
  const [providerId, setProviderId] = useState(setting?.provider_id ?? '');
  const [model, setModel] = useState(setting?.model ?? '');

  const provider = providers.find((item) => item.id === providerId);
  const known = provider?.models.map((entry) => entry.model) ?? [];
  /*
   * 当前值可能已经不在目录里（有人把模型删了）：把它作为额外一项显示出来，
   * 否则下拉会显示 placeholder，用户会以为「根本没配」。
   */
  const extra = model !== '' && !known.includes(model) ? [model] : [];
  const options = [...extra, ...known];
  const failure = save.error === null ? null : describeWriteFailure(save.error, '保存执行模型');
  const blocked = providerId === '' || model === '' ? '先选供应商与模型' : null;

  const submit = (): void => {
    if (providerId === '' || model === '') return;
    const body: SaveModelRequest = { provider_id: providerId, model };
    save.mutate(body, {
      onSuccess: () => {
        toast.success('已保存执行模型');
        onClose();
      },
    });
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-end gap-2 rounded-md border border-border bg-card/40 p-2"
      data-testid="system-model-form"
    >
      <div className="flex min-w-40 flex-col gap-1">
        <span className="text-2xs text-muted-foreground">供应商</span>
        {/*
          `value` 恒为字符串（空串 = 还没选）：Radix 的受控/非受控切换会告警，
          而「空串」正是它内部表示「没有值」的哨兵，placeholder 照样显示。
        */}
        <Select
          value={providerId}
          onValueChange={(next) => {
            setProviderId(next);
            // 换供应商 = 换模型目录：旧模型名在新家里多半不存在，直接清空让人重选
            setModel('');
          }}
        >
          <SelectTrigger size="sm" aria-label="执行模型的供应商" data-testid="system-model-provider">
            <SelectValue placeholder="选择供应商" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {providers.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  还没有供应商（先在上面登记一家）
                </SelectItem>
              ) : (
                providers.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}（{item.id}）
                  </SelectItem>
                ))
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-48 flex-col gap-1">
        <span className="text-2xs text-muted-foreground">模型</span>
        <Select
          value={model}
          onValueChange={(next) => {
            setModel(next);
          }}
          disabled={providerId === ''}
        >
          <SelectTrigger
            size="sm"
            aria-label="执行模型的模型"
            disabled={providerId === ''}
            title={providerId === '' ? '先选供应商：模型选项来自它的目录' : '选项就是该供应商的模型目录'}
            data-testid="system-model-model"
          >
            <SelectValue placeholder={providerId === '' ? '先选供应商' : '选择模型'} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {options.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  这家还没有登记模型（先在供应商里加一行）
                </SelectItem>
              ) : (
                options.map((name) => {
                  const entry = provider?.models.find((item) => item.model === name);
                  return (
                    <SelectItem key={name} value={name}>
                      {entry === undefined
                        ? `${name}（目录里没有）`
                        : `${name} · ${formatUnitPrice(entry.price.input_usd_per_mtok, entry.price.output_usd_per_mtok)}`}
                    </SelectItem>
                  );
                })
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Button
        size="sm"
        onClick={submit}
        disabled={blocked !== null || save.isPending}
        aria-busy={save.isPending}
        title={blocked ?? '写入 model_default（全局执行模型）'}
        data-testid="system-model-save"
      >
        {save.isPending ? '保存中…' : '保存'}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClose} disabled={save.isPending}>
        取消
      </Button>

      {failure === null ? null : (
        <Alert className="w-full bg-card" data-testid="system-model-error">
          <AlertDescription>
            <span className="text-danger-fg">{failure.message}</span>
            {failure.issues.length === 0 ? null : (
              <ul className="mt-1 flex flex-col gap-0.5 text-2xs">
                {failure.issues.map((issue, index) => (
                  <li key={`${issue.path ?? 'issue'}-${String(index)}`}>
                    {issue.path === null ? null : <code className="mr-1 bg-foreground/10 px-1">{issue.path}</code>}
                    {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
