# 开发环境与协作约定（dev-setup）

> 面向并行开工的多个 session。**先读第 4 节的目录所有权再动手**：本仓库的并行方式是「按目录切分」，不是「按文件抢改」。
> 相关章节：`docs/tech-plan.md` §2（选型）、§8（后端结构与依赖方向）、§5.4（禁止 merge）。

---

## 1. 环境与安装

| 依赖 | 版本要求 | 说明 |
|---|---|---|
| Node | ≥ 24 | 只用 Node 原生能力（type stripping、`node:test` 同级 API），不依赖打包器 |
| pnpm | ≥ 10 | workspace 唯一包管理器；不要用 npm/yarn 生成第二份 lockfile |
| git | ≥ 2.40 | `git worktree` 是任务隔离的基础（tech-plan §5.5） |
| Docker | 不要求 | 本机（Windows 开发机）没有 docker：`deploy/`、`images/` 里需要 docker 的脚本**只写不跑** |

```powershell
git clone <repo> pi-issue-bot
cd pi-issue-bot
pnpm install          # 安装全部 workspace 依赖，产出/更新 pnpm-lock.yaml
```

- `pnpm install` 必须留下**可复现的 `pnpm-lock.yaml`**：改依赖就要提交 lockfile，不能只改 `package.json`。
- 依赖只装在需要的包上：`pnpm --filter @pi-issue-bot/server add fastify`。
  跨包共用、只在开发期用的工具（tsc / eslint / vitest / tsx）装在**根**：`pnpm add -D -w <pkg>`。
- 安装时出现 `Ignored build scripts: esbuild` 是 pnpm 10 的默认安全行为，**不影响本仓库**（esbuild 的平台二进制走
  optionalDependencies，不依赖 postinstall）。不要为了消掉提示去 `pnpm approve-builds`。

---

## 2. 四条命令（提交前必须全绿）

```powershell
pnpm install            # 依赖
pnpm -r typecheck       # 每个包 tsc --noEmit
pnpm -r test            # 每个包 vitest run（没有测试文件也算通过，见下）
pnpm lint               # ESLint，含架构门禁
```

- `pnpm -r typecheck`：逐包 `tsc -p tsconfig.json --noEmit`。**全仓 `noEmit`，没有构建步骤**，源码就是运行物。
- `pnpm -r test`：逐包 `vitest run --passWithNoTests`。空测试允许，但**新功能必须带测试**。
  只跑全部测试：`pnpm test:all`（根 vitest 配置，一次跑完）。
- `pnpm lint`：见第 3 节。`pnpm lint:fix` 可自动修一部分。

### 命令行入口

`apps/server/src/cli.ts` 是唯一的 CLI 骨架（参数解析 + `--help`），子命令全部返回 `NOT_IMPLEMENTED`：

```powershell
pnpm cli -- --help                                            # 推荐：tsx（不挑语法，报错信息友好）
pnpm --filter @pi-issue-bot/server cli -- migrate             # 在本包内跑
node --experimental-strip-types apps/server/src/cli.ts --help # 不用 tsx 的等价写法
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功（`--help` / `--version`） |
| 1 | 用法错误（缺少命令、未知命令） |
| 2 | `NOT_IMPLEMENTED`：骨架阶段所有子命令 |

**为什么主用 tsx、同时保证 strip-types 能跑**：日常开发用 `tsx`，它接受完整 TS 语法；但「不用任何 loader 也能跑」是硬约束，
所以 `cli.ts` 只用**可被 Node 擦除类型**的语法（不用 enum / namespace / 参数属性）。新加的子命令若要引入这类语法，
必须同时把 `scripts` 里的入口改成 tsx（现在已经是），并在 PR 里说明。

---

## 3. 门禁：依赖方向与「不存在 merge」

### 3.1 TypeScript 基线（`tsconfig.base.json`）

- `strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`isolatedModules`、`noEmit`。
- `module` / `moduleResolution` = **`nodenext`**（不是 `bundler`）。理由：运行时就是 Node，没有打包器兜底；
  用 nodenext 才能在开发期暴露「本地能跑、线上解析不到」的引入问题。
  代价是相对引入**必须带扩展名**，约定写 `./x.ts`（`allowImportingTsExtensions` 已开）。
