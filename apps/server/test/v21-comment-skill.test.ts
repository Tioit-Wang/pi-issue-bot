import { describe, expect, it } from 'vitest';
import { explicitSkillOfComment, withSkillFirstLine } from '../src/http/webhook-v21.ts';

describe('评论里点名的技能（issue_comment.created）', () => {
  it('命中 `/技能名`：任意位置、`/` 前必须是行首或空白', () => {
    expect(explicitSkillOfComment('@pi-bot /bug-analysis')).toBe('bug-analysis');
    expect(explicitSkillOfComment('先看格式 /issue-format 再继续')).toBe('issue-format');
    expect(explicitSkillOfComment('/req-analysis')).toBe('req-analysis');
    expect(explicitSkillOfComment('看看 /bug-analysis.')).toBe('bug-analysis');
    expect(explicitSkillOfComment('看看 /bug-analysis，谢谢')).toBe('bug-analysis');
  });

  it('不命中：粘在句柄上、后缀带路径、代码块/行内代码里的引用', () => {
    expect(explicitSkillOfComment('@pi-bot/bug-analysis')).toBeNull();
    expect(explicitSkillOfComment('路径是 apps/server/src/cli.ts')).toBeNull();
    expect(explicitSkillOfComment('```\n@pi-bot /label-triage\n```')).toBeNull();
    expect(explicitSkillOfComment('写法是 `/label-triage`')).toBeNull();
    expect(explicitSkillOfComment('')).toBeNull();
    expect(explicitSkillOfComment(undefined)).toBeNull();
  });

  it('替换首行：默认模板首行的 `/issue-analysis` 会被换成点名的技能', () => {
    const text = '/issue-analysis\n\n#32 https://example/32\n\n正文';
    expect(withSkillFirstLine(text, 'bug-analysis').split('\n')[0]).toBe('/bug-analysis');
    expect(withSkillFirstLine(text, 'bug-analysis').split('\n')[1]).toBe('');
  });

  it('首行不是技能词时另起一行前置，不吞掉原文', () => {
    const text = '新 issue 已创建：先按项目规范检查格式\n\n#7 ...';
    const out = withSkillFirstLine(text, 'req-analysis');
    expect(out.split('\n')[0]).toBe('/req-analysis');
    expect(out).toContain('新 issue 已创建');
  });
});
