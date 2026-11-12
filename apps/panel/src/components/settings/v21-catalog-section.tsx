/**
 * v2.1「标签目录」分区（`docs/v21-contract.md` §1 / FR-5.4 / §6.5 / BR-11）。
 *
 * 与旧的 `labels-section.tsx` 是**同一份数据**（`settings.labels.vocabulary`）的两个视角：
 * 旧分区管 v0.3 的「词表 + 判定映射 + 缺失策略」，这一区只补 v2.1 新增的两个字段
 * （`managed` / `status`）与「目录即全量」的判定口径。两份**都保留**：删掉旧分区会让
 * 存量配置（映射表、白名单、缺失策略）失去编辑入口。
 *
 * 这一屏要回答的问题是「**目标态包含哪些标签**」：
 *  - `meaning` 为空 → 执行侧不知道它是什么意思，**不参与自动对齐**（不删也不加）；
 *  - `managed=false` → 人明确要自己管，同样不参与（BR-11 的保护）；
 *  - `status='retired'` → GitHub 上已经删了，留在目录里只为让历史记录仍能解释。
 *
 * 所以每一行右侧直接标出「参与 / 不参与 + 原因」：这是本分区最有价值的一列，
 * 否则用户改完四个字段也不知道自己到底动了什么。
 */
