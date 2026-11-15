/**
 * 全局设置的两块只读视图（`AC-32` / CFG-8.1 / CFG-8.2）：
 * **供应商**（名称 / baseURL / key 掩码 / 连通性状态点 + 延迟 / 可用 model）与
 * **四档模型角色**（agent / format / classify / fallback 各带输入 / 输出单价）。
 *
 * 三条硬约束：
 *
 * 1. **key 只显示掩码，绝不请求真值**。契约 `ModelProvider` 没有 `key` 字段（只有
 *    `key_configured` 与 `key_mask`，`packages/contract/src/api.ts:1292`），所以这不是
 *    「记得别显示」，是**拿不到** —— 面板既没有密钥，也没有解密能力（`I9`）。
 * 2. **单价未知就说未知**。`price` 为 `null` 表示「供应商模型目录里没有这个模型」，
 *    此时显示 `—`，不写 `$0.0000`（那会让人以为这次没花钱）。
 * 3. **四档必须都在**。`GET /api/settings/models` 固定回四行，没配的那档
 *    `configured: false` —— 隐藏它等于让用户以为「只有三档」。
 *
 * 本版**不做写入口**（改 key / 改单价）：那些是写接口 + CSRF + 密钥入参，
 * `FR-7.5` 要求缺接口时画禁用态并在 `title` 写清缺哪个接口，而不是留一个静默失败的表单。
 */
import { StatusBadge, StatusDot } from '../components/ui/status-badge.tsx';
import { Section } from '../components/Section.tsx';
import type { ModelProvider, ModelRoleRow } from '../lib/contract.ts';
import { EMPTY, formatCount, formatDuration, formatTimeCell } from '../lib/format.ts';
import { useModelProviders, useModelRoles } from '../lib/queries.ts';

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

const ROLE_LABEL: Record<ModelRoleRow['role'], string> = {
  agent: '执行（agent）',
  format: '快速（format）',
  classify: '分类（classify）',
  fallback: '降级（fallback）',
};

/**
 * 单价（USD / 1M tokens）：`$3.00 / $15.00`。
 *
 * 为什么不复用 `formatUsd`（4 位小数）：那是「一次花掉多少钱」的口径；这里是价目表，
 * 每百万 token 3 美元写成 `$3.0000` 只会让人以为精度更高。单位写在脚注里说明。
 */
export function formatUnitPrice(input: number, output: number): string {
  return `$${trimPrice(input)} / $${trimPrice(output)}`;
}

/** 价目表用两位小数够（超过两位的单价没有供应商这么报）；整数不带小数点尾巴。 */
function trimPrice(value: number): string {
  const fixed = value.toFixed(2);
  return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
}

export function ProvidersSection() {
  const providers = useModelProviders();
  const items = providers.data?.items ?? [];

  return (
    <Section
      title="供应商"
      count={providers.data === undefined ? undefined : items.length}
      description="base URL · key 掩码 · 连通性 · 可用 model；单价单位是 USD / 1M tokens。密钥真值只在宿主进程里解密使用，面板永远拿不到。"
      actions={<StatusBadge tone="neutral">只读</StatusBadge>}
      footnote="本版不提供改 key / 新增供应商的写入口（需要 POST /api/settings/providers 一类的写接口 + 密钥入参），因此这里只呈现现状。"
    >
      {providers.isLoading ? (
        <p className="text-xs text-muted-foreground">读取供应商清单…</p>
      ) : providers.isError ? (
        <p className="text-xs text-danger-fg" data-testid="system-providers-error">
          供应商清单读取失败：{providers.error instanceof Error ? providers.error.message : '未知错误'}
        </p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="system-providers-empty">
          还没有登记任何供应商（迁移 0013 之后才有这张表；库里为空）。
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="system-providers">
          {items.map((provider) => (
            <li
              key={provider.id}
              data-testid={`system-provider-${provider.id}`}
              className="flex min-w-0 flex-col gap-1 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-xs font-semibold text-foreground">{provider.name}</span>
                <span className="font-mono text-2xs text-faint">{provider.id}</span>
                <StatusBadge tone={provider.enabled ? 'success' : 'neutral'} dot>
                  {provider.enabled ? '启用' : '停用'}
                </StatusBadge>
                {/* 连通性：状态点 + 延迟（CFG-8.1「状态点 + 延迟，可手动测试」） */}
                <span className="inline-flex items-center gap-1 text-2xs" data-testid={`system-provider-status-${provider.id}`}>
                  <StatusDot
                    tone={PROVIDER_STATUS_TONE[provider.status]}
                    label={PROVIDER_STATUS_LABEL[provider.status]}
                  />
                  <span className="text-muted-foreground">{PROVIDER_STATUS_LABEL[provider.status]}</span>
                  <span className="tabular text-foreground">{formatDuration(provider.latency_ms)}</span>
                  {provider.checked_at === null ? null : (
                    <span className="text-faint">· 测于 {formatTimeCell(provider.checked_at).text}</span>
                  )}
                </span>
                {provider.check_error === null ? null : (
                  <span className="min-w-0 flex-1 truncate text-2xs text-danger-fg" title={provider.check_error}>
                    {provider.check_error}
                  </span>
                )}
              </div>

              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                <span className="min-w-0 truncate font-mono" title={provider.base_url ?? undefined}>
                  baseURL {provider.base_url ?? `${EMPTY}（用 pi-host 默认端点）`}
                </span>
                <span className="font-mono" data-testid={`system-provider-key-${provider.id}`}>
                  {provider.key_configured
                    ? `key ${provider.key_mask ?? '已存（无掩码）'}`
                    : 'key 未配置'}
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
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ModelRolesSection() {
  const roles = useModelRoles();
  const items = roles.data?.items ?? [];

  return (
    <Section
      title="模型角色（四档）"
      description="每档一行：绑定的供应商 + 模型 + 输入 / 输出单价（USD / 1M tokens）。单价来自所属供应商的模型目录；目录里没有这个模型时显示 —，不写 0。"
      actions={<StatusBadge tone="neutral">只读</StatusBadge>}
      footnote="项目页只显示「继承全局（模型名）」，不并列摆放可否直接选的下拉 —— 两处并列会让「生效的到底是哪个」变成猜谜。"
    >
      {roles.isLoading ? (
        <p className="text-xs text-muted-foreground">读取四档角色…</p>
      ) : roles.isError ? (
        <p className="text-xs text-danger-fg" data-testid="system-roles-error">
          四档角色读取失败：{roles.error instanceof Error ? roles.error.message : '未知错误'}
        </p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="system-roles-empty">
          接口没有返回任何角色行（契约要求固定四行，返回空说明服务端未注册 `/api/settings/models`）。
        </p>
      ) : (
        <table className="w-full min-w-[26rem] text-xs" data-testid="system-model-roles">
          <thead>
            <tr className="text-faint">
              <th scope="col" className="py-1 text-left font-normal">角色</th>
              <th scope="col" className="py-1 text-left font-normal">供应商</th>
              <th scope="col" className="py-1 text-left font-normal">模型</th>
              <th scope="col" className="py-1 text-right font-normal" title="单价：USD / 1M tokens（输入 / 输出）">
                单价（入 / 出）
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((row) => (
              <tr key={row.role} data-testid={`system-role-${row.role}`}>
                <td className="py-1 text-foreground">{ROLE_LABEL[row.role] ?? row.role}</td>
                <td className="py-1 font-mono text-muted-foreground">
                  {row.configured ? (row.provider_name ?? row.provider_id ?? EMPTY) : '未配置'}
                </td>
                <td className="py-1 font-mono text-foreground">{row.configured ? (row.model ?? EMPTY) : EMPTY}</td>
                <td className="py-1 text-right tabular">
                  {row.price === null ? (
                    <span className="text-faint" title="供应商模型目录里没有这个模型，单价未知（不是 0）">
                      {EMPTY}
                    </span>
                  ) : (
                    <span className="text-foreground">
                      {formatUnitPrice(row.price.input_usd_per_mtok, row.price.output_usd_per_mtok)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {items.length === 0 ? null : (
        <p className="mt-1 text-2xs text-faint">
          {`已配置 ${formatCount(items.filter((row) => row.configured).length)} / ${formatCount(items.length)} 档`}
        </p>
      )}
    </Section>
  );
}
