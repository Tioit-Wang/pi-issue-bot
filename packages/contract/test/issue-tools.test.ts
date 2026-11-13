/**
 * `issue-tools.ts`：执行侧工具面（需求 §5.5「执行侧可用工具」）。
 *
 * 钉四件事，任一被改回去都会在这里红：
 *  1. 移除清单真的移除（含前缀族），且判定大小写不敏感；
 *  2. issue 工具集覆盖 issue 全生命周期（创建/读/评论/标签/状态/检索/关联都有专用工具）；
 *  3. 每个写类工具都能映射到既有动作信封（不许出现「平台不知道该执行什么」的工具）；
 *  4. shell 里做 issue 操作会被判出来，且不误伤正常的测试/构建命令。
 */
import { describe, expect, it } from 'vitest';

import {
  ACTION_INTENTS,
  EXECUTE_CHANNEL_AVAILABLE,
  HOST_FILE_TOOLS,
  HOST_SHELL_TOOL,
  ISSUE_TOOLS,
  ISSUE_TOOL_NAMES,
  ISSUE_TOOL_USAGE_NOTES,
  ISSUE_WRITE_TOOL_NAMES,
  REACTION_ACTION_INTENTS,
  REMOVED_TOOLS,
  REMOVED_TOOL_PREFIXES,
  SKILL_ALLOWED_TOOLS,
  findShellIssueViolation,
  isIssueTool,
  isRemovedTool,
  issueToolAvailability,
} from '../src/index.ts';

describe('移除的工具：任何白名单都不该再有它们', () => {
  it('精确移除的三件 + 两个前缀族', () => {
    expect([...REMOVED_TOOLS]).toEqual(['new_context', 'Task', 'TodoWrite']);
    expect([...REMOVED_TOOL_PREFIXES]).toEqual(['mcp__', 'plugin_']);
  });

  it('判定覆盖精确名与前缀族', () => {
    expect(isRemovedTool('new_context')).toBe(true);
    expect(isRemovedTool('Task')).toBe(true);
    expect(isRemovedTool('TodoWrite')).toBe(true);
    // 前缀族：名字由插件/MCP 动态产生，逐个列举永远列不全
    expect(isRemovedTool('mcp__github__create_issue')).toBe(true);
    expect(isRemovedTool('mcp__anything')).toBe(true);
    expect(isRemovedTool('plugin_pi_todo_todo_manage')).toBe(true);
    expect(isRemovedTool('plugin_whatever')).toBe(true);
  });

  it('大小写与空白不敏感（技能 frontmatter 是人写的）', () => {
    expect(isRemovedTool('  todowrite ')).toBe(true);
    expect(isRemovedTool('TASK')).toBe(true);
    expect(isRemovedTool('MCP__github')).toBe(true);
  });

  it('保留的工具不会误判成移除', () => {
    for (const tool of [...HOST_FILE_TOOLS, HOST_SHELL_TOOL, ...ISSUE_TOOL_NAMES]) {
      expect(isRemovedTool(tool), tool).toBe(false);
    }
    expect(isRemovedTool('')).toBe(false);
  });

  it('技能的 allowed-tools 枚举里一个移除项都没有', () => {
    for (const tool of SKILL_ALLOWED_TOOLS) {
      expect(isRemovedTool(tool), tool).toBe(false);
    }
  });
});

