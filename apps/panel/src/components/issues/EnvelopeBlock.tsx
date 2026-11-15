/**
 * 信封原文折叠块（`AC-30`：agent 一轮里 `verdict` / `actions` **默认收起**）。
 *
 * 三件事刻意这么做：
 * 1. **默认收起**：`<details>` 不带 `open`，也不用受控 state —— 收起 / 展开交给浏览器，
 *    面板不维护第二份「展开过没有」；
 * 2. **原样显示前 4 000 字符**，超出就截断并写清「原文共多少、这里显示多少」。
 *    为什么不整段塞进 DOM：v2.1 单条评论上限 60 000 字，一轮 `actions` 理论可达 ~1 MB，
 *    整段渲染会让「打开一条 issue」变成一次白屏（理由详见 `lib/envelope-text.ts`）；
 * 3. `verdict` / `actions` **各一个**折叠块：v2.1 允许只给 `actions` 不给 `verdict`，
 *    合成一块会让「这一半没有」看起来像「整块都没有」。
 *
 * 两个字段都缺失（响应里没这两个键）时**不渲染**：画一个永远空着的折叠块只会让人反复点它。
 * 契约缺字段这件事在原文卡与系统提示词两处已经如实报过，不重复刷屏。
 */
import type { IssueTurn } from '../../lib/contract.ts';
import { formatCount } from '../../lib/format.ts';
import { hasEnvelope, readEnvelopeField, type EnvelopeField } from '../../lib/envelope-text.ts';

export function EnvelopeBlock({ turn }: { turn: IssueTurn }) {
  const verdict = readEnvelopeField(turn, 'verdict');
  const actions = readEnvelopeField(turn, 'actions');
  if (!hasEnvelope(verdict, actions)) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1 pl-3" data-testid="issue-turn-envelope">
      <EnvelopeDetail
        label="verdict"
        hint="模型这一轮交的结论原文（envelopes.verdict）"
        field={verdict}
        testId="issue-turn-verdict"
      />
      <EnvelopeDetail
        label="actions"
        hint="模型这一轮想做的动作原文（envelopes.actions）—— 不是执行结果，落地了哪几条要看任务详情"
        field={actions}
        testId="issue-turn-actions"
      />
    </div>
  );
}

/** 标题右侧那一句：`12 字符` / `本轮没有` / `响应里没有这个字段`。 */
function fieldCaption(field: EnvelopeField): string {
  if (field.state === 'value') return `${formatCount(field.totalChars)} 字符`;
  return field.state === 'null' ? '本轮没有' : '响应里没有这个字段';
}

/** 一个信封字段：默认收起；展开是原样 JSON + 截断说明。 */
function EnvelopeDetail({
  label,
  hint,
  field,
  testId,
}: {
  label: string;
  hint: string;
  field: EnvelopeField;
  testId: string;
}) {
  return (
    <details className="rounded-md border border-border bg-card" data-testid={testId}>
      <summary
        className="flex cursor-pointer items-center gap-2 px-2 py-1 text-2xs text-muted-foreground select-none hover:text-foreground"
        data-testid={`${testId}-summary`}
      >
        <span aria-hidden className="text-faint">▸</span>
        <span className="font-mono font-semibold text-foreground/80">{label}</span>
        <span className="min-w-0 flex-1 truncate" title={hint}>
          {fieldCaption(field)}
        </span>
        {field.truncated ? <span className="shrink-0 text-faint">已截断</span> : null}
      </summary>
      <div className="border-t border-border px-2 py-1.5">
        {field.state === 'absent' ? (
          <p className="text-2xs text-muted-foreground">
            响应里没有这个字段（旧服务端 / mock 夹具）：这是契约缺字段，不是「模型没交」。
          </p>
        ) : field.state === 'null' ? (
          <p className="text-2xs text-muted-foreground">
            本轮没有这一项（服务端返回 null）—— 与「交了空对象」不同，这里是**真的没有**。
          </p>
        ) : (
          <>
            <pre
              className="max-h-[20rem] overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words"
              data-testid={`${testId}-text`}
            >
              {field.text}
            </pre>
            {field.truncated ? (
              <p className="mt-1 text-2xs text-faint" data-testid={`${testId}-truncated`}>
                {`原文共 ${formatCount(field.totalChars)} 字符，这里只显示前 ${formatCount(field.text?.length ?? 0)} 字符（信封可能很大：一条评论上限 60 000 字）。完整原文见任务详情的事件流。`}
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