import type { LabelStatus, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { LABEL_MEANING_MAX_CHARS } from '../../../../../packages/contract/src/index.ts';
import { Badge } from '../ui/badge.tsx';
import { Section } from '../Section.tsx';
import { Select } from '../ui/select.tsx';
import { cn } from '../../lib/utils.ts';
import { SwitchField, TextField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';

/** 词表条目的类型（`managed` / `status` 在契约里是可选的，缺省按 true / active 解释）。 */
type VocabularyEntry = RepoSettings['labels']['vocabulary'][number];

/** 目录行的列宽（表头与行共用一份，避免 drift）。 */
const CATALOG_GRID = 'md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_6rem_auto_minmax(0,7rem)_auto]';

const ROLE_LABEL: Record<string, string> = {
  requirement: '需求',
  defect: '缺陷',
  other: '其他',
};

const STATUS_OPTIONS: ReadonlyArray<{ value: LabelStatus; label: string }> = [
  { value: 'active', label: 'active（在用）' },
  { value: 'retired', label: 'retired（已删）' },
];

/** 「参与自动对齐」的判定（§6.5）：与 `resolveManagedCatalog()` 的写回侧口径一致。 */
function alignmentReason(entry: VocabularyEntry): string | null {
  if (entry.status === 'retired') return '已 retired：不进目标态';
  if (entry.managed === false) return 'managed=false：不自动管';
  if ((entry.meaning ?? '').trim() === '') return 'meaning 为空：不敢删也不敢加';
  return null;
}

/**
 * 目录里重复的 name（**大小写不敏感**，与 `repoSettingsSchema` 的 superRefine 同口径：
 * GitHub 侧标签名也不区分大小写）。返回全部重名项，便于一次改完。
 *
 * 为什么自己写而不是从契约 import：契约里那个 `firstDuplicate()` 是模块私有的实现细节
 * （只返回第一个），面板需要「全部重名」才能一次列清。规则本身很短，重复 6 行比把
 * 私有函数提成导出（改 packages/**）更符合本轮的分工约束。
 */
function findDuplicateLabelNames(entries: readonly VocabularyEntry[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase();
    if (key === '') continue;
    if (seen.has(key)) {
      if (!duplicates.includes(entry.name.trim())) duplicates.push(entry.name.trim());
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

export function V21CatalogSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const vocabulary = draft.labels.vocabulary;
  const changed = countChangedPaths(state.base, draft).length;

  const duplicateNames = findDuplicateLabelNames(vocabulary);
  const blankNameIndex = vocabulary.findIndex((entry) => entry.name.trim() === '');
  const longMeaningIndex = vocabulary.findIndex(
    (entry) => (entry.meaning ?? '').length > LABEL_MEANING_MAX_CHARS,
  );
  const participating = vocabulary.filter((entry) => alignmentReason(entry) === null).length;

  const blockedReason =
    blankNameIndex >= 0
      ? `第 ${String(blankNameIndex + 1)} 行的 name 是空的（服务端会拒收：name 至少 1 个字符）`
      : duplicateNames.length > 0
        ? `目录里重复的 name：${duplicateNames.join('、')}`
        : longMeaningIndex >= 0
          ? `第 ${String(longMeaningIndex + 1)} 行的 meaning 超过 ${String(LABEL_MEANING_MAX_CHARS)} 字符`
          : null;

  const patchLabels = (patch: (current: RepoSettings['labels']) => RepoSettings['labels']): void => {
    state.update((current) => ({ ...current, labels: patch(current.labels) }));
  };

  const patchEntry = (index: number, patch: Partial<VocabularyEntry>): void => {
    patchLabels((current) => ({
      ...current,
      vocabulary: current.vocabulary.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    }));
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-catalog">
      <Section
        first
        title="目录（目标态的唯一依据）"
        description="只有「active + managed + 有 meaning」的标签会进自动对齐；其余只留在目录里供人查"
        actions={
          <span className="text-2xs text-faint tabular" data-testid="v21-catalog-participating">
            参与对齐 {String(participating)} / {String(vocabulary.length)}
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          {vocabulary.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground">
              目录为空：执行侧不会删也不会加任何标签（安全侧）。先在「标签」分区加词表项。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div aria-hidden className={cn('hidden gap-2 px-1 text-2xs text-faint md:grid', CATALOG_GRID)}>
                <span>name</span>
                <span>meaning（为空 = 不参与对齐）</span>
                <span>group</span>
                <span>managed</span>
                <span>status</span>
                <span />
              </div>

              {vocabulary.map((entry, index) => {
                const reason = alignmentReason(entry);
                return (
                  <div
                    key={`catalog-${String(index)}`}
                    className={cn(
                      'grid min-w-0 grid-cols-2 gap-2 rounded-md border border-border p-2 md:border-0 md:p-0',
                      CATALOG_GRID,
                    )}
                    data-testid={`v21-catalog-row-${String(index)}`}
                  >
                    <TextField
                      id={`v21-catalog-name-${String(index)}`}
                      label="name"
                      mono
                      value={entry.name}
                      onChange={(next) => {
                        patchEntry(index, { name: next });
                      }}
                      error={entry.name.trim() === '' ? '必填' : null}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <TextField
                      id={`v21-catalog-meaning-${String(index)}`}
                      label="meaning"
                      value={entry.meaning ?? ''}
                      placeholder="这个标签意味着什么"
                      onChange={(next) => {
                        patchEntry(index, next === '' ? { meaning: undefined } : { meaning: next });
                      }}
                      error={(entry.meaning ?? '').length > LABEL_MEANING_MAX_CHARS ? '太长了' : null}
                      hint={reason === 'meaning 为空：不敢删也不敢加' ? '留空 = 不参与自动对齐' : undefined}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <TextField
                      id={`v21-catalog-group-${String(index)}`}
                      label="group"
                      mono
                      value={entry.group ?? ''}
                      placeholder="severity"
                      onChange={(next) => {
                        patchEntry(index, next === '' ? { group: undefined } : { group: next });
                      }}
                      hint="同组互斥"
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <SwitchField
                      id={`v21-catalog-managed-${String(index)}`}
                      label={`参与自动对齐（${entry.name.trim() === '' ? `第 ${String(index + 1)} 行` : entry.name.trim()}）`}
                      description="关掉 = managed=false：这个标签不删不加，完全由人管。"
                      checked={entry.managed !== false}
                      onChange={(next) => {
                        patchEntry(index, { managed: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <label
                        htmlFor={`v21-catalog-status-${String(index)}`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        status
                      </label>
                      <Select
                        id={`v21-catalog-status-${String(index)}`}
                        options={STATUS_OPTIONS}
                        placeholder={null}
                        value={entry.status ?? 'active'}
                        disabled={readOnly}
                        title={readOnly ? '仓库已归档：只读' : 'retired = GitHub 上已删除，不再进入目标态'}
                        aria-label={`第 ${String(index + 1)} 行的 status`}
                        onChange={(event) => {
                          const next = STATUS_OPTIONS.find((option) => option.value === event.target.value);
                          if (next === undefined) return;
                          patchEntry(index, { status: next.value });
                        }}
                        className="h-[var(--control-sm)]"
                        data-testid={`v21-catalog-status-${String(index)}`}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 md:justify-end">
                      <span className="flex items-center gap-1" data-testid={`v21-catalog-align-${String(index)}`}>
                        <Badge tone={reason === null ? 'success' : 'neutral'}>
                          {reason === null ? '参与对齐' : '不参与'}
                        </Badge>
                        <span className="text-2xs text-faint">{ROLE_LABEL[entry.role] ?? entry.role}</span>
                      </span>
                      <button
                        type="button"
                        aria-label={`从目录移除 ${entry.name.trim() === '' ? `第 ${String(index + 1)} 行` : entry.name.trim()}`}
                        disabled={readOnly}
                        title={readOnly ? '仓库已归档：只读' : '从词表移除（同时从目录移除）'}
                        onClick={() => {
                          patchLabels((current) => ({
                            ...current,
                            vocabulary: current.vocabulary.filter((_, at) => at !== index),
                          }));
                        }}
                        className="h-8 rounded-md border border-border px-2 text-xs text-muted-foreground transition-[color,border-color,background-color] duration-[120ms] ease-out-quint hover:border-danger/50 hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        移除
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="v21-catalog-add"
              onClick={() => {
                // `role` 在契约里必填：新行先落成 other（分类结论用不到它），角色在「标签」分区改
                patchLabels((current) => ({
                  ...current,
                  vocabulary: [
                    ...current.vocabulary,
                    { name: '', role: 'other', managed: true, status: 'active' },
                  ],
                }));
              }}
              disabled={readOnly || vocabulary.length >= 200}
              title={readOnly ? '仓库已归档：只读' : '加一行空白目录项'}
              className="h-8 rounded-md border border-border px-2 text-xs text-foreground transition-[background-color,color] duration-[120ms] ease-out-quint hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              添加目录项
            </button>
            <span className="text-2xs text-faint">
              提示：meaning 为空或 managed=false 的标签不参与自动对齐（不删不加）。
            </span>
          </div>

          {duplicateNames.length > 0 ? (
            <p className="text-xs text-danger-fg" role="alert" data-testid="v21-catalog-duplicate">
              目录里重复的 name：{duplicateNames.join('、')}（服务端会拒收：重名会让「打哪个标签」变得不确定）
            </p>
          ) : null}
        </div>
      </Section>

      <SaveBar
        saveLabel="保存标签目录"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-catalog"
      />
    </div>
  );
}
