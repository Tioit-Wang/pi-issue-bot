/**
 * `labels` 分区：词表（vocabulary）、判定映射（map 的 1:N）、白名单（allow）、缺失策略、上限。
 *
 * 三处「看起来是编辑器、其实是契约约束」的地方，界面上必须说清：
 *  - `map` 的值是 `string | string[]`：一个判定键可以打多个标签（`bug → ['bug','needs-repro']`），
 *    界面用逗号分隔表达，只填一个就存成字符串（不落单元素数组，保持落库形状可读）；
 *  - `missing` 的 `create` 是**写动作**：会在仓库里真的建标签，干跑下被跳过；
 *  - `vocabulary` 为空不是错，但模型就没有标签语义可依，所以给一行提示。
 */
import { useState } from 'react';
import type { LabelRole, LabelVocabularyEntry, RepoSettings } from '../../../../../packages/contract/src/index.ts';
import { pipelineLabelCoverage } from '../../../../../packages/contract/src/index.ts';
import { Button } from '../ui/button.tsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field.tsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { StatusBadge } from '../ui/status-badge.tsx';
import { Section } from '../Section.tsx';
import { cn } from '../../lib/utils.ts';
import { ChipEditor, NumberField, SwitchField, TextField } from './form.tsx';
import { SaveBar } from './save-bar.tsx';
import { countChangedPaths } from './settings-chrome.tsx';
import type { SettingsSectionProps } from './section-props.ts';
const COLOR_PATTERN = /^[0-9A-Fa-f]{6}$/u;

/** 词表行的列宽（表头与行共用一份，避免 drift）：name / 角色 / meaning / color / description / group / 操作。 */
const VOCAB_GRID =
  'md:grid-cols-[minmax(5rem,1fr)_4.5rem_minmax(0,1.2fr)_4.5rem_minmax(0,1fr)_4.5rem_3.5rem_4.5rem_auto]';

/** 角色下拉：`role` 是流程分叉依据（契约必填），面板给中文标签，值仍是契约枚举。 */
const ROLE_OPTIONS: readonly { value: LabelRole; label: string }[] = [
  { value: 'requirement', label: '需求' },
  { value: 'defect', label: '缺陷' },
  { value: 'other', label: '其他' },
];

/** `string | string[]` → 输入框里的逗号分隔文本。 */
function targetText(target: string | string[]): string {
  return Array.isArray(target) ? target.join(', ') : target;
}

/** 逗号分隔文本 → 契约值（0 个 = 删除这一项，1 个 = 字符串，多个 = 数组）。 */
function parseTargets(text: string): string | string[] | null {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] ?? '') : parts;
}

const MISSING_OPTIONS: ReadonlyArray<{
  value: RepoSettings['labels']['missing'];
  label: string;
  consequence: string;
}> = [
  {
    value: 'warn',
    label: 'warn（只记日志）',
    consequence: '标签不存在就不打，只记一条 warn。GitHub 上不会多出任何东西，但也看不到这个标签。',
  },
  {
    value: 'create',
    label: 'create（自动建标签）',
    consequence: '缺哪个建哪个：这是写动作，会给仓库新增标签；干跑仓库不执行。颜色/说明取词表里的值。',
  },
  {
    value: 'ignore',
    label: 'ignore（静默跳过）',
    consequence: '不打标，也不记日志。适合「映射里故意留了一些只在别的仓库存在的标签」。',
  },
];

