/**
 * `runtime/approval-policy.ts` 的单测：tech-plan §4.6 的策略表逐条验证。
 *
 * 重点是「越界就 deny」这条：`../` 逃逸、绝对路径越界、前缀相同的兄弟目录（`/jobs/1` vs `/jobs/10`）
 * 都必须被拦；同时每次判定都要产出一条审计条目（面板要展示）。
 */
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROVAL_RULES,
  INPUT_UNAVAILABLE_ANSWER,
  answerInputRequest,
  decideApproval,
  extractTargetPath,
  isPathInsideWorktree,
  racpDecisionFor,
} from '../src/runtime/approval-policy.ts';

const ROOT = resolve('/jobs/1/work');
const NOW = (): Date => new Date('2026-06-01T00:00:00.000Z');

function decide(tool: string, input: Record<string, unknown> = {}) {
  return decideApproval({ tool, input, worktreeRoot: ROOT, now: NOW });
}

describe('只读与容器内工具：allow', () => {
  it('Read / Glob / Grep / Bash 一律 allow，并留下审计条目', () => {
    for (const tool of ['Read', 'Glob', 'Grep', 'Bash']) {
      const result = decide(tool, { path: join(ROOT, 'src/a.ts') });
      expect(result.decision).toBe('allow');
      expect(result.audit.decision).toBe('allow');
      expect(result.audit.tool).toBe(tool);
      expect(result.audit.at).toBe('2026-06-01T00:00:00.000Z');
      expect(result.audit.worktreeRoot).toBe(ROOT);
      expect(result.audit.rule).toBe(
        tool === 'Bash' ? APPROVAL_RULES.sandboxed : APPROVAL_RULES.readOnly,
      );
    }
  });

  it('工具名大小写/空白不敏感（拼写差异不该变成误拒）', () => {
    expect(decide('  read ').decision).toBe('allow');
    expect(decide('BASH').decision).toBe('allow');
  });

  it('Bash 的理由写明「进容器」，与 D5 的自洽性可审', () => {
    expect(decide('Bash', { command: 'pnpm test' }).reason).toContain('容器');
  });
});

describe('Write / Edit：仅 worktree 内 allow', () => {
  it('相对路径落在 worktree 内 → allow，审计里有归一化的目标路径', () => {
    const result = decide('Write', { path: 'src/new-file.ts' });
    expect(result.decision).toBe('allow');
    expect(result.audit.rule).toBe(APPROVAL_RULES.writeInsideWorktree);
    expect(result.audit.targetPath).toBe(join(ROOT, 'src/new-file.ts'));
  });

  it('绝对路径落在 worktree 内 → allow（host-core 在宿主执行，路径是同一条）', () => {
    const result = decide('Edit', { file_path: join(ROOT, 'docs/readme.md') });
    expect(result.decision).toBe('allow');
  });

  it("'../' 逃逸 → deny", () => {
    const result = decide('Write', { path: '../outside.txt' });
    expect(result.decision).toBe('deny');
    expect(result.audit.rule).toBe(APPROVAL_RULES.writeOutsideWorktree);
  });

  it('多级 ../ 逃逸与绝对路径越界都 deny', () => {
    expect(decide('Edit', { path: '../../../../etc/passwd' }).decision).toBe('deny');
    expect(decide('Write', { path: resolve('/etc/passwd') }).decision).toBe('deny');
    expect(decide('Write', { path: 'C:\\Windows\\system32\\drivers\\etc\\hosts' }).decision).toBe('deny');
  });

  it('前缀相同的兄弟目录不算 inside（/jobs/1 vs /jobs/10）', () => {
    const sibling = resolve('/jobs/10/work/file.ts');
    expect(decide('Write', { path: sibling }).decision).toBe('deny');
    expect(isPathInsideWorktree(sibling, ROOT)).toBe(false);
    expect(isPathInsideWorktree(join(ROOT, 'a/b/c.ts'), ROOT)).toBe(true);
    expect(isPathInsideWorktree(ROOT, ROOT)).toBe(true);
  });

  it('写类工具没给目标路径 → deny（无法证明在 worktree 内）', () => {
    for (const tool of ['Write', 'Edit']) {
      const result = decide(tool, { content: 'x' });
      expect(result.decision).toBe('deny');
      expect(result.audit.rule).toBe(APPROVAL_RULES.writeNoTarget);
    }
  });

  it('空字符串路径当作「没给」', () => {
    expect(extractTargetPath({ path: '   ' })).toBeUndefined();
    expect(decide('Write', { path: '' }).decision).toBe('deny');
  });
});

describe('其它工具：deny（最小权限）', () => {
  it('网络抓取 / exec 桥 / MCP 一律 deny，理由可读', () => {
    for (const tool of ['WebFetch', 'McpTool', 'terminal', '']) {
      const result = decide(tool);
      expect(result.decision).toBe('deny');
      expect(result.audit.rule).toBe(APPROVAL_RULES.unknownTool);
      expect(result.reason).toContain('不开放');
    }
  });
});

