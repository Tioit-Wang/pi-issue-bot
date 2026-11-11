# 技能编辑：模态框 + 文件树 + zip 覆盖/导入

状态：已实施（后端 3 条新接口 + 面板改造），本文件是可追溯的决策记录。
上游约定见 `docs/spec/skill-management.md`、`docs/spec/contract-skill.md`。

## 1. 需求补充（把口头需求补成可验收的条目）

原始四条要求：①编辑用模态框；②技能可能在多个文件夹里，要显示目录、能改 markdown；③上传 zip 覆盖现有技能，覆盖必须发生在弹窗里；④上传 zip 自动解析并新增技能。

补齐后的口径：

| # | 需求 | 明确后的含义 | 明确排除 |
|---|---|---|---|
| R1 | 模态框编辑 | 点列表行/「编辑」在当前页弹出模态框；Esc、遮罩、关闭按钮都能退出；有未保存修改时先确认；焦点进入模态框 | 不做整页跳转的编辑路由 |
| R2 | 文件目录 + 改 markdown | 一个技能 = 一个目录；目录可有多级；树里列全部**文本**文件（`SKILL.md`、`references/x.md`、`scripts/y.py`…）；点任一文件在右侧 `<textarea>` 里**纯文本**编辑；保存只提交该文件 | 不渲染 markdown 预览；不让编辑二进制；不做文件中新建/删除/重命名（本版只改内容） |
| R3 | zip 覆盖 | **在模态框内**选 zip → 覆盖**当前这一个技能**，生成新版本；zip 内技能名与当前不一致时服务端拒绝并显示原文 | 不在模态框内做多技能导入 |
| R4 | zip 新增 | 页面级「导入技能 zip」：一个 zip 可含**多个**技能目录（`a/SKILL.md`、`b/SKILL.md`），逐个导入；部分成功要能看到成功几个、跳过几个及原因 | 不要求 zip 结构合法（缺 SKILL.md 的目录只报错不导入） |

非目标（本版不做）：技能文件的在线新建/删除/重命名、版本对比 diff、二进制附件预览、zip 导出。

## 2. 分析

### 2.1 现有能力（复用什么）

- `skills/bundle.ts`：`extractSkillBundle(zip)` 已能把「一个 zip = 一个技能包」解成 `SkillBundle{name, frontmatter, body, files[], treeSha256, validation}`，含 zip slip/限额/校验和防护（`skills/zip.ts`）。
- `SkillStore`：`upload()` 天然是「同名同作用域 = 新版本，否则新建」，自带校验、审计、`skill_versions`、回滚。**这是唯一的写库路径**，不该再开第二条。
- `PUT /api/skills/:id`：已能整份覆盖 `SKILL.md`。
- 面板：`repo-skills.tsx` 列表 + 内联编辑器、`useSkillUpload`、`useSkillSaveText` 已在。

### 2.2 缺口与判断

1. **只能整份改 `SKILL.md`，改不了附件**。要满足 R2，得能「按文件读、按文件写」。写的最小实现不是新增一套落库逻辑，而是：读当前版本全部文件文本 → 替换目标文件 → 用文件列表重建 `SkillBundle` → `store.upload`。重建器 `bundleFromFiles` 因此成为唯一新增原语。
2. **一个 zip 只能一个技能**。`extractSkillBundle` 的 `locateSkillRoot` 遇到多个 `SKILL.md` 会报错。R4 需要按「`SKILL.md` 所在目录」分组，每组独立构包。分组后同样走 `bundleFromFiles`，不复制解析逻辑。
3. **覆盖语义已有**：`POST /api/skills/:id/versions` 强制同名校验，正是 R3 要的；缺的只是弹窗里的入口。
4. **改名陷阱**：编辑器里改 frontmatter 的 `name`，若直接 `upload`，结果是「多出一个技能」而用户以为在编辑。因此 `PUT /api/skills/:id/files` 在 `bundle.name !== detail.name` 时直接 400。
5. **文件树在端上算**：`GET /api/skills/:id/files` 一次返回全部文本（技能包 ≤200 文件、单个 ≤5 MB），避免逐文件请求与路径编码问题；树是纯展示，不需要服务端概念。

### 2.3 与「技能归属项目」的关系

技能的作用域仍是 `scope='repo'` + `repo=owner/name`，本改动不引入 `project` 新表；面板路由仍在 `/repos/:repo/skills`。`POST /api/skills/import` 的 `scope/repo` 走既有 `skillUploadQuerySchema`，与单技能上传完全一致。