- 包通过 `exports` 指向源码：`"exports": { ".": "./src/index.ts" }`。跨包引入用包名
  （`@pi-issue-bot/shared`），不要用 `../../packages/shared/src` 这种穿墙路径。

### 3.2 ESLint 架构门禁（`eslint.config.js`）

`import-x/no-restricted-paths` 把 tech-plan §8.2 变成可执行规则，`target` = 被限制方，`from` = 不许依赖谁：

```js
// queries 只读：只能依赖 db/ 与 shared/contract
{ target: 'apps/server/src/queries',
  from: ['apps/server/src/http', 'apps/server/src/worker', /* runtime sandbox git github queue envelope degeneracy */],
  message: 'queries/ 是面板只读通道：只允许依赖 db/ 与 shared/contract…' }

// http/webhook → github, queue
{ target: 'apps/server/src/http/webhook.ts',
  from: ['apps/server/src/worker', 'apps/server/src/queries', /* … */] }

// worker 不得反向依赖 http；runtime 只装配 racp-client
{ target: 'apps/server/src/worker', from: ['apps/server/src/http'] }
{ target: 'apps/server/src/runtime', from: ['apps/server/src/worker', 'apps/server/src/http', /* … */] }

// packages 是叶子：不得依赖 apps/*；shared 与 contract 互不依赖
{ target: 'packages/shared/src', from: ['apps', 'packages/contract/src', 'packages/envelope/src', 'packages/racp-client/src'] }
```

配套：`eslint-import-resolver-typescript` 负责把 `./x.js` ↔ `./x.ts` 解析到同一文件——解析不到，规则就会静默放过，门禁等于没有。

自测门禁是否真的生效（改完配置必做）：

```powershell
# 临时造一个违规：queries 里 import worker
New-Item -ItemType Directory -Force apps\server\src\worker, apps\server\src\queries
'export const probe = 1;' | Set-Content apps\server\src\worker\tmp-probe.ts
'import { probe } from ''../worker/tmp-probe.ts''; export const v = probe;' | Set-Content apps\server\src\queries\tmp-probe.ts
pnpm lint     # 期望：1 error  import-x/no-restricted-paths
Remove-Item -Recurse -Force apps\server\src\worker, apps\server\src\queries
```

### 3.3 「代码层不存在 merge」

`apps/server/test/no-merge.test.ts` 扫描所有 `src/` 目录，断言不存在 `.merge(`、`pulls.merge`、
`mergePullRequest`、`merge_pull_request`。这是 plan §7.1 / tech-plan §5.4 的产品级约束（我们没有 merge 权限），
**不要为了实现某个便利功能去放宽它**；要放宽必须同时改 plan 并走安全评审。

---

## 4. 目录所有权（并行不踩脚的唯一依据）

一个 session = 一组目录。**拥有者之外的 session 只读**。

