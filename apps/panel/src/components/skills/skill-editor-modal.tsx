/**
 * 技能编辑器（**模态框**）：左边是技能目录的文件树，右边是纯文本 textarea。
 *
 * 为什么是模态框而不是行内展开：一个技能是**一个目录**（`SKILL.md` + `references/*.md` …），
 * 用户要来回切换文件、还要能整体换掉它；行内展开会把这些挤进列表里，且看不到「我正在改哪个文件」。
 * 抽屉也不合适 —— 它要盖住列表右侧，而这里需要的是「专心改一个技能」。
 *
 * 三条不做的诚实：
 *  - **不渲染 Markdown**：技能正文是提示词，渲染成 HTML 只会带来 XSS 面且看不出空白与换行的差别；
 *  - **不做文件的新建/删除/重命名**（本版只改内容），所以没有「+」按钮，也不假装有；
 *  - **不做乐观更新**：保存 = 服务端生成新版本，`currentVersion` 由服务端决定，猜错要回滚两次。
 *
 * 错误文案一律**原样**展示服务端的 `message`（`不允许在编辑器里改技能名…`、`技能校验不通过：…`），
 * 不翻译成「保存失败」——那句话里带着具体是哪条规则没过。
 */
import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AsyncSection } from '../AsyncSection.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { useToast } from '../ui/toast.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatCount } from '../../lib/format.ts';
import { useSkillFiles, useSkillOverwrite, useSkillSaveFile } from '../../lib/queries.ts';
import {
  buildSkillFileTree,
  defaultSkillFilePath,
  formatBytes,
  isEditableSkillPath,
  utf8ByteLength,
  type SkillTreeNode,
} from '../../lib/skill-files.ts';
import { cn } from '../../lib/utils.ts';
import type { SkillListItem } from '../../../../../packages/contract/src/index.ts';

/** 编辑中的草稿（带上是哪个文件的，避免切换文件时把内容写错地方）。 */
type Draft = { readonly path: string; readonly text: string };

/** 服务端的 `message` 是给人看的中文 —— 400 时原样显示，不替换成「保存失败」。 */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