describe('v2.1 工具面：移除项 / issue 工具集 / shell 约束', () => {
  it('被移除的工具一律 deny，且 rule 说得清是「主动移除」', () => {
    for (const tool of ['new_context', 'Task', 'TodoWrite', 'mcp__github__create_issue', 'plugin_pi_todo_todo_manage']) {
      const result = decide(tool);
      expect(result.decision, tool).toBe('deny');
      expect(result.audit.rule, tool).toBe(APPROVAL_RULES.removedTool);
      expect(result.reason, tool).toContain('已在本版移除');
    }
  });

  it('issue 读工具 allow，写工具也 allow（真正的闸在 writeback，不在这里）', () => {
    for (const tool of ['IssueGet', 'IssueList', 'IssueSearch', 'IssueTimeline', 'IssueCommentsList']) {
      const result = decide(tool, { number: 1 });
      expect(result.decision, tool).toBe('allow');
      expect(result.audit.rule, tool).toBe(APPROVAL_RULES.issueToolRead);
    }
    for (const tool of ['IssueCommentCreate', 'IssueLabelSet', 'IssueClose', 'IssueCreate']) {
      const result = decide(tool, { number: 1 });
      expect(result.decision, tool).toBe('allow');
      expect(result.audit.rule, tool).toBe(APPROVAL_RULES.issueToolWrite);
      // 理由要点明「还要过项目开关与写回闸门」，否则读审计的人会以为 allow 就是放行到底
      expect(result.reason, tool).toContain('写回闸门');
    }
  });

  it('Bash 里做 issue 操作 → deny，理由点名该用 Issue* 工具', () => {
    for (const command of ['gh issue view 1', 'gh issue comment 1 --body hi', 'gh api repos/a/b/issues', 'gh pr create --fill']) {
      const result = decide('Bash', { command });
      expect(result.decision, command).toBe('deny');
      expect(result.audit.rule, command).toBe(APPROVAL_RULES.shellIssueOperation);
      expect(result.reason, command).toContain('Issue*');
    }
  });

  it('直接打 GitHub API 也 deny（换掉 gh 不是绕过办法）', () => {
    const result = decide('Bash', {
      command: "curl -X POST https://api.github.com/repos/a/b/issues/1/comments -d '{}'",
    });
    expect(result.decision).toBe('deny');
    expect(result.audit.rule).toBe(APPROVAL_RULES.shellIssueOperation);
  });

  it('跑测试 / 看 diff 仍然 allow（约束只管 issue 操作）', () => {
    for (const command of ['pnpm test', 'pnpm -r typecheck', 'git diff HEAD~1', 'gh auth status']) {
      const result = decide('Bash', { command });
      expect(result.decision, command).toBe('allow');
      expect(result.audit.rule, command).toBe(APPROVAL_RULES.sandboxed);
    }
  });
});

describe('input/request：固定应答', () => {
  it('每个问题回「无法提供，按现有信息继续」，并留审计', () => {
    const result = answerInputRequest({
      questions: [{ id: 'q1', question: '用哪个分支名？' }, { id: 'q2', question: '要跑完整测试吗？' }],
      worktreeRoot: ROOT,
      now: NOW,
    });

    expect(result.answers).toEqual([
      [INPUT_UNAVAILABLE_ANSWER],
      [INPUT_UNAVAILABLE_ANSWER],
    ]);
    expect(result.audit.kind).toBe('input');
    expect(result.audit.decision).toBe('answer');
    expect(result.audit.rule).toBe(APPROVAL_RULES.inputUnavailable);
    expect(result.audit.answer).toBe(INPUT_UNAVAILABLE_ANSWER);
    expect(result.audit.tool).toBe('input/request');
  });

  it('没有问题 → 空应答数组（但仍给审计）', () => {
    const result = answerInputRequest({ questions: [], worktreeRoot: ROOT, now: NOW });
    expect(result.answers).toEqual([]);
    expect(result.audit.decision).toBe('answer');
  });
});

describe('审计条目与 RACP 决策映射', () => {
  it('每次判定都产生审计：字段齐全、入参已脱敏', () => {
    const result = decide('Bash', {
      command: 'curl -H "Authorization: Bearer ppt1.verysecretpairingtoken" example.com',
    });

    expect(result.audit.inputDigest).toContain('<redacted>');
    expect(result.audit.inputDigest).not.toContain('ppt1.verysecretpairingtoken');
    expect(Object.keys(result.audit).sort()).toEqual(
      ['at', 'decision', 'inputDigest', 'kind', 'reason', 'rule', 'tool', 'worktreeRoot'].sort(),
    );
  });

  it('audit.tool 在工具名为空时给占位符（面板不会出现空列）', () => {
    expect(decide('').audit.tool).toBe('<empty>');
  });

  it('决策 → RACP：allow 用 allow-once（不是 allow-session），deny 用 deny', () => {
    expect(racpDecisionFor('allow')).toBe('allow-once');
    expect(racpDecisionFor('deny')).toBe('deny');
  });
});