| 目录 / 文件 | 归属（角色） | 内容 |
|---|---|---|
| `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`eslint.config.js`、`vitest.config.ts`、`.gitignore`、`docs/spec/dev-setup.md` | **S3 骨架/门禁** | 工具链与门禁。其它 session 需要改这里（加规则、加根依赖）必须在 PR 里写明理由，由骨架 owner 合并 |
| `apps/server/src/cli.ts`、各包 `package.json`/`tsconfig.json`/`vitest.config.ts` 的骨架内容 | **S3 骨架/门禁** | CLI 由后续 owner **追加**子命令实现，不要重写骨架 |
| `apps/server/src/{http,queue,worker,db,config}/`、`apps/server/src/index.ts` | **后端控制面** | Fastify、pg-boss、drizzle schema、任务编排 |
| `apps/server/src/{runtime,sandbox,git,github,degeneracy}/`、`packages/racp-client/`、`images/`、`deploy/`、`scripts/` | **agent 执行面** | RACP 客户端、容器生命周期、git worktree、Octokit 写执行器、熔断 |
| `packages/contract/`、`packages/envelope/`、`docs/spec/contract-*.md` | **契约/信封** | zod 契约、OpenAPI 生成类型、信封 JSON Schema + Ajv |
| `apps/panel/` | **面板** | Vite + React SPA |
| `migrations/` | **数据库（后端控制面）** | 只有数据库 owner 写；其他人只读迁移历史 |
| `docs/plan.md`、`docs/tech-plan.md`、`README.md` | **规划 owner** | 方案文本，不由实现 session 改 |

规则：

1. **不要为了让自己的代码编过而修改别人的目录**。需要别人提供接口时，用 `TODO(owner: <角色>)` 标出并在 PR 里点人。
2. 改动跨目录时，PR 标题写清「跨目录」，并在描述里列出每个目录的 owner 已确认。
3. 共享代码下沉顺序：先在 `packages/shared`（无第三方依赖）加，再考虑 `packages/contract`（只依赖 zod）。
   两者是叶子包，不得反向依赖 `apps/*`（lint 强制）。
4. `packages/*` 之间不互相依赖，除非在 PR 里明确加了 `"@pi-issue-bot/xxx": "workspace:*"` 并说明方向；
   依赖方向仍受 §3.2 约束。
5. 新包要成 workspace 包，必须同时给 `package.json`（`private: true` + `type: module` + `exports`）、
   `tsconfig.json`（extends 根配置）、`vitest.config.ts`（mergeConfig 继承根）、能跑通的 `typecheck`/`test` 脚本。

---

## 5. 迁移文件命名与序号

drizzle-kit 产物放 `migrations/`，命名 `NNNN_snake_case_summary.sql`（`NNNN` 四位零填充）。

**序号按里程碑分块，避免并行撞号**（对应 tech-plan §12）：

| 里程碑 | 可用序号 |
|---|---|
| M0（骨架/打通） | `0000` – `0099` |
| M1（信封/评论/标签） | `0100` – `0199` |
| M2（命令/时间闸/熔断） | `0200` – `0299` |
| M3（成本/质量/审计） | `0300` – `0399` |
| M4（push/开 PR/关 issue） | `0400` – `0499` |

- 同一里程碑内，取「该块里还没被占用的最小号」。**不要为了整齐而重排别人已经合并的序号。**
- 已合并的迁移文件**只读**：改 schema 就加新文件，绝不改历史文件（否则已部署环境对不上）。
- 一个 PR 的迁移号必须连续；跨 PR 冲突时，**后来的让路**（改自己的号 + 同步 `migrations/meta/`）。
- `migrations/meta/` 由 drizzle-kit 生成，只有数据库 owner 能动；其他人不要手写 `_journal.json`。

---

## 6. 骨架现状（S3 交付了什么）

```
pi-issue-bot/
├─ apps/
│  ├─ server/     # @pi-issue-bot/server：src/index.ts（占位）、src/cli.ts（可跑）、test/（CLI + no-merge）
│  └─ panel/      # @pi-issue-bot/panel：src/index.ts（占位）
├─ packages/
│  ├─ contract/   # @pi-issue-bot/contract（叶子）
│  ├─ racp-client/# @pi-issue-bot/racp-client（叶子）
│  ├─ envelope/   # @pi-issue-bot/envelope（叶子）
│  └─ shared/     # @pi-issue-bot/shared（叶子）
├─ images/  deploy/  migrations/  scripts/   # 只有 .gitkeep，等 owner session 填
├─ package.json  pnpm-workspace.yaml  pnpm-lock.yaml
├─ tsconfig.base.json  eslint.config.js  vitest.config.ts
└─ docs/spec/dev-setup.md
```

每个包的 `src/index.ts` 只有 `export {}` + 一句 TODO：**骨架里没有业务代码，也没有提前锁版本**
（fastify / pg / dockerode / react / zod 等都留给 owner 自己 `pnpm add`，避免替别人决定版本）。
