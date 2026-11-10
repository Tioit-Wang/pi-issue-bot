/**
 * `general` 分区：仓库身份（只读）、两个开关、不可用的危险动作。
 *
 * 为什么把「身份」和「开关」分成两段：上半段是**安装事件维护的事实**（只读），
 * 下半段是这个仓库**会不会动**（可写）。混在一张卡里，用户分不清哪些是自己的责任。
 *
 * 归档 / 删除没有接口，所以这里只有 `Alert tone="danger"` 的说明，**不做假按钮**。
 */
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Badge } from '../ui/badge.tsx';
import { Section } from '../Section.tsx';
import { formatTimeCell } from '../../lib/format.ts';
import { MetaRow, SwitchField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';

export function GeneralSection({ state }: SettingsSectionProps) {
  const { response, draft, readOnly } = state;
  const changed = countChangedPaths(state.base, draft).length;

  return (
    <div className="flex flex-col gap-6" data-testid="settings-general">
      <Section first title="仓库身份" description="由安装事件维护；改动要走安装流程">
        <div className="flex flex-col gap-1.5">
          <MetaRow label="仓库">
            <span className="font-mono" data-testid="settings-general-repo">
              {response.repo}
            </span>
          </MetaRow>
          <MetaRow label="来源">
            <span data-testid="settings-general-source">
              {response.source === 'installation' ? 'GitHub App 安装' : '面板手动添加'}
            </span>
          </MetaRow>
          <MetaRow label="安装 id">
            <span className="font-mono">{response.installationId ?? '—（手动添加没有 installation）'}</span>
          </MetaRow>
          <MetaRow label="配置校验">
            <span className="flex flex-wrap items-center gap-1">
              <Badge tone={response.settingsValid ? 'success' : 'danger'}>
                {response.settingsValid ? '通过' : '不通过'}
              </Badge>
              {response.settingsError === null ? null : (
                <span className="font-mono text-2xs break-all text-danger-fg">{response.settingsError}</span>
              )}
            </span>
          </MetaRow>
          <MetaRow label="归档">
            {response.archivedAt === null ? (
              <span className="flex flex-wrap items-center gap-1 text-muted-foreground">
                <Badge tone="neutral">未归档</Badge>
                <span className="text-xs">归档后本页整页只读</span>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-1">
                <Badge tone="warn">已归档</Badge>
                <time className="text-xs text-faint" title={formatTimeCell(response.archivedAt).title}>
                  {formatTimeCell(response.archivedAt).text}
                </time>
              </span>
            )}
          </MetaRow>
        </div>
      </Section>

      <Section title="启停与干跑">
        <div className="flex flex-col divide-y divide-border">
          <SwitchField
            id="general-enabled"
            label="接受事件（enabled）"
            description="关掉后该仓库的任何 webhook 事件都不处理：不建任务、不打标、不评论。仓库行保留。"
            checked={draft.enabled}
            onChange={(next) => {
              state.update((current) => ({ ...current, enabled: next }));
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
          <SwitchField
            id="general-dry-run"
            label="干跑（dry_run）"
            description="干跑：不产生任何 GitHub 写动作（连 reaction 都不打），只产出信封与审计。关掉 = 真写 GitHub。"
            checked={draft.dry_run}
            onChange={(next) => {
              state.update((current) => ({ ...current, dry_run: next }));
            }}
            disabled={readOnly}
            disabledReason="仓库已归档：只读"
          />
        </div>
      </Section>

      <Section title="危险动作">
        <div className="flex flex-col gap-2">
          <Alert tone="danger" data-testid="settings-general-archive-note">
            <AlertTitle>归档 / 取消归档（不可用）</AlertTitle>
            <AlertDescription>
              归档由安装事件维护（installation_repositories.removed 会批量置 enabled=false），取消归档由重新安装自动完成；面板不提供手写 archived_at 的入口。
            </AlertDescription>
          </Alert>
          <Alert tone="danger" data-testid="settings-general-delete-note">
            <AlertTitle>删除仓库记录 / 重建（不可用）</AlertTitle>
            <AlertDescription>
              没有 DELETE /api/repos/:owner/:name，也不该有：删行会连带丢掉 settings / issue_feedback / label_decisions 的归属（这些表按 repo 文本关联）。要从零开始，用「用部署默认覆盖」重置 settings，仓库行不动。
            </AlertDescription>
          </Alert>
        </div>
      </Section>

      <SaveBar
        saveLabel="保存通用设置"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读。重新安装 App 或清掉 archived_at 才能改。"
        onSave={state.save}
        onReset={state.reset}
        testId="settings-general"
      />
    </div>
  );
}