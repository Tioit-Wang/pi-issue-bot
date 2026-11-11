/**
 * 原型构建：把 _src/pages/*.html 片段包进统一外壳，内联 CSS/JS，
 * 输出为可直接双击打开的单文件 HTML（无外部依赖、无构建环境要求）。
 *
 * 用法：node design-demo/_src/build.mjs
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..');

const REPO = 'acme/web-console';
const REPOS = ['acme/web-console', 'acme/payments-api', 'acme/infra-terraform'];

const NAV = [
  {
    group: '跨仓库',
    items: [
      { id: 'home', label: '工作台', href: 'index.html', icon: 'pulse' },
      { id: 'costs', label: '成本', href: 'costs.html', icon: 'coin' },
      { id: 'quality', label: '质量', href: 'quality.html', icon: 'shield' },
      { id: 'audit', label: '审计', href: 'audit.html', icon: 'list' },
      { id: 'skills', label: '技能', href: 'skills.html', icon: 'spark' },
      { id: 'system', label: '系统', href: 'system.html', icon: 'cpu' },
    ],
  },
  {
    group: '当前仓库',
    items: [
      { id: 'issues', label: 'Issue 中心', href: 'issues.html', icon: 'issue', count: '10' },
      { id: 'pipeline', label: '流水线', href: 'pipeline.html', icon: 'flow' },
      { id: 'settings', label: '设置', href: 'settings.html', icon: 'sliders' },
    ],
  },
];

const ICONS = {
  pulse:
    '<path d="M1.5 8h2.4l1.6-4.2L8 12l1.7-5.4L11 8h3.5" stroke-linecap="round" stroke-linejoin="round"/>',
  coin:
    '<ellipse cx="8" cy="4.4" rx="5.2" ry="2.2"/><path d="M2.8 4.4v3.2c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4.4M2.8 7.6v3.2c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V7.6"/>',
  shield:
    '<path d="M8 1.8 3 3.6v4.1c0 2.6 2 4.6 5 5.5 3-.9 5-2.9 5-5.5V3.6L8 1.8Z"/><path d="m5.9 7.6 1.5 1.5 2.7-3" stroke-linecap="round" stroke-linejoin="round"/>',
  list:
    '<path d="M5.4 4.2h8.2M5.4 8h8.2M5.4 11.8h8.2M2.4 4.2h.01M2.4 8h.01M2.4 11.8h.01" stroke-linecap="round"/>',
  spark:
    '<path d="m8 1.8 1.6 4 4 1.6-4 1.6L8 13l-1.6-4-4-1.6 4-1.6L8 1.8Z" stroke-linejoin="round"/>',
  cpu:
    '<rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6.6 1.6v2.2M9.4 1.6v2.2M6.6 12.2v2.2M9.4 12.2v2.2M1.6 6.6h2.2M1.6 9.4h2.2M12.2 6.6h2.2M12.2 9.4h2.2" stroke-linecap="round"/>',
  issue:
    '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.8M8 11.1h.01" stroke-linecap="round"/>',
  play:
    '<circle cx="8" cy="8" r="6"/><path d="M6.4 5.3 10.6 8l-4.2 2.7V5.3Z" stroke-linejoin="round"/>',
  sliders:
    '<path d="M3 4.6h10M3 8h10M3 11.4h10" stroke-linecap="round"/><circle cx="6" cy="4.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="11.4" r="1.5" fill="currentColor" stroke="none"/>',
  flow:
    '<circle cx="3.4" cy="8" r="1.5"/><circle cx="12.6" cy="4.2" r="1.5"/><circle cx="12.6" cy="11.8" r="1.5"/><path d="M4.9 8h2.2c1.6 0 2.1-3.8 4.2-3.8M4.9 8h2.2c1.6 0 2.1 3.8 4.2 3.8"/>',
};

const icon = (name, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">${
    ICONS[name] || ICONS.list
  }</svg>`;

function rail(activeNav) {
  const groups = NAV.map((group) => {
    const items = group.items
      .map((item) => {
        const current = item.id === activeNav ? ' aria-current="page"' : '';
        return `        <a class="nav-item" href="${item.href}"${current}>${icon(item.icon)}<span>${item.label}</span>${
          item.count ? `<span class="nav-count">${item.count}</span>` : ''
        }</a>`;
      })
      .join('\n');
    return `      <div class="nav-label">${group.group}</div>\n${items}`;
  }).join('\n');

  return `  <aside class="rail" id="rail" aria-label="侧栏">
    <div class="brand">
      <span class="brand-mark">π</span>
      <span class="brand-name">pi-issue-bot</span>
      <span class="brand-meta">v0.4</span>
    </div>
    <div class="rail-scroll">
      <div class="repo-ctx" style="position:relative">
        <button class="repo-ctx-btn" id="repo-trigger" type="button" aria-expanded="false" aria-haspopup="listbox">
          <span class="repo-avatar">W</span>
          <span class="repo-ctx-name" data-repo-name>${REPO}</span>
          <svg class="repo-ctx-caret" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="popover" id="repo-pop" role="listbox" aria-label="仓库列表"></div>
      </div>
${groups}
    </div>
    <div class="rail-foot">
      <div class="rail-health"><span class="dot tone-ok"></span><span>GitHub App 已连接</span></div>
      <div class="rail-foot-row"><span>轮询 15s</span><span class="sep">·</span><span>契约 v1.1</span><span class="sep">·</span><span>UTC+8</span></div>
    </div>
  </aside>`;
}

function topbar(crumbs) {
  const parts = crumbs.split('|');
  const rendered = parts
    .map((part, i) => {
      const last = i === parts.length - 1;
      if (part === '{repo}') {
        return `<span class="sep">/</span><span class="here" data-repo-name>${REPO}</span>`;
      }
      if (part.includes('>')) {
        const [label, href] = part.split('>');
        return `<span class="sep">/</span><a href="${href}">${label}</a>`;
      }
      if (last) {
        return `${i === 0 ? '' : '<span class="sep">/</span>'}<span class="current">${part}</span>`;
      }
      return `<span class="sep">/</span><a href="${i === 0 ? 'index.html' : '#'}">${part}</a>`;
    })
    .join('');

  return `    <header class="topbar">
      <button class="icon-btn menu-btn" id="menu-btn" type="button" aria-label="打开导航">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke-linecap="round"/></svg>
      </button>
      <nav class="crumbs" aria-label="面包屑">${rendered}</nav>
      <div class="topbar-spacer"></div>
      <div class="status-ribbon" aria-label="全局状态">
        <span class="pill line" title="本原型所有数字均为演示数据">演示数据</span>
        <span class="ribbon-item"><span class="dot tone-ok"></span>队列 <b>3</b></span>
        <span class="ribbon-item"><span class="dot tone-ok"></span>429 熔断 <b>无</b></span>
        <span class="ribbon-item"><span class="dot tone-ok"></span>doctor <b>通过</b></span>
      </div>
      <button class="search-trigger" type="button" data-open-palette>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7.2" cy="7.2" r="4.4"/><path d="m10.6 10.6 3 3" stroke-linecap="round"/></svg>
        <span>搜索</span>
        <span class="kbd">⌘K</span>
      </button>
      <button class="icon-btn" id="theme-btn" type="button" aria-label="切换主题"></button>
      <span class="avatar" title="acme 组织管理员">LW</span>
    </header>`;
}

const PALETTE = `  <div class="overlay" id="palette-overlay" role="dialog" aria-modal="true" aria-label="命令面板">
    <div class="palette">
      <div class="palette-input">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="var(--ink-3)" stroke-width="1.6"><circle cx="7.2" cy="7.2" r="4.4"/><path d="m10.6 10.6 3 3" stroke-linecap="round"/></svg>
        <input id="palette-input" type="text" placeholder="搜索页面、仓库…" aria-label="搜索页面或仓库" autocomplete="off" />
        <span class="kbd">ESC</span>
      </div>
      <div class="palette-list" id="palette-list"></div>
    </div>
  </div>`;

function headerComments(src) {
  const meta = {};
  const body = src.replace(/^<!--@(\w+)\s+(.+?)-->\s*$/gm, (_, key, value) => {
    meta[key] = value.trim();
    return '';
  });
  return { meta, body: body.trim() };
}

const css = await readFile(join(HERE, 'app.css'), 'utf8');
const js = await readFile(join(HERE, 'app.js'), 'utf8');

const files = (await readdir(join(HERE, 'pages'))).filter((f) => f.endsWith('.html'));
await mkdir(OUT, { recursive: true });

for (const file of files) {
  const src = await readFile(join(HERE, 'pages', file), 'utf8');
  const { meta, body } = headerComments(src);
  const title = meta.title || 'pi-issue-bot';
  const nav = meta.nav || meta.page;
  const crumb = meta.crumb || '全部项目';
  const page = meta.page || nav;

  const html = `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · pi-issue-bot 控制台</title>
<style>
${css}
</style>
</head>
<body data-page="${page}">
<div class="shell">
${rail(nav)}
  <div class="main">
${topbar(crumb)}
    <div class="content" id="main">
${body}
    </div>
  </div>
</div>
${PALETTE}
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script>
window.__PAGE__ = ${JSON.stringify(page)};
window.__REPO__ = ${JSON.stringify(REPO)};
window.__REPOS__ = ${JSON.stringify(REPOS)};
window.__NAV__ = ${JSON.stringify(NAV)};
</script>
<script>
${js}
</script>
</body>
</html>
`;

  await writeFile(join(OUT, file), html, 'utf8');
  console.log(`built ${file} (${(html.length / 1024).toFixed(1)} KB)`);
}