## 3. 实施计划与落地

### 3.1 后端（已实现）

| 文件 | 内容 |
|---|---|
| `apps/server/src/skills/files.ts`（新） | `normalizeSkillFilePath`、`isEditableSkillPath`、`bundleFromFiles`、`replaceFileIn`、`splitZipBundles` |
| `apps/server/src/skills/store.ts` | `SkillStore.fileTexts({ id })`：当前版本全部文件文本 |
| `packages/contract/src/skills.ts` | `skillFileTextSchema`、`skillFilesResponseSchema`、`skillFileWriteSchema`、`skillImportResponseSchema` |
| `apps/server/src/http/api/skills.ts` | `GET /api/skills/:id/files`、`PUT /api/skills/:id/files`、`POST /api/skills/import` |

路由语义：

- `GET /api/skills/:id/files` → `{ generatedAt, skillId, files: [{ path, text }] }`，技能不存在 404。
- `PUT /api/skills/:id/files`（body `{ path, text }`）→ 200 裸 `SkillDetail`，产生新版本；路径非法/非文本扩展名/frontmatter 非法/改 `name` → 400（message 为可直接展示的中文）。
- `POST /api/skills/import?repo&enabled`（body 原始 zip，`Content-Type: application/zip`）→ `{ imported: [{id,name,version,created}], errors, warnings }`；部分成功仍 200。`repo` 必填（**全局技能已移除**，`scope` 参数一并删除）。

### 3.2 面板（已实现）

- `lib/skill-files.ts`：`buildSkillFileTree`（`/` 分段 → 目录优先排序）、`isEditableSkillPath`、`formatBytes`。
- `components/skills/skill-editor-modal.tsx`：左文件树、右纯文本编辑器；「保存」(Ctrl/Cmd+S)、「上传 zip 覆盖本技能」、错误原文展示、未保存确认。
- `routes/repo-skills.tsx`：列表点行开模态框；页面级「导入技能 zip」并展示 `imported`/`errors`/`warnings`。
- `lib/api.ts` / `lib/queries.ts`：`skillFiles`、`saveSkillFile`、`overwriteSkillByZip`、`importSkills` 及 hooks，写后统一失效 `['skills']`。

### 3.3 测试

- `apps/server/test/skills-files-import.test.ts`：纯函数（路径校验、`bundleFromFiles`、`splitZipBundles`）+ HTTP（读文件、按文件保存保留其他文件、非法路径/改名的 400、多技能 zip 导入）。
- `apps/panel/src/__tests__/skill-files.test.ts`：树构建。
- `apps/panel/src/__tests__/skill-editor-modal.test.tsx`：模态框行为（打开、切换文件、保存、400 原文、zip 覆盖、导入、Esc）。
- `apps/panel/src/__tests__/repo-skills.test.tsx`：列表页回归（保持原 7 例通过）。

## 4. 验收清单

1. 列表页点技能 → 模态框出现，文件树显示 `SKILL.md`（有附件时显示多级目录）。
2. 改 `references/api.md` 保存 → 版本 +1，`SKILL.md` 未变（服务端测试断言）。
3. 模态框内选 zip 覆盖 → 同名技能版本 +1；名字不符 → 弹窗内显示服务端原文。
4. 页面级导入含 2 个技能目录的 zip → 列表出现 2 个技能，`errors` 为空。
5. `pnpm -w typecheck` 0 错；server / panel / contract 测试全绿；lint 无新增 error。

## 5. 风险与已知取舍

- **`bundleFromFiles` 与 `extractSkillBundle` 的校验口径**：前者用 `parseSkillFile`，后者用内部 `readSkillEntry`，两者对 frontmatter 的判断一致性靠同一份契约 schema 保证；若将来契约放宽，两处都要看。
- **`treeSha256` 计算**：`bundleFromFiles` 按「路径 + 内容 sha256」拼接再哈希，与 `store.treeHashOf` 的算法不同名但同用途；落库时以 `store` 算的为准，`bundle` 里的值只作构建期一致性用。
- **`splitZipBundles` 丢弃技能根外的散文件**（如 zip 根 README），只在 `warnings` 里提一句。
- **二进制文件不进文件树**：`readVersionTree` 只返回文本；上传时二进制已在 bundle 层被排除并记 warning。
