/**
 * 项目默认技能播种：让「每个项目至少三个内置技能」在**数据库里真的有行**。
 *
 * 为什么不能只靠代码里的 `BUILTIN_SKILL_FILES`：
 *  - 代码里的内置技能是只读的，面板上没法编辑，也没法按项目覆盖；
 *  - 需求要求「每个项目的技能各不相同，按项目加载 / 创建 / 上传」——所以第一次打开某个项目的
 *    技能页时，把三个默认技能按**该项目**（`repo=owner/name`）落一份可编辑副本；
 *  - 已存在同名同仓库的行就跳过（幂等），用户改过的内容不会被覆盖回去。
 */
import { createHash } from 'node:crypto';
import type { SkillBundle } from './bundle.ts';
import { DEFAULT_PROJECT_SKILL_NAMES, builtinSkillText } from './builtin.ts';
import { parseSkillFile } from './frontmatter.ts';
import { treeHashOf } from './store.ts';
import type { SkillStore } from './store.ts';

/** 播种者标识（写进 `skills.created_by` 与审计的 actor）。 */
export const DEFAULT_SKILLS_ACTOR = 'system:defaults';

/** 把内置技能的 SKILL.md 文本包成一个「技能包」（与 zip 上传走同一条入库路径）。 */
export function bundleOfBuiltinSkill(name: string): SkillBundle | null {
  const text = builtinSkillText(name);
  if (text === null) {
    return null;
  }
  const parsed = parseSkillFile(text);
  if (!parsed.ok || parsed.name === null) {
    return null;
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const files = [{ path: 'SKILL.md', bytes: Buffer.byteLength(text, 'utf8'), sha256, text }];
  return {
    // 标准写法的 `name` 不带前导 `/`，本仓的存储名带 —— 这里补上（否则 `store.upload` 判非法）
    name: parsed.name.startsWith('/') ? parsed.name : `/${parsed.name}`,
    description: parsed.frontmatter.description,
    frontmatter: parsed.frontmatter as unknown as Record<string, unknown>,
    body: parsed.body,
    files,
    treeSha256: treeHashOf(files),
    validation: { ok: true, errors: [], warnings: [] },
    rootDir: '',
  };
}
/**
 * 确保这个项目有那三个默认技能，返回**本次新建**的名字（已有则不计）。
 *
 * 幂等：只补缺失的行；失败不抛（技能缺失不该让「打开技能页」整体失败）。
 *
 * 两个必须踩住的坑：
 * 1. **来源写 `builtin`**。写成 `upload` 的话，面板的 `?source=builtin` 查询永远返回空，
 *    三个默认技能会被当成「用户上传的副本」，只读保护与「内置副本」提示全部失效。
 * 2. **软删/停用也算「已存在」**。存在性只看 `deleted_at is null` 的话，用户删掉一个默认技能 →
 *    下次打开技能页它又带着默认正文回来了（用户改过的内容永远查不到）；停用同理会被绕过。
 */
export async function seedProjectDefaults(store: SkillStore, repo: string): Promise<readonly string[]> {
  // `includeDeleted` 让「删过/停用过的默认技能」留在 present 里，不再复活。
  const existing = await store.list({ repo, includeDeleted: true });
  const present = new Map(existing.map((item) => [item.name, item]));
  const created: string[] = [];
  for (const name of DEFAULT_PROJECT_SKILL_NAMES) {
    const found = present.get(name);
    if (found !== undefined) {
      // 已经存在：只纠正来源标记（历史行是 `upload`，会让面板把它当用户副本）。
      // 内容一律不碰 —— 用户可能已经改过它。
      if (found.source !== 'builtin') {
        await store.markBuiltin({ id: found.id }).catch(() => undefined);
      }
      continue;
    }
    const bundle = bundleOfBuiltinSkill(name);
    if (bundle === null) {
      continue;
    }
    try {
      await store.upload({
        bundle,
        repo,
        enabled: true,
        actor: DEFAULT_SKILLS_ACTOR,
        source: 'builtin',
      });
      created.push(name);
    } catch {
      // 并发请求可能同时插入（唯一索引冲突）：视为已存在，不打断列表
    }
  }
  return created;
}
