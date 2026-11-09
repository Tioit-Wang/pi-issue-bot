// @ts-check
/**
 * ESLint flat config —— 本仓库的「架构门禁」。
 *
 * 核心不是代码风格，而是把 docs/tech-plan.md §8.2 的依赖方向硬约束变成**可执行检查**：
 *   http/api → queries → db
 *   http/webhook → github, queue
 *   worker → runtime, sandbox, git, envelope, github, degeneracy
 *   runtime → racp-client
 *   任何模块 → shared / contract（叶子，不反向依赖）
 *   queries 不得 import worker
 *
 * 规则用 import-x/no-restricted-paths：target = 「谁被限制」，from = 「它不许依赖谁」。
 * 解析器用 eslint-import-resolver-typescript，保证 `./x.js` ↔ `./x.ts` 这类写法也能被认定，
 * 否则违反规则的 import 解析不到就会被规则静默跳过（那就等于没有门禁）。
 */
import js from '@eslint/js';
import globals from 'globals';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const SERVER = 'apps/server/src';
const PANEL = 'apps/panel/src';

/** @param {string} moduleName */
const serverModule = (moduleName) => `${SERVER}/${moduleName}`;

/** @param {readonly string[]} moduleNames */
const serverModules = (moduleNames) => moduleNames.map(serverModule);

/** @param {string} packageName */
const packageSrc = (packageName) => `packages/${packageName}/src`;

/**
 * @typedef {{ target: string | string[], from: string | string[], message: string }} Zone
 * @type {readonly Zone[]}
 */
const dependencyZones = [
  // ── §8.2 的四条主方向 ────────────────────────────────────────────────
  // queries 只读：只能依赖 db/ 与 shared/contract，绝不能顺手调用业务函数
  {
    target: serverModule('queries'),
    from: serverModules([
      'http',
      'worker',
      'runtime',
      'sandbox',
      'git',
      'github',
      'queue',
      'envelope',
      'degeneracy',
    ]),
    message:
      'queries/ 是面板只读通道：只允许依赖 db/ 与 shared/contract，不得 import 业务模块（tech-plan §8.2）',
  },
  // http/api → queries → db
  {
    target: serverModule('http/api'),
    from: serverModules([
      'worker',
      'runtime',
      'sandbox',
      'git',
      'github',
      'queue',
      'envelope',
      'degeneracy',
    ]),
    message: 'http/api 只能经由 queries/ 取数，不得直接碰 worker 或执行面（tech-plan §8.2）',
  },
  // http/webhook → github, queue
  {
    target: serverModule('http/webhook.ts'),
    from: serverModules(['worker', 'runtime', 'sandbox', 'git', 'queries', 'envelope', 'degeneracy']),
    message:
      'http/webhook 只做「验签 → 去重 → 入队」，只允许依赖 github/ 与 queue/（tech-plan §5.3/§8.2）',
  },
  // worker → runtime, sandbox, git, envelope, github, degeneracy（不得反向依赖 http）
  {
    target: serverModule('worker'),
    from: [serverModule('http')],
    message: 'worker 不得反向依赖 http/（tech-plan §8.2）',
  },
  // runtime → racp-client
  {
    target: serverModule('runtime'),
    from: serverModules(['worker', 'http', 'queries', 'sandbox', 'git', 'github', 'queue']),
    message: 'runtime 只装配 racp-client + 审批策略，不得依赖其它执行面模块（tech-plan §8.2）',
  },

  // ── apps 与 packages 之间 ───────────────────────────────────────────
  {
    target: SERVER,
    from: [PANEL],
    message: 'server 不得 import 面板源码，两者只通过 HTTP/OpenAPI 契约通信（tech-plan §8.3）',
  },
  {
    target: PANEL,
    from: [SERVER],
    message: '面板不得 import 后端实现，只能用 packages/contract 里的生成类型（tech-plan §8.3）',
  },

  // ── packages 是叶子：不得依赖 apps/* ────────────────────────────────
  ...['shared', 'contract', 'envelope', 'racp-client'].map((name) => ({
    target: packageSrc(name),
    from: ['apps'],
    message: `packages/${name} 是叶子包，不得依赖 apps/*（tech-plan §8.2）`,
  })),

  // ── shared / contract 是叶子中的叶子，彼此也不互相依赖 ───────────────
  {
    target: packageSrc('shared'),
    from: [packageSrc('contract'), packageSrc('envelope'), packageSrc('racp-client')],
    message:
      'shared 是最底层叶子（不含 zod / ws 依赖）：需要两边共用的类型请下沉到本包，不要让它反向依赖',
  },
  {
    target: packageSrc('contract'),
    from: [packageSrc('shared'), packageSrc('envelope'), packageSrc('racp-client')],
    message: 'contract 是叶子包（只依赖 zod），不得依赖其它 workspace 包',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vitest/**',
      '**/*.d.ts',
      'pnpm-lock.yaml',
      // 资源/部署目录由各自 owner session 维护，不是 TS 代码
      'images/**',
      'deploy/**',
      'migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 本仓库的 JS/TS 全部跑在 Node 上：内置全局（process/console/timers…）不该报 no-undef
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  // scripts/ 是运维与 spike 脚本区，各 owner session 自行维护：
  // 正确性规则（no-undef 等）保持 error，纯风格规则降级为 warning，不阻塞在途实验代码。
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    rules: {
      'no-empty': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
    },
  },

  // 架构门禁：只作用于 TS 源码
  {
    files: ['**/*.{ts,mts,cts}'],
    plugins: { 'import-x': importX },
    settings: {
      'import-x/resolver': {
        typescript: {
          project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
          alwaysTryTypes: true,
          // 每个包一个 tsconfig 是刻意的（隔离编译范围），这条只关掉解析器告警
          noWarnOnMultipleProjects: true,
        },
      },
    },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: dependencyZones,
        },
      ],
      // 顺带挡一下 barrel 与深路径混用导致的重复引入
      'import-x/no-duplicates': 'error',
      // 类型导入必须显式 type（配合 verbatimModuleSyntax）
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // 测试与配置允许更宽松
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
