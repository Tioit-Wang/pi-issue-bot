import { StatusDot } from '../ui/badge.tsx';
import { cn } from '../../lib/utils.ts';

/**
 * 分类结论的**证据两栏**（`docs/plan-fixed-pipeline.md` §6）：
 *
 *  左栏「代码引用」= `rule = code:<path>:<line>` 的证据（缺陷必须有它，否则降级 not-found）；
 *  右栏「已查范围」= `rule = checked:<范围>` 的「我查了哪些地方」—— 没有它，
 *  一句「查不到」在面板上是无法复核的话（§6 原文）。
 *
 * 数据来源：`GET /api/tasks/:id` 的 `envelopes[].verdict.evidence`（契约 `verdictEvidenceSchema`），
 * 不新增接口。引用一律等宽；`passed` 只用一个 6px 圆点表达，不做整行染色。
 */
export type EvidenceItem = {
  rule: string;
  quote: string;
  passed: boolean | null;
};

export type CodeRef = { raw: string; path: string; line: string | null; quote: string; passed: boolean | null };
export type CheckedRange = { raw: string; scope: string; quote: string; passed: boolean | null };

export type SplitEvidence = {
  code: CodeRef[];
  checked: CheckedRange[];
  /** 既不是 `code:` 也不是 `checked:` 的规则（原样列在「其他规则」里，不吞掉）。 */
  other: EvidenceItem[];
};

const CODE_PREFIX = 'code:';
const CHECKED_PREFIX = 'checked:';

/**
 * 按 `rule` 前缀切成两栏。
 *
 * `code:` 后面可能是 `path:line`、只有 `path`（整文件）或 `path:120-140`（区间）：
 * 一律以**最后一个冒号**切「位置」，避免 Windows 盘符 / URL 里的冒号被误切。
 */
export function splitEvidence(evidence: readonly EvidenceItem[]): SplitEvidence {
  const code: CodeRef[] = [];
  const checked: CheckedRange[] = [];
  const other: EvidenceItem[] = [];

  for (const item of evidence) {
    if (item.rule.startsWith(CODE_PREFIX)) {
      const body = item.rule.slice(CODE_PREFIX.length);
      const split = body.lastIndexOf(':');
      const hasPosition = split > 0 && /^[\d,-]+$/u.test(body.slice(split + 1));
      code.push({
        raw: item.rule,
        path: hasPosition ? body.slice(0, split) : body,
        line: hasPosition ? body.slice(split + 1) : null,
        quote: item.quote,
        passed: item.passed,
      });
      continue;
    }
    if (item.rule.startsWith(CHECKED_PREFIX)) {
      checked.push({ raw: item.rule, scope: item.rule.slice(CHECKED_PREFIX.length), quote: item.quote, passed: item.passed });
      continue;
    }
    other.push(item);
  }

  return { code, checked, other };
}

export function ClassifyEvidence({ evidence }: { evidence: readonly EvidenceItem[] }) {
  const split = splitEvidence(evidence);
  const empty = evidence.length === 0;

  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2" data-testid="classify-evidence">
      <section className="flex min-w-0 flex-col gap-1" data-testid="evidence-code">
        <p className="micro-label">{`代码引用 ${String(split.code.length)}`}</p>
        {split.code.length === 0 ? (
          <p className="text-xs text-subtle" title="verdict.evidence 里没有 rule=code:* 的证据">
            —
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {split.code.map((ref) => (
              <li key={`${ref.raw}-${ref.quote}`} className="flex min-w-0 items-baseline gap-1.5 text-xs">
                <StatusDot
                  tone={ref.passed === false ? 'danger' : ref.passed === true ? 'success' : 'neutral'}
                  label={ref.passed === false ? '未通过' : ref.passed === true ? '通过' : '仅引用'}
                />
                <span className="min-w-0 truncate font-mono text-foreground" title={ref.raw}>
                  {ref.path}
                  {ref.line === null ? null : <span className="text-muted-foreground">{`:${ref.line}`}</span>}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-faint" title={ref.quote}>
                  {ref.quote}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-1" data-testid="evidence-checked">
        <p className="micro-label">{`已查范围 ${String(split.checked.length)}`}</p>
        {split.checked.length === 0 ? (
          <p className="text-xs text-subtle" title="verdict.evidence 里没有 rule=checked:* 的「已查范围」">
            —
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-1">
            {split.checked.map((entry) => (
              <li key={`${entry.raw}-${entry.quote}`} className="flex min-w-0 items-baseline gap-1.5 text-xs">
                <span className={cn('min-w-0 truncate font-mono', entry.passed === false ? 'text-danger-fg' : 'text-foreground')} title={entry.quote}>
                  {entry.scope}
                </span>
                <span className="min-w-0 flex-1 truncate text-2xs text-faint" title={entry.quote}>
                  {entry.quote}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {split.other.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-1 sm:col-span-2" data-testid="evidence-other">
          {split.other.map((item) => (
            <li key={`${item.rule}-${item.quote}`} className="flex min-w-0 items-baseline gap-1.5 text-xs">
              <span className="shrink-0 font-mono text-muted-foreground" title={item.rule}>
                {item.rule}
              </span>
              <span className="min-w-0 flex-1 truncate text-2xs text-faint" title={item.quote}>
                {item.quote}
              </span>
            </li>
          ))}
        </ul>
      )}

      {empty ? (
        <p className="text-2xs text-faint sm:col-span-2" data-testid="evidence-empty">
          这一版信封没有 verdict.evidence
        </p>
      ) : null}
    </div>
  );
}
