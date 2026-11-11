/**
 * 技能命中（H-01..H-09 的纯函数层，`docs/req-issue-agent.md` §1.3 / §2.3）。
 *
 * 口径：任意位置 + `/` 前必须是行首或空白 + id 精确匹配（区分大小写）+ 代码区不命中；
 * 命中删 token，未命中正文逐字保留。
 */
import { describe, expect, it } from 'vitest';
import { findSkillMentions } from '../src/skill-mentions.ts';
import { findSkillMentions as fromIndex } from '../src/index.ts';

const IDS = ['label-triage', 'format-check'];

describe('findSkillMentions', () => {
  it('H-01 行首命中：token 删除，正文剩空', () => {
    const scan = findSkillMentions('/label-triage', IDS);
    expect(scan.skillIds).toEqual(['label-triage']);
    expect(scan.text).toBe('');
  });

  it('H-02 空格后命中：只剩 @句柄', () => {
    const scan = findSkillMentions('@bot /label-triage', IDS);
    expect(scan.skillIds).toEqual(['label-triage']);
    expect(scan.text).toBe('@bot');
  });

  it('H-03 句中命中：位置任意，剩余原样', () => {
    const scan = findSkillMentions('@bot 看看格式 /format-check', IDS);
    expect(scan.skillIds).toEqual(['format-check']);
    expect(scan.text).toBe('@bot 看看格式');
  });

  it('H-04 粘连不命中：`@bot/label-triage` 是句柄的一部分', () => {
    const scan = findSkillMentions('@bot/label-triage', IDS);
    expect(scan.skillIds).toEqual([]);
    expect(scan.text).toBe('@bot/label-triage');
  });

  it('H-05 未知 id 不命中、不报错、token 保留', () => {
    const scan = findSkillMentions('@bot /label-tri', IDS);
    expect(scan.skillIds).toEqual([]);
    expect(scan.text).toBe('@bot /label-tri');
  });

  it('H-06 多次命中：顺序保留', () => {
    const scan = findSkillMentions('/label-triage 然后 /format-check', IDS);
    expect(scan.skillIds).toEqual(['label-triage', 'format-check']);
    expect(scan.text).toBe('然后');
  });

  it('H-07 重复命中：去重成一个', () => {
    const scan = findSkillMentions('/label-triage /label-triage', IDS);
    expect(scan.skillIds).toEqual(['label-triage']);
    expect(scan.text).toBe('');
  });

  it('H-08 大小写敏感：`/Label-Triage` 不命中', () => {
    expect(findSkillMentions('/Label-Triage', IDS).skillIds).toEqual([]);
  });

  it('H-09 代码区不命中（围栏块与行内代码）', () => {
    expect(findSkillMentions('用法：\n```\n/format-check\n```\n', IDS).skillIds).toEqual([]);
    expect(findSkillMentions('写成 `/format-check` 就行', IDS).skillIds).toEqual([]);
  });

  it('token 尾部标点不影响命中（`/format-check.`）', () => {
    const scan = findSkillMentions('跑一下 /format-check. 谢谢', IDS);
    expect(scan.skillIds).toEqual(['format-check']);
    expect(scan.text).toBe('跑一下 . 谢谢');
  });

  it('目录为空 → 什么都不命中（正文逐字返回）', () => {
    const body = '@bot /label-triage';
    expect(findSkillMentions(body, [])).toEqual({ skillIds: [], text: body, hits: [] });
  });

  it('未命中时正文与入参逐字相等（零副作用）', () => {
    const body = '  多行\n文本  ';
    expect(findSkillMentions(body, IDS).text).toBe(body);
  });

  it('从包入口也能拿到（`index.ts` 已挂出）', () => {
    expect(fromIndex('/format-check', IDS).skillIds).toEqual(['format-check']);
  });
});