export function SkillEditorModal({ item, onClose }: { item: SkillListItem; onClose: () => void }) {
  const files = useSkillFiles(item.id);
  const saveFile = useSkillSaveFile();
  const overwrite = useSkillOverwrite();
  const toast = useToast();
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overwriteError, setOverwriteError] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);

  const fileList = useMemo(() => files.data?.files ?? [], [files.data]);
  const tree = useMemo(() => buildSkillFileTree(fileList), [fileList]);
  const activePath = selectedPath ?? defaultSkillFilePath(fileList);
  const activeFile = fileList.find((file) => file.path === activePath);

  const stored = activeFile?.text ?? '';
  // 草稿只对**当前文件**生效：切到别的文件就丢掉（切换前会确认）
  const value = draft !== null && draft.path === activePath ? draft.text : stored;
  const editable = activePath !== null && isEditableSkillPath(activePath);
  const dirty = activePath !== null && draft !== null && draft.path === activePath && draft.text !== stored;

  /** 界面上的「未保存」确认（`window.confirm` 足够：这里只需要一个「真的丢掉吗」的拦截）。 */
  const confirmDiscard = (what: string): boolean =>
    !dirty || window.confirm(`「${activePath ?? ''}」还有未保存的修改，${what}会丢掉它们。继续？`);

  const requestClose = (): void => {
    if (!confirmDiscard('关闭')) return;
    onClose();
  };

  const selectFile = (path: string): void => {
    if (path === activePath) return;
    if (!confirmDiscard('切换文件')) return;
    setSelectedPath(path);
    setDraft(null);
    setSaveError(null);
    setSavedVersion(null);
  };

  const submit = (): void => {
    if (activePath === null || !dirty || saveFile.isPending) return;
    setSaveError(null);
    setSavedVersion(null);
    saveFile.mutate(
      { id: item.id, write: { path: activePath, text: value } },
      {
        // 保留草稿（不置空）：文件列表刷新回来之前 `stored` 还是旧内容，置空会让编辑器闪回旧文本
        onSuccess: (detail) => {
          setSavedVersion(detail.currentVersion);
        },
        onError: (caught) => {
          setSaveError(messageOf(caught));
        },
      },
    );
  };

  /** 编辑器内的 Ctrl/Cmd+S（焦点在树上的时候也生效，挂在整块内容上）。 */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key.toLowerCase() !== 's' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    submit();
  };

  const onPickZip = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    if (dirty && !window.confirm('上传 zip 会整目录覆盖这个技能，未保存的修改会丢掉。继续？')) return;
    setOverwriteError(null);
    overwrite.mutate(
      { id: item.id, file },
      {
        onSuccess: (result) => {
          toast.push({
            tone: 'success',
            title: `已用 zip 覆盖 ${result.skill.name}（v${formatCount(result.version)}）`,
            description: '旧版本仍在版本记录里',
          });
          onClose();
        },
        onError: (caught) => {
          setOverwriteError(messageOf(caught));
        },
      },
    );
  };

  const fileCountText = files.data === undefined ? '读取文件…' : `${formatCount(fileList.length)} 个文件`;

  return (
    <Dialog
      open
      onClose={requestClose}
      size="lg"
      testId="skill-editor-modal"
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate font-mono">{item.name}</span>
          <span className="tabular shrink-0 text-2xs font-normal text-faint" data-testid="skill-editor-version">
            v{formatCount(item.currentVersion)}
          </span>
        </span>
      }
      description={`${fileCountText} · 改任一个文件都会生成新版本`}
      footer={
        <>
          <span className="mr-auto text-2xs tabular text-faint">{formatCount(value.length)} 字符</span>
          <Button variant="secondary" size="sm" onClick={requestClose} data-testid="skill-editor-cancel">
            关闭
          </Button>
          <Button
            size="sm"
            loading={saveFile.isPending}
            disabled={!dirty || !editable}
            title={dirty ? undefined : '没有改动'}
            onClick={submit}
            data-testid="skill-editor-save"
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-2" onKeyDown={onKeyDown} data-testid={`skill-editor-${item.id}`}>
        {item.source === 'builtin' ? (
          <p className="text-2xs leading-relaxed text-muted-foreground" data-testid="skill-editor-hint">
            这是内置技能的副本，保存后即为本项目覆盖。
          </p>
        ) : null}

        <AsyncSection
          isLoading={files.isLoading}
          error={files.error}
          isEmpty={!files.isLoading && files.error == null && fileList.length === 0}
          emptyText="这个技能目录里没有可编辑的文本文件。"
          emptyHint="面板只列出 md / txt / json / yaml / toml；要补文件请打包成 zip 后覆盖本技能。"
          testId="skill-editor-files"
          onRetry={() => {
            void files.refetch();
          }}
          skeleton={<Skeleton className="h-64 w-full rounded-md" />}
        >
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            {/* 左：文件树 + 「上传 zip 覆盖」 */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="micro-label">文件</p>
              <div className="max-h-56 min-w-0 overflow-y-auto rounded-md border border-border bg-card py-0.5 md:max-h-[23rem]">
                <ul className="flex min-w-0 flex-col" data-testid="skill-editor-tree">
                  <FileTree nodes={tree} depth={0} activePath={activePath} onSelect={selectFile} />
                </ul>
              </div>
              <Button
                variant="secondary"
                size="sm"
                loading={overwrite.isPending}
                title="上传一个 zip（≤ 5 MB）整目录覆盖本技能；技能名必须与当前一致"
                onClick={() => {
                  zipInputRef.current?.click();
                }}
                data-testid="skill-editor-upload"
              >
                上传 zip 覆盖本技能
              </Button>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                hidden
                data-testid="skill-editor-upload-input"
                onChange={onPickZip}
              />
              {overwriteError === null ? null : (
                <p
                  role="alert"
                  data-testid="skill-editor-upload-error"
                  className="text-xs leading-relaxed break-words text-danger-fg"
                >
                  覆盖失败：{overwriteError}
                </p>
              )}
            </div>

            {/* 右：当前文件的纯文本 */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span
                  className="min-w-0 truncate font-mono text-xs text-foreground"
                  title={activePath ?? undefined}
                  data-testid="skill-editor-current-path"
                >
                  {activePath ?? '—'}
                </span>
                <span className="shrink-0 tabular text-2xs text-faint">{formatBytes(utf8ByteLength(value))}</span>
              </div>
              <textarea
                aria-label={activePath === null ? `${item.name} 的文件内容` : `${activePath} 的文本内容`}
                data-testid="skill-editor-textarea"
                value={value}
                readOnly={!editable}
                spellCheck={false}
                onChange={(event) => {
                  if (activePath === null) return;
                  setDraft({ path: activePath, text: event.target.value });
                  setSavedVersion(null);
                }}
                className={cn(
                  'h-64 w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 md:h-[22rem]',
                  'whitespace-pre-wrap font-mono text-xs leading-relaxed break-words text-foreground',
                  'transition-[border-color] duration-[var(--dur-fast)] ease-out-quint hover:border-border-strong',
                  'focus-visible:border-brand outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                  editable ? '' : 'cursor-default bg-muted text-muted-foreground',
                )}
              />
              {editable ? null : (
                <p className="text-2xs leading-relaxed text-muted-foreground" data-testid="skill-editor-readonly">
                  只读：面板只编辑 md / txt / json / yaml / toml，其它文件请改完打包成 zip 再覆盖。
                </p>
              )}
              {saveError === null ? null : (
                <p
                  role="alert"
                  data-testid="skill-editor-error"
                  className="text-xs leading-relaxed break-words text-danger-fg"
                >
                  保存失败：{saveError}
                </p>
              )}
              {savedVersion === null ? null : (
                <p role="status" data-testid="skill-editor-saved" className="text-xs text-success-fg">
                  已保存 {activePath ?? ''} · v{formatCount(savedVersion)}
                </p>
              )}
            </div>
          </div>
        </AsyncSection>
      </div>
    </Dialog>
  );
}

/** 递归渲染文件树：目录在前（`名字/`），文件是按钮，当前文件带左侧强调条。 */
function FileTree({
  nodes,
  depth,
  activePath,
  onSelect,
}: {
  nodes: readonly SkillTreeNode[];
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const indent = { paddingLeft: `${String(6 + depth * 12)}px` };
        if (node.kind === 'dir') {
          return (
            <li key={node.path} className="min-w-0" data-testid={`skill-editor-dir-${node.path}`}>
              <div
                className="flex min-w-0 items-center py-1 text-2xs text-faint"
                style={indent}
                title={node.path}
                data-testid="skill-editor-dir-name"
              >
                <span className="min-w-0 truncate font-mono">{node.name}/</span>
              </div>
              <ul className="flex min-w-0 flex-col">
                <FileTree nodes={node.children} depth={depth + 1} activePath={activePath} onSelect={onSelect} />
              </ul>
            </li>
          );
        }
        const active = node.path === activePath;
        return (
          <li key={node.path} className="min-w-0">
            <button
              type="button"
              onClick={() => {
                onSelect(node.path);
              }}
              aria-current={active ? 'true' : undefined}
              title={node.path}
              data-testid={`skill-editor-file-${node.path}`}
              style={indent}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 border-l-2 py-1.5 pr-1.5 text-left',
                'transition-[background-color,color] duration-[var(--dur-fast)] ease-out-quint',
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
                active
                  ? 'border-brand bg-muted text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
              <span className="shrink-0 tabular text-2xs text-faint">{formatBytes(node.bytes)}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}
