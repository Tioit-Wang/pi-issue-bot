/**
 * 「预览最终 system prompt」抽屉 —— 直接复用 `ui/dialog.tsx` 的 `Sheet`。
 *
 * 为什么不再自己写一个浮动层：焦点陷阱 / Esc / 焦点归还 / body 锁滚动这四件事
 * `Sheet` 已经做对了，手写一份只会多一处能坏的地方。
 *
 * 三段必须同时出现，否则预览会骗人：
 *  1. `preview.text`：与运行期**同一个装配函数**的产出，原样显示；
 *  2. `stats.truncated`：运行期被整段丢弃的层（「放得下但跑起来被丢」的唯一线索）；
 *  3. `omitted`：这一刻**没能参与**装配的层（预览没有 worktree / registry）。
 */
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.tsx';
import { Sheet } from '../ui/dialog.tsx';
import type { PromptResponse } from '../../lib/contract.ts';
import { formatCount } from '../../lib/format.ts';

export function PromptPreviewDrawer({
  open,
  onClose,
  preview,
  repo,
  version,
}: {
  open: boolean;
  onClose: () => void;
  preview: PromptResponse['preview'];
  repo: string;
  version: number;
}) {
  const stats = preview.stats;
  const layers = [
    ['基座', stats.baseChars],
    ['P1 项目约定', stats.promptChars],
    ['AGENTS.md', stats.agentsChars],
    ['技能', stats.skillChars],
    ['合计', stats.totalChars],
  ] as const;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width="lg"
      testId="prompt-preview"
      title="最终 system prompt 预览"
      description={`${repo} · 当前 v${formatCount(version)} · 与运行期同一装配函数 · ${
        preview.ref === null ? '本次预览没有 worktree（ref@sha 为空）' : `${preview.ref}@${preview.sha ?? 'unknown'}`
      }`}
    >
      <div className="flex min-w-0 flex-col gap-3">
        {stats.truncated.length === 0 ? null : (
          <Alert tone="warn" data-testid="prompt-preview-truncated">
            <AlertTitle>运行期被整段丢弃的层</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {stats.truncated.map((layer) => (
                  <li key={layer}>{layer}</li>
                ))}
              </ul>
              丢的是整段（围栏块 + 分节标题），不切字符；把提示词写短或减少 AGENTS.md 就能放回来。
            </AlertDescription>
          </Alert>
        )}

        {preview.omitted.length === 0 ? null : (
          <Alert tone="neutral" data-testid="prompt-preview-omitted">
            <AlertTitle>这次预览没有参与装配的层</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {preview.omitted.map((layer) => (
                  <li key={layer}>{layer}</li>
                ))}
              </ul>
              与「被丢弃」不同：这些是面板这一侧拿不到（不是运行期也没有）。
            </AlertDescription>
          </Alert>
        )}

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-5">
          {layers.map(([label, value]) => (
            <div key={label}>
              <dt className="text-2xs text-faint">{label}</dt>
              <dd className="tabular text-foreground">{formatCount(value)} 字符</dd>
            </div>
          ))}
        </dl>

        <pre
          className="max-h-[60vh] min-h-0 overflow-auto rounded-md bg-muted p-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground"
          data-testid="prompt-preview-text"
        >
          {preview.text}
        </pre>
      </div>
    </Sheet>
  );
}