export function LabelsSection({ state }: SettingsSectionProps) {
  const { draft, readOnly } = state;
  const labels = draft.labels;
  const changed = countChangedPaths(state.base, draft).length;

  const patchLabels = (patch: (current: RepoSettings['labels']) => RepoSettings['labels']): void => {
    state.update((current) => ({ ...current, labels: patch(current.labels) }));
  };

  const blankNameIndex = labels.vocabulary.findIndex((entry) => entry.name.trim() === '');
  const badColorIndex = labels.vocabulary.findIndex((entry) => entry.color !== undefined && !COLOR_PATTERN.test(entry.color));
  const emptyTargetKey = Object.entries(labels.map).find(([, value]) => {
    const text = Array.isArray(value) ? value.join('') : value;
    return text.trim() === '';
  })?.[0];
  /**
   * 标签角色覆盖：`requirement` / `defect` 各至少一个词表项。
   *
   * **只提示不阻塞服务端**（`pipelineLabelCoverage()` 的注释说明了为什么放宽），但面板把保存按钮
   * 先禁用：没有这两类角色，分类结论就没有标签可打，流程会「跑得动但看不出结论」。
   */
  const missingRoles = pipelineLabelCoverage({ labels }).missingRoles;
  const coverageReason = missingRoles.length > 0 ? '分类需要至少一个需求标签与一个缺陷标签' : null;


  const blockedReason =
    blankNameIndex >= 0
      ? `词表第 ${String(blankNameIndex + 1)} 条的 name 是空的（服务端会拒绝：name 至少 1 个字符）`
      : badColorIndex >= 0
        ? `词表第 ${String(badColorIndex + 1)} 条的 color 必须是 6 位十六进制（不带 #）`
        : emptyTargetKey !== undefined
          ? `映射「${emptyTargetKey}」还没填标签（标签名至少要 1 个字符；要删这行请点「移除」）`
          : coverageReason;

  const updateVocabulary = (index: number, patch: Partial<LabelVocabularyEntry>): void => {
    patchLabels((current) => ({
      ...current,
      vocabulary: current.vocabulary.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    }));
  };

  const mapEntries = Object.entries(labels.map);
  const setMap = (next: Record<string, string | string[]>): void => {
    patchLabels((current) => ({ ...current, map: next }));
  };

  const renameMapKey = (from: string, to: string): void => {
    const next: Record<string, string | string[]> = {};
    for (const [key, value] of mapEntries) {
      const target = key === from ? to : key;
      if (target === '') continue;
      next[target] = value;
    }
    setMap(next);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="settings-labels">
      <Section
        first
        title="词表"
        actions={
          <span className="text-2xs text-faint tabular">
            {labels.vocabulary.length} / 200
          </span>
        }
      >
        <FieldGroup className="gap-2">
          <FieldDescription>
            词表是<strong>给模型看的标签语义</strong>（`meaning` 会进提示词）。`managed` 决定这个标签参不参与自动对齐：
            关掉 = 不删不加，完全由人管；`status=retired` = GitHub 上已删掉，不再进入目标态。
            代价：词表写得含糊，打标就会含糊；`managed` 全开而词表里有手打的标签，撤标会动到人的标签。
          </FieldDescription>
          {coverageReason === null ? null : (
            <p
              className="text-xs text-warn-fg"
              data-testid="labels-role-coverage"
              title="服务端不会因此拒收（这是面板提示）；但没有对应角色的标签，分类结论就没有标签可打"
            >
              {coverageReason}
              {missingRoles.length === 0 ? '' : `（缺：${missingRoles.map((role) => (role === 'requirement' ? '需求' : '缺陷')).join('、')}）`}
            </p>
          )}
          {labels.vocabulary.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground">
              还没有词表：模型拿不到标签语义，打标质量会下降
            </p>
          ) : (
            /*
              词表是九列表格，而设置页右栏在 1330px 视口下只有 ~723px（左栏 280 + 间距）：
              九列压进 723px 时每列只剩 ~70px，输入值全被截断、每行还会重复画一遍字段标签
              （2026-11-16 实机复核）。所以表头单独一行承担列名，行内标签在 md 以上用 sr-only 隐藏，
              并给整块最小宽度 + 横向滚动兜底 —— 宁可在窄屏横向滚，也不把列压成不可读。
            */
            <div className="flex min-w-0 flex-col gap-2 overflow-x-auto">
              <div
                aria-hidden
                className={cn('hidden min-w-[700px] gap-2 px-1 text-2xs text-faint md:grid', VOCAB_GRID)}
              >
                <span className="truncate">name</span>
                <span className="truncate">角色</span>
                <span className="truncate" title="会注入提示词">meaning</span>
                <span className="truncate">color</span>
                <span className="truncate">description</span>
                <span className="truncate">group</span>
                <span className="truncate">对齐</span>
                <span className="truncate">status</span>
                <span />
              </div>
              {labels.vocabulary.map((entry, index) => (
                <div
                  key={`vocab-${String(index)}`}
                  className={cn(
                    'grid min-w-[700px] grid-cols-2 gap-2 rounded-md border border-border p-2 md:border-0 md:p-0',
                    'md:[&_[data-slot=field-label]]:sr-only',
                    '[&_input]:min-w-0 [&_[role=combobox]]:min-w-0',
                    VOCAB_GRID,
                  )}
                  data-testid={`labels-vocab-row-${String(index)}`}
                >
                  <TextField
                    id={`labels-vocab-name-${String(index)}`}
                    label="name"
                    mono
                    value={entry.name}
                    onChange={(next) => {
                      updateVocabulary(index, { name: next });
                    }}
                    error={entry.name.trim() === '' ? '必填' : null}
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                  {/*
                    角色下拉用官方 Radix `Select`：值仍是契约枚举，展示是中文。
                    名的来源两处都给（`FieldLabel` 的 htmlFor 关联 + `aria-label`），
                    因为 Radix 的 trigger 是 `<button role="combobox">`，不给 `aria-label` 时
                    读屏只会念出当前值，听不出「这是哪一行的哪个字段」。
                  */}
                  <Field className="min-w-0 gap-1">
                    <FieldLabel htmlFor={`labels-vocab-role-${String(index)}`} className="text-xs font-medium">
                      角色
                    </FieldLabel>
                    <Select
                      value={entry.role}
                      disabled={readOnly}
                      onValueChange={(next) => {
                        const picked = ROLE_OPTIONS.find((option) => option.value === next);
                        if (picked === undefined) return;
                        updateVocabulary(index, { role: picked.value });
                      }}
                    >
                      <SelectTrigger
                        id={`labels-vocab-role-${String(index)}`}
                        size="sm"
                        className="w-full"
                        disabled={readOnly}
                        title={readOnly ? '仓库已归档：只读' : '分类结论靠它找标签；需求 / 缺陷各至少一个'}
                        aria-label={`词表第 ${String(index + 1)} 条的角色`}
                        data-testid={`labels-vocab-role-${String(index)}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <TextField
                    id={`labels-vocab-meaning-${String(index)}`}
                    label="meaning"
                    value={entry.meaning ?? ''}
                    placeholder="这个标签意味着什么"
                    onChange={(next) => {
                      updateVocabulary(index, next === '' ? { meaning: undefined } : { meaning: next });
                    }}
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <TextField
                      id={`labels-vocab-color-${String(index)}`}
                      label="color"
                      mono
                      value={entry.color ?? ''}
                      placeholder="d73a4a"
                      onChange={(next) => {
                        updateVocabulary(index, next === '' ? { color: undefined } : { color: next.replace(/^#/u, '') });
                      }}
                      error={entry.color !== undefined && !COLOR_PATTERN.test(entry.color) ? '6 位十六进制' : null}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                    <span className="flex items-center gap-1 text-2xs text-faint">
                      <span
                        aria-hidden
                        className="inline-block size-2.5 rounded-full border border-border"
                        style={{ backgroundColor: entry.color !== undefined && COLOR_PATTERN.test(entry.color) ? `#${entry.color}` : 'transparent' }}
                      />
                      {entry.color === undefined ? '不填 = 用 GitHub 默认色' : `#${entry.color}`}
                    </span>
                  </div>
                  <TextField
                    id={`labels-vocab-description-${String(index)}`}
                    label="description"
                    value={entry.description ?? ''}
                    placeholder="面板里给人看的说明"
                    onChange={(next) => {
                      updateVocabulary(index, next === '' ? { description: undefined } : { description: next });
                    }}
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                  <TextField
                    id={`labels-vocab-group-${String(index)}`}
                    label="group"
                    mono
                    value={entry.group ?? ''}
                    placeholder="severity"
                    onChange={(next) => {
                      updateVocabulary(index, next === '' ? { group: undefined } : { group: next });
                    }}
                    hint="同组互斥"
                    disabled={readOnly}
                    disabledReason="仓库已归档：只读"
                  />
                  {/*
                    目标态字段（v2.1）：`managed` 与 `status` 决定这个标签是否进入自动对齐。
                    关掉 managed = 不删不加，完全由人管；retired = GitHub 上已删除。
                  */}
                  <div className="flex items-end pb-4 md:items-center md:pb-0">
                    <SwitchField
                      id={`labels-vocab-managed-${String(index)}`}
                      label="自动对齐"
                      checked={entry.managed !== false}
                      onChange={(next) => {
                        updateVocabulary(index, { managed: next });
                      }}
                      disabled={readOnly}
                      disabledReason="仓库已归档：只读"
                    />
                  </div>
                  <Field className="min-w-0 gap-1">
                    <FieldLabel htmlFor={`labels-vocab-status-${String(index)}`} className="text-xs font-medium">
                      status
                    </FieldLabel>
                    {/*
                      `status` 的取值只有 active / retired：Radix `Select` 的 trigger 会带
                      `role="combobox"`，名字里必须带 `status` ——「第 3 行的下拉」这种名字
                      在读屏里根本分不清是角色还是状态。
                    */}
                    <Select
                      value={entry.status ?? 'active'}
                      disabled={readOnly}
                      onValueChange={(next) => {
                        updateVocabulary(index, { status: next === 'retired' ? 'retired' : 'active' });
                      }}
                    >
                      <SelectTrigger
                        id={`labels-vocab-status-${String(index)}`}
                        size="sm"
                        className="w-full"
                        disabled={readOnly}
                        title={readOnly ? '仓库已归档：只读' : 'retired = GitHub 上已删除，不再进入目标态'}
                        aria-label={`第 ${String(index + 1)} 行的 status`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">active</SelectItem>
                        <SelectItem value="retired">retired</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex items-end pb-4 md:items-center md:pb-0">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`移除词表项 ${entry.name === '' ? `第 ${String(index + 1)} 条` : entry.name}`}
                      disabled={readOnly}
                      title={readOnly ? '仓库已归档：只读' : '从词表移除'}
                      onClick={() => {
                        patchLabels((current) => ({ ...current, vocabulary: current.vocabulary.filter((_, at) => at !== index) }));
                      }}
                      className="text-muted-foreground hover:text-danger-fg"
                    >
                      移除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                // `role` 在契约里必填（Q4）：空白行先落成 `other`，面板的 role 选择器可以改
                patchLabels((current) => ({
                  ...current,
                  vocabulary: [...current.vocabulary, { name: '', role: 'other' }],
                }));
              }}
              disabled={readOnly || labels.vocabulary.length >= 200}
              title={readOnly ? '仓库已归档：只读' : '加一条空白词表项'}
              data-testid="labels-vocab-add"
            >
              添加词表项
            </Button>
            <span className="text-2xs text-faint">name 必须与仓库里的标签同名，否则按「缺失策略」处理</span>
          </div>
        </FieldGroup>
      </Section>

      <Section title="判定映射（1:N）">
        <FieldGroup className="gap-2">
          <FieldDescription>
            判定键 → 一个或多个标签（逗号分隔）。代价：映射到不存在的标签时按「缺失策略」处理；
            白名单 `allow` 为空表示「映射到什么就打什么」，一旦填了，映射结果之外的一律不打。
          </FieldDescription>
          {mapEntries.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-xs text-muted-foreground">
              还没有映射：判定类会降级成「只判定不打标」并记 warn。
            </p>
          ) : (
            mapEntries.map(([key, value]) => (
              <MapRow
                key={key}
                judgementKey={key}
                value={value}
                allKeys={mapEntries.map(([candidate]) => candidate)}
                readOnly={readOnly}
                onRename={(to) => {
                  renameMapKey(key, to);
                }}
                onTargets={(text) => {
                  const parsed = parseTargets(text);
                  const next: Record<string, string | string[]> = { ...labels.map };
                  if (parsed === null) delete next[key];
                  else next[key] = parsed;
                  setMap(next);
                }}
                onRemove={() => {
                  const next: Record<string, string | string[]> = { ...labels.map };
                  delete next[key];
                  setMap(next);
                }}
              />
            ))
          )}

          <AddMapRow
            readOnly={readOnly}
            existing={mapEntries.map(([candidate]) => candidate)}
            onAdd={(key) => {
              setMap({ ...labels.map, [key]: '' });
            }}
          />

          <div className="mt-1">
            <ChipEditor
              id="labels-allow"
              label="白名单 allow（可选，≤ 100 个）"
              values={labels.allow ?? []}
              onChange={(next) => {
                patchLabels((current) => ({ ...current, allow: next.length === 0 ? undefined : next }));
              }}
              accept={(raw) => {
                const value = raw.trim();
                if (value.length === 0 || value.length > 50) return { error: '标签名 1–50 个字符' };
                return { value };
              }}
              placeholder="bug"
              hint="映射结果不在白名单里的标签一律不打"
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
              emptyText="（不设白名单：映射到什么就打什么）"
            />
          </div>
        </FieldGroup>
      </Section>

      <Section title="缺失标签策略与上限">
        <FieldGroup className="gap-3">
          <FieldDescription>
            策略只影响「映射里写了、但仓库里没有这个标签」时怎么办：`warn` 只记日志，`create` 会**真的建标签**（写动作，干跑跳过），
            `ignore` 静默跳过。代价：选 `create` 就等于允许 agent 往仓库里加东西，颜色与说明取自词表。
          </FieldDescription>
          <RadioGroup
            aria-label="缺失标签策略"
            value={labels.missing}
            disabled={readOnly}
            className="gap-0 divide-y divide-border"
            onValueChange={(next) => {
              const picked = MISSING_OPTIONS.find((option) => option.value === next);
              if (picked === undefined) return;
              patchLabels((current) => ({ ...current, missing: picked.value }));
            }}
          >
            {MISSING_OPTIONS.map((option) => (
              <Field
                key={option.value}
                orientation="horizontal"
                className="items-start gap-2 px-1 py-1.5"
                data-disabled={readOnly ? true : undefined}
              >
                <RadioGroupItem
                  id={`labels-missing-${option.value}`}
                  value={option.value}
                  disabled={readOnly}
                  className="mt-0.5"
                />
                <div className="min-w-0">
                  <FieldLabel
                    htmlFor={`labels-missing-${option.value}`}
                    className="flex flex-wrap items-center gap-1 text-sm font-normal text-foreground"
                  >
                    {option.label}
                    {option.value === 'warn' ? <StatusBadge tone="neutral">默认</StatusBadge> : null}
                    {option.value === 'create' ? <StatusBadge tone="warn">写动作</StatusBadge> : null}
                  </FieldLabel>
                  <FieldDescription>{option.consequence}</FieldDescription>
                </div>
              </Field>
            ))}
          </RadioGroup>

          <div className="max-w-xs">
            <NumberField
              id="labels-max-per-issue"
              label="每 issue 最多打几个标签（1–20）"
              value={labels.max_per_issue}
              min={1}
              max={20}
              onChange={(next) => {
                if (next === undefined) return;
                patchLabels((current) => ({ ...current, max_per_issue: next }));
              }}
              hint="互斥组裁剪之后的硬上限；超出部分按判定顺序丢弃。"
              disabled={readOnly}
              disabledReason="仓库已归档：只读"
            />
          </div>
        </FieldGroup>
      </Section>

      <SaveBar
        saveLabel="保存标签设置"
        dirty={state.dirty}
        changed={changed}
        status={state.status}
        failure={state.failure}
        readOnly={readOnly}
        readOnlyReason="仓库已归档：只读"
        blockedReason={blockedReason}
        onSave={state.save}
        onReset={state.reset}
        testId="settings-labels"
      />
    </div>
  );
}

/** 一行映射：判定键（失焦/回车提交）+ 标签列表 + 删除。 */
function MapRow({
  judgementKey,
  value,
  allKeys,
  readOnly,
  onRename,
  onTargets,
  onRemove,
}: {
  judgementKey: string;
  value: string | string[];
  allKeys: readonly string[];
  readOnly: boolean;
  onRename: (to: string) => void;
  onTargets: (text: string) => void;
  onRemove: () => void;
}) {
  const [keyText, setKeyText] = useState(judgementKey);
  const [error, setError] = useState<string | null>(null);

  const commitKey = (): void => {
    const next = keyText.trim();
    if (next === judgementKey) {
      setError(null);
      return;
    }
    if (next === '') {
      setError('判定键不能为空（要删就点右边的「移除」）');
      return;
    }
    if (allKeys.some((candidate) => candidate !== judgementKey && candidate === next)) {
      setError(`判定键 ${next} 已存在`);
      return;
    }
    setError(null);
    onRename(next);
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]" data-testid={`labels-map-row-${judgementKey}`}>
      <TextField
        id={`labels-map-key-${judgementKey}`}
        label="判定键"
        mono
        value={keyText}
        onChange={(next) => {
          setKeyText(next);
          setError(null);
        }}
        onBlur={commitKey}
        onEnter={commitKey}
        error={error}
        hint={error === null ? '失焦或回车提交改名' : undefined}
        disabled={readOnly}
        disabledReason="仓库已归档：只读"
      />
      <TextField
        id={`labels-map-target-${judgementKey}`}
        label="标签（逗号分隔 = 1:N）"
        value={targetText(value)}
        mono
        placeholder="bug, needs-repro"
        onChange={onTargets}
        disabled={readOnly}
        disabledReason="仓库已归档：只读"
      />
      <div className="flex items-end pb-4 md:items-center md:pb-0">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`移除判定键 ${judgementKey}`}
          disabled={readOnly}
          title={readOnly ? '仓库已归档：只读' : '移除这条映射'}
          onClick={onRemove}
          className="text-muted-foreground hover:text-danger-fg"
        >
          移除
        </Button>
      </div>
    </div>
  );
}

/** 新增映射：输入判定键 + 添加（新行标签先留空，避免写一个猜错的默认值）。 */
function AddMapRow({ readOnly, existing, onAdd }: { readOnly: boolean; existing: readonly string[]; onAdd: (key: string) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (): void => {
    const key = text.trim();
    if (key === '') return;
    if (key.length > 40) {
      setError('判定键最长 40 个字符');
      return;
    }
    if (existing.includes(key)) {
      setError(`判定键 ${key} 已存在`);
      return;
    }
    setError(null);
    setText('');
    onAdd(key);
  };

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
      <div className="min-w-0 max-w-56 flex-1">
        <TextField
          id="labels-map-new"
          label="新增判定键"
          mono
          value={text}
          placeholder="performance"
          onChange={(next) => {
            setText(next);
            setError(null);
          }}
          onEnter={commit}
          error={error}
          disabled={readOnly}
          disabledReason="仓库已归档：只读"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={commit}
        disabled={readOnly || text.trim() === ''}
        title={readOnly ? '仓库已归档：只读' : '加入映射（回车同效）'}
        data-testid="labels-map-add"
      >
        添加映射
      </Button>
    </div>
  );
}