describe('issue 工具集：覆盖 issue 全生命周期', () => {
  it('每个生命周期环节都有专用工具', () => {
    const names = ISSUE_TOOL_NAMES as readonly string[];
    // 读
    expect(names).toContain('IssueGet');
    expect(names).toContain('IssueCommentsList');
    expect(names).toContain('IssueTimeline');
    expect(names).toContain('IssueList');
    // 检索
    expect(names).toContain('IssueSearch');
    // 创建 / 改
    expect(names).toContain('IssueCreate');
    expect(names).toContain('IssueUpdate');
    // 状态
    expect(names).toContain('IssueClose');
    expect(names).toContain('IssueReopen');
    // 评论
    expect(names).toContain('IssueCommentCreate');
    expect(names).toContain('IssueCommentUpdate');
    expect(names).toContain('IssueCommentDelete');
    // 标签（增 / 删 / 目标态）
    expect(names).toContain('IssueLabelAdd');
    expect(names).toContain('IssueLabelRemove');
    expect(names).toContain('IssueLabelSet');
    // 表情（issue 主贴 / 某条评论）
    expect(names).toContain('IssueReactionAdd');
    expect(names).toContain('IssueReactionRemove');
    // 关联
    expect(names).toContain('IssueLink');
  });

  it('名字唯一，且都能被 isIssueTool 认出来（大小写不敏感）', () => {
    expect(new Set(ISSUE_TOOL_NAMES).size).toBe(ISSUE_TOOL_NAMES.length);
    for (const name of ISSUE_TOOL_NAMES) {
      expect(isIssueTool(name), name).toBe(true);
      expect(isIssueTool(name.toLowerCase()), name).toBe(true);
    }
    expect(isIssueTool('IssueNope')).toBe(false);
    expect(isIssueTool('Read')).toBe(false);
  });

  it('每条都有说明与必填入参声明（提示词直接拿它渲染调用形状）', () => {
    for (const tool of ISSUE_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(0);
      expect(Array.isArray(tool.required), tool.name).toBe(true);
      // 除 IssueList 这种「列全部」的，读写单个 issue 的工具都要给定位参数
      if (tool.name !== 'IssueList') {
        expect(tool.required.length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it('写类工具正好是那 14 个（读类 5 个不改状态）', () => {
    expect(ISSUE_WRITE_TOOL_NAMES.length).toBe(14);
    expect(ISSUE_WRITE_TOOL_NAMES).toContain('IssueCommentCreate');
    expect(ISSUE_WRITE_TOOL_NAMES).toContain('IssueCommentReply');
    expect(ISSUE_WRITE_TOOL_NAMES).toContain('IssueReactionAdd');
    expect(ISSUE_WRITE_TOOL_NAMES).toContain('IssueLabelSet');
    expect(ISSUE_WRITE_TOOL_NAMES).not.toContain('IssueGet');
    expect(ISSUE_WRITE_TOOL_NAMES).not.toContain('IssueSearch');
  });

  it('每个写类工具都落在既有动作信封里（平台知道该执行什么）', () => {
    /*
      这条是「新增工具不破坏架构」的机器化保证：
      issue 工具不自己发 HTTP，而是产出信封里的动作——v0.3 是 ACTION_INTENTS
      （comment / label / create_issue / push_branch），v2.1 另外允许 reaction.add /
      reaction.remove（`outputActionSchema` 的 `reaction` 一类），close_issue 由平台内部触发。
      所以这里的 intent 词表取「可声明的 + reaction」两者之和，逐个断言归属。
    */
    const intents = new Set<string>([...ACTION_INTENTS, ...REACTION_ACTION_INTENTS]);
    const mapping: Readonly<Record<string, string>> = {
      IssueCreate: 'create_issue',
      IssueUpdate: 'comment', // 改正文/标题走平台写回，记一条说明性动作
      IssueClose: 'comment',
      IssueReopen: 'comment',
      IssueCommentCreate: 'comment',
      IssueCommentReply: 'comment', // 引用块 + 定向 @ 由平台渲染，仍是 comment 动作
      IssueCommentUpdate: 'comment',
      IssueCommentDelete: 'comment',
      IssueReactionAdd: 'reaction.add',
      IssueReactionRemove: 'reaction.remove',
      IssueLabelAdd: 'label',
      IssueLabelRemove: 'label',
      IssueLabelSet: 'label',
      IssueLink: 'comment', // duplicate / parent 走 issue 的 PATCH 与 sub_issues；relates 落评论
    };
    expect(Object.keys(mapping).sort()).toEqual([...ISSUE_WRITE_TOOL_NAMES].sort());
    for (const [tool, intent] of Object.entries(mapping)) {
      expect(intents.has(intent), `${tool} → ${intent}`).toBe(true);
    }
  });

  it('使用规范覆盖四件最容易用错的事（表情 / 回复 / 提及 / 关系）', () => {
    /*
      工具清单只回答「有哪些工具」；没有这一段，模型会把"回复某条评论"写成
      IssueCommentCreate 手抄引用块，或者把"重复"用一句话描述掉而不调 IssueLink。
    */
    expect(ISSUE_TOOL_USAGE_NOTES.length).toBeGreaterThanOrEqual(5);
    for (const note of ISSUE_TOOL_USAGE_NOTES) {
      expect(note.trim().length, note).toBeGreaterThan(10);
    }
    const joined = ISSUE_TOOL_USAGE_NOTES.join('\n');
    expect(joined).toContain('eyes');
    expect(joined).toContain('IssueCommentReply');
    expect(joined).toContain('IssueCommentsList');
    expect(joined).toContain('IssueLink');
    expect(joined).toContain('expected_updated_at');
  });
});

describe('issue 操作不得走 shell', () => {
  it('gh 的 issue / pr / api / search 一律命中', () => {
    const cases = [
      'gh issue view 123',
      'gh issue comment 123 --body "看过了"',
      'gh issue list --label bug',
      'gh pr create --fill',
      'gh api repos/acme/widgets/issues/1',
      'gh api graphql -f query=...',
      'gh search issues "崩溃"',
    ];
    for (const command of cases) {
      expect(findShellIssueViolation(command), command).toBeDefined();
    }
  });

  it('直接打 GitHub REST / GraphQL 也命中（换掉 gh 不是绕过办法）', () => {
    expect(findShellIssueViolation("curl -X POST https://api.github.com/repos/a/b/issues/1/comments -d '{...}'")).toBeDefined();
    expect(findShellIssueViolation('wget -q https://api.github.com/repos/a/b/issues')).toBeDefined();
    expect(findShellIssueViolation('curl https://api.github.com/graphql -d ...')).toBeDefined();
  });

  it('返回命中的那段，便于写进拒绝理由', () => {
    expect(findShellIssueViolation('gh issue view 1')).toBe('gh issue');
    expect(findShellIssueViolation('GH  ISSUE  view 1')).toBe('GH  ISSUE');
  });

  it('正常的开发命令不误伤', () => {
    const allowed = [
      'pnpm test',
      'pnpm -r typecheck',
      'git diff HEAD~1',
      'git log --oneline -5',
      'node scripts/build.mjs',
      'ls -la',
      'npm run lint',
      // `gh` 本身不是禁词：本地状态查询与 auth 不碰 issue
      'gh auth status',
      'gh --version',
      '',
    ];
    for (const command of allowed) {
      expect(findShellIssueViolation(command), command).toBeUndefined();
    }
  });
});

describe('执行通道的真实状态', () => {
  it('当前通道不可用：提示词据此只说「平台代执行」，不得宣称工具可调用', () => {
    /*
      这条不是「功能测试」，是**诚实性测试**：注入自定义工具需要 RACP 的 tool relay，
      而它在 client 白名单里被明确排除（docs/tech-plan.md §4.4）。通道真通了，
      这里会红——那时该做的是把常量改成 true 并更新提示词措辞，而不是删掉这条断言。
    */
    expect(EXECUTE_CHANNEL_AVAILABLE).toBe(false);
    expect(issueToolAvailability()).toBe('platform-executed');
  });
});
