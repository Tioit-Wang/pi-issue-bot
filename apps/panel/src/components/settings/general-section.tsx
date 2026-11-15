/**
 * `general` 分区：仓库身份（只读）、两个开关、不可用的危险动作。
 *
 * 为什么把「身份」和「开关」分成两段：上半段是**安装事件维护的事实**（只读），
 * 下半段是这个仓库**会不会动**（可写）。混在一张卡里，用户分不清哪些是自己的责任。
 *
 * 归档 / 删除没有接口，所以这里只有 `Alert variant="destructive"` 的说明，**不做假按钮**。
 *
 * 每个分区顶部先用一段 `FieldGroup` + `FieldDescription` 回答「这一区的开关代价是什么」：
 * 设置页最容易犯的错不是找不到开关，而是不知道把开关拨过去之后世界会变成什么样。
 */
import { Alert, AlertDescription } from '../ui/alert.tsx';
import { FieldDescription, FieldGroup, FieldTitle } from '../ui/field.tsx';
import { StatusBadge } from '../ui/status-badge.tsx';
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
      <Section first title="仓库身份">
        <FieldGroup className="gap-2">
          <FieldDescription>
            这几行由 GitHub App 安装事件维护，面板只读：要改仓库来源或安装关系，走安装流程（重新安装 / 调整仓库权限），
            本页不提供手写入口。下面的开关才属于你。
          </FieldDescription>
          <FieldGroup className="gap-1.5">
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
                <StatusBadge tone={response.settingsValid ? 'success' : 'danger'}>
                  {response.settingsValid ? '通过' : '不通过'}
                </StatusBadge>
                {response.settingsError === null ? null : (
                  <span className="font-mono text-2xs break-all text-danger-fg">{response.settingsError}</span>
                )}
              </span>
            </MetaRow>
            <MetaRow label="归档">
              {response.archivedAt === null ? (
                <span className="flex flex-wrap items-center gap-1 text-muted-foreground">
                  <StatusBadge tone="neutral">未归档</StatusBadge>
                  <span className="text-xs">归档后本页整页只读</span>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-1">
                  <StatusBadge tone="warn">已归档</StatusBadge>
                  <time className="text-xs text-faint" title={formatTimeCell(response.archivedAt).title}>
                    {formatTimeCell(response.archivedAt).text}
                  </time>
                </span>
              )}
            </MetaRow>
          </FieldGroup>
        </FieldGroup>
      </Section>

      <Section title="启停">
        <FieldGroup className="gap-2">
          <FieldDescription>
            两个开关各管一件事：关掉「接受事件」= 这个仓库的 webhook 一条都不处理（仓库行仍在）；
            关掉「写回 GitHub」= 照常判定但只产出信封与审计，GitHub 上**什么都不会变**（干跑）。
            代价：干跑期间「看起来在工作」，但评论、标签、PR 都停留在面板里。
          </FieldDescription>
          <div className="flex flex-col divide-y divide-border">
            <SwitchField
              id="general-enabled"
              label="接受事件（enabled）"
              description="开启后本仓库的 webhook 事件会进入处理；关闭后一律不处理（仓库行保留）。"
              checked={draft.enabled}
              onChange={(next) => {
                state.update((current) => ({ ...current, enabled: next }));
              }}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
            {/*
              需求：所有开关统一「开启即生效」。
              `dry_run` 是反义字段（true = 不写 GitHub），直接做成开关会出现「关掉才是真写」，
              所以这里用 `checked = !dry_run`，写入时取反，界面语义与其它开关一致。
            */}
            <SwitchField
              id="general-write-github"
              label="写回 GitHub"
              description="开启后评论 / 标签 / reaction 会真的发到 GitHub；关闭时只产出信封与审计（干跑）。"
              checked={!draft.dry_run}
              onChange={(next) => {
                state.update((current) => ({ ...current, dry_run: !next }));
              }}
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          </div>
        </FieldGroup>
      </Section>

      <Section title="危险动作">
        <FieldGroup className="gap-2">
          <FieldDescription>
            下面两件事**面板做不到**，所以没有按钮：不是忘了做，而是没有接口，也不该有。
            这一区的代价写在各自的说明里 —— 点不动的东西不该看起来像能点。
          </FieldDescription>
          <Alert variant="destructive" data-testid="settings-general-archive-note">
            <FieldTitle>归档 / 取消归档（不可用）</FieldTitle>
            <AlertDescription>
              归档由安装事件维护（installation_repositories.removed 会批量置 enabled=false），取消归档由重新安装自动完成；面板不提供手写 archived_at 的入口。
            </AlertDescription>
          </Alert>
          <Alert variant="destructive" data-testid="settings-general-delete-note">
            <FieldTitle>删除仓库记录 / 重建（不可用）</FieldTitle>
            <AlertDescription>
              没有 DELETE /api/repos/:owner/:name，也不该有：删行会连带丢掉 settings / issue_feedback / label_decisions 的归属（这些表按 repo 文本关联）。要从零开始，用「用部署默认覆盖」重置 settings，仓库行不动。
            </AlertDescription>
          </Alert>
        </FieldGroup>
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
