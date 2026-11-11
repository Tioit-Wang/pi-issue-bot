/* ==========================================================================
   pi-issue-bot 控制台 · 交互原型脚本（无依赖，file:// 直接可跑）
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ── 基础工具 ─────────────────────────────────────────────────────────── */
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }
  function svg(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(n) { return new Intl.NumberFormat('en-US').format(n); }

  function toast(message, tone) {
    var host = $('#toasts');
    if (!host) return;
    var t = el('div', { class: 'toast' });
    var dot = el('span', { class: 'dot tone-' + (tone || 'ok') });
    t.appendChild(dot);
    t.appendChild(el('span', null, message));
    host.appendChild(t);
    while (host.children.length > 3) host.removeChild(host.firstChild);
    setTimeout(function () {
      t.style.transition = 'opacity 160ms ease, transform 160ms ease';
      t.style.opacity = '0';
      t.style.transform = 'translateY(4px)';
      setTimeout(function () { t.remove(); }, 180);
    }, 2600);
  }

  function copyText(text, label) {
    var done = function () { toast(label || '已复制', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast('浏览器拒绝了剪贴板访问', 'warn'); });
    } else {
      done();
    }
  }

  /* ── 主题 ─────────────────────────────────────────────────────────────── */
  var THEME_KEY = 'pib-demo-theme';
  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    var btn = $('#theme-btn');
    if (btn) {
      btn.setAttribute('aria-label', mode === 'dark' ? '切换到浅色' : '切换到深色');
      btn.innerHTML = mode === 'dark'
        ? '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3.1"/><path d="M8 1.2v1.4M8 13.4v1.4M1.2 8h1.4M13.4 8h1.4M3.2 3.2l1 1M11.8 11.8l1 1M12.8 3.2l-1 1M4.2 11.8l-1 1" stroke-linecap="round"/></svg>'
        : '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" stroke-linejoin="round"/></svg>';
    }
  }
  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* file:// 下可能不可用 */ }
    var forced = (location.search.match(/theme=(dark|light)/) || [])[1];
    var mode = forced || stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(mode);
    var btn = $('#theme-btn');
    if (btn) btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      redrawCharts();
    });
  }

  /* ── 仓库切换 ─────────────────────────────────────────────────────────── */
  var REPO_KEY = 'pib-demo-repo';
  function currentRepo() {
    try { return localStorage.getItem(REPO_KEY) || window.__REPO__; } catch (e) { return window.__REPO__; }
  }
  function initRepoSwitcher() {
    var trigger = $('#repo-trigger');
    var pop = $('#repo-pop');
    if (!trigger || !pop) return;
    var repos = window.__REPOS__ || [];
    var active = currentRepo();

    function paint() {
      $$('[data-repo-name]').forEach(function (n) { n.textContent = active; });
      $$('[data-repo-short]').forEach(function (n) { n.textContent = active.split('/')[1]; });
      $$('.popover-item', pop).forEach(function (item) {
        item.setAttribute('aria-selected', item.dataset.repo === active ? 'true' : 'false');
      });
      document.dispatchEvent(new CustomEvent('repo:change', { detail: { repo: active } }));
    }

    pop.innerHTML = '<div class="popover-label">切换仓库上下文</div>';
    repos.forEach(function (repo) {
      var b = el('button', { class: 'popover-item', type: 'button', 'data-repo': repo });
      b.innerHTML = '<span class="repo-avatar">' + repo.split('/')[1].slice(0, 1).toUpperCase() + '</span>' +
        '<span class="mono">' + repo + '</span>' +
        '<svg class="check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3.5 8.4 3 3 6-6.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.addEventListener('click', function () {
        active = repo;
        try { localStorage.setItem(REPO_KEY, active); } catch (e) { /* ignore */ }
        paint();
        togglePop(false);
        toast('已切换仓库上下文：' + active, 'info');
      });
      pop.appendChild(b);
    });

    function togglePop(open) {
      var willOpen = open == null ? !pop.classList.contains('open') : open;
      pop.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }
    trigger.addEventListener('click', function (e) { e.stopPropagation(); togglePop(); });
    document.addEventListener('click', function (e) {
      if (!pop.contains(e.target) && !trigger.contains(e.target)) togglePop(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') togglePop(false); });
    paint();
  }

  /* ── 命令面板 ─────────────────────────────────────────────────────────── */
  function initPalette() {
    var overlay = $('#palette-overlay');
    var input = $('#palette-input');
    var list = $('#palette-list');
    if (!overlay || !input) return;
    var nav = window.__NAV__ || [];
    var repos = window.__REPOS__ || [];
    var flat = [];
    nav.forEach(function (group) {
      group.items.forEach(function (item) {
        flat.push({ group: group.group, label: item.label, href: item.href, icon: item.icon, kind: 'page' });
      });
    });
    var repoItems = repos.map(function (r) { return { group: '仓库', label: r, repo: r, kind: 'repo' }; });
    var cursor = 0;

    function render(q) {
      var query = (q || '').toLowerCase().trim();
      var items = flat.concat(repoItems).filter(function (i) {
        return query === '' || i.label.toLowerCase().indexOf(query) >= 0 || (i.group && i.group.toLowerCase().indexOf(query) >= 0);
      });
      list.innerHTML = '';
      if (!items.length) {
        list.appendChild(el('div', { class: 'palette-empty' }, '没有匹配的页面或仓库'));
        return;
      }
      cursor = 0;
      var lastGroup = null;
      items.forEach(function (item, idx) {
        if (item.group !== lastGroup) {
          list.appendChild(el('div', { class: 'palette-group' }, item.group));
          lastGroup = item.group;
        }
        var b = el('button', { class: 'palette-item' + (idx === 0 ? ' on' : ''), type: 'button' });
        b.innerHTML = (item.kind === 'page' ? iconSvg(item.icon) : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.4 4.6h11.2M2.4 8h11.2M2.4 11.4h7" stroke-linecap="round"/></svg>') +
          '<span>' + item.label + '</span>' +
          '<span class="hint">' + (item.kind === 'page' ? '页面' : '切换') + '</span>';
        b.addEventListener('click', function () { choose(item); });
        list.appendChild(b);
        item.__node = b;
      });
      list.__items = items;
    }

    function choose(item) {
      if (item.kind === 'page') { location.href = item.href; return; }
      try { localStorage.setItem(REPO_KEY, item.repo); } catch (e) { /* ignore */ }
      close();
      location.reload();
    }

    function paintCursor() {
      var items = list.__items || [];
      items.forEach(function (i, idx) { if (i.__node) i.__node.classList.toggle('on', idx === cursor); });
      var node = items[cursor] && items[cursor].__node;
      if (node) node.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      overlay.classList.add('open');
      input.value = '';
      render('');
      setTimeout(function () { input.focus(); }, 20);
    }
    function close() { overlay.classList.remove('open'); }

    input.addEventListener('input', function () { render(input.value); });
    input.addEventListener('keydown', function (e) {
      var items = list.__items || [];
      if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(items.length - 1, cursor + 1); paintCursor(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); paintCursor(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[cursor]) choose(items[cursor]); }
      else if (e.key === 'Escape') { close(); }
    });
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
      else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); open(); }
    });
    $$('[data-open-palette]').forEach(function (b) { b.addEventListener('click', open); });
    window.__openPalette = open;
  }

  function iconSvg(name) {
    var paths = {
      pulse: '<path d="M1.5 8h2.4l1.6-4.2L8 12l1.7-5.4L11 8h3.5" stroke-linecap="round" stroke-linejoin="round"/>',
      coin: '<ellipse cx="8" cy="4.4" rx="5.2" ry="2.2"/><path d="M2.8 4.4v3.2c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V4.4M2.8 7.6v3.2c0 1.2 2.3 2.2 5.2 2.2s5.2-1 5.2-2.2V7.6"/>',
      shield: '<path d="M8 1.8 3 3.6v4.1c0 2.6 2 4.6 5 5.5 3-.9 5-2.9 5-5.5V3.6L8 1.8Z"/><path d="m5.9 7.6 1.5 1.5 2.7-3" stroke-linecap="round" stroke-linejoin="round"/>',
      list: '<path d="M5.4 4.2h8.2M5.4 8h8.2M5.4 11.8h8.2M2.4 4.2h.01M2.4 8h.01M2.4 11.8h.01" stroke-linecap="round"/>',
      spark: '<path d="m8 1.8 1.6 4 4 1.6-4 1.6L8 13l-1.6-4-4-1.6 4-1.6L8 1.8Z" stroke-linejoin="round"/>',
      cpu: '<rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6.6 1.6v2.2M9.4 1.6v2.2M6.6 12.2v2.2M9.4 12.2v2.2M1.6 6.6h2.2M1.6 9.4h2.2M12.2 6.6h2.2M12.2 9.4h2.2" stroke-linecap="round"/>',
      issue: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8v3.8M8 11.1h.01" stroke-linecap="round"/>',
      play: '<circle cx="8" cy="8" r="6"/><path d="M6.4 5.3 10.6 8l-4.2 2.7V5.3Z" stroke-linejoin="round"/>',
      sliders: '<path d="M3 4.6h10M3 8h10M3 11.4h10" stroke-linecap="round"/><circle cx="6" cy="4.6" r="1.5" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="5" cy="11.4" r="1.5" fill="currentColor" stroke="none"/>',
      search: '<circle cx="7.2" cy="7.2" r="4.4"/><path d="m10.6 10.6 3 3" stroke-linecap="round"/>'
    };
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' + (paths[name] || paths.list) + '</svg>';
  }

  /* ── 图表 ─────────────────────────────────────────────────────────────── */
  var charts = [];

  function renderTrend(host, data) {
    if (!host) return;
    var w = Math.max(420, host.clientWidth || 760), h = 176, pad = { l: 30, r: 12, t: 12, b: 20 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var rawMax = 4;
    data.forEach(function (d) { rawMax = Math.max(rawMax, d.ok + d.fail); });
    var max = Math.ceil(rawMax / 4) * 4;
    var bw = iw / data.length;
    var barW = Math.min(18, bw * 0.58);

    var s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h });
    s.style.height = h + 'px';

    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      var y = pad.t + ih * (1 - p);
      s.appendChild(svg('line', {
        x1: pad.l, x2: w - pad.r, y1: y, y2: y,
        stroke: 'var(--line)', 'stroke-width': 1, 'stroke-dasharray': p === 0 ? '0' : '2 4',
        'vector-effect': 'non-scaling-stroke'
      }));
      var t = svg('text', { x: pad.l - 7, y: y + 3, 'text-anchor': 'end', 'font-size': 8.5, fill: 'var(--ink-4)', 'font-family': 'var(--mono)' });
      t.textContent = String(Math.round(max * p));
      s.appendChild(t);
    });

    data.forEach(function (d, i) {
      var x = pad.l + bw * i + (bw - barW) / 2;
      var hOk = (d.ok / max) * ih;
      var hFail = (d.fail / max) * ih;
      var yOk = pad.t + ih - hOk;
      s.appendChild(svg('rect', { x: x, y: yOk, width: barW, height: Math.max(0, hOk), rx: 1.5, fill: 'var(--accent)', opacity: 0.88 }));
      if (hFail > 0) {
        s.appendChild(svg('rect', { x: x, y: yOk - hFail, width: barW, height: hFail, rx: 1.5, fill: 'var(--bad)', opacity: 0.85 }));
      }
      if (i % 3 === 0) {
        var lbl = svg('text', { x: pad.l + bw * i + bw / 2, y: h - 6, 'text-anchor': 'middle', 'font-size': 8.5, fill: 'var(--ink-4)', 'font-family': 'var(--mono)' });
        lbl.textContent = d.label;
        s.appendChild(lbl);
      }
    });

    host.innerHTML = '';
    host.appendChild(s);
    charts.push(function () { renderTrend(host, data); });
  }

  function renderSpark(host, values, tone) {
    if (!host) return;
    var w = 96, h = 22, n = values.length;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = max - min || 1;
    var pts = values.map(function (v, i) {
      return [ (i / (n - 1)) * w, h - 2 - ((v - min) / span) * (h - 5) ];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + w + ' ' + h + ' L0 ' + h + ' Z';
    var color = tone === 'bad' ? 'var(--bad)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
    host.innerHTML = '';
    var s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none' });
    s.appendChild(svg('path', { d: area, fill: color, opacity: 0.1 }));
    s.appendChild(svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    host.appendChild(s);
  }

  function renderArea(host, labels, values, opts) {
    if (!host) return;
    opts = opts || {};
    var w = Math.max(420, host.clientWidth || 760), h = opts.height || 180, pad = { l: 40, r: 10, t: 12, b: 22 };
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    var max = Math.max.apply(null, values) * 1.12;
    var min = opts.zero ? 0 : Math.min.apply(null, values) * 0.75;
    var s = svg('svg', { viewBox: '0 0 ' + w + ' ' + h });
    s.style.height = h + 'px';

    [0, 0.25, 0.5, 0.75, 1].forEach(function (p) {
      var y = pad.t + ih * (1 - p);
      s.appendChild(svg('line', { x1: pad.l, x2: w - pad.r, y1: y, y2: y, stroke: 'var(--line)', 'stroke-width': 1, 'stroke-dasharray': p === 0 ? '0' : '2 4', 'vector-effect': 'non-scaling-stroke' }));
      var t = svg('text', { x: pad.l - 7, y: y + 3.5, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-4)', 'font-family': 'var(--mono)' });
      t.textContent = (opts.prefix || '') + (min + (max - min) * p).toFixed(opts.decimals == null ? 0 : opts.decimals);
      s.appendChild(t);
    });

    var pts = values.map(function (v, i) {
      return [ pad.l + (i / (values.length - 1)) * iw, pad.t + ih * (1 - (v - min) / (max - min)) ];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + (pad.l + iw) + ' ' + (pad.t + ih) + ' L' + pad.l + ' ' + (pad.t + ih) + ' Z';
    var grad = svg('linearGradient', { id: 'area-fill', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svg('stop', { offset: '0', 'stop-color': 'var(--accent)', 'stop-opacity': 0.16 }));
    grad.appendChild(svg('stop', { offset: '1', 'stop-color': 'var(--accent)', 'stop-opacity': 0 }));
    var defs = svg('defs'); defs.appendChild(grad); s.appendChild(defs);
    s.appendChild(svg('path', { d: area, fill: 'url(#area-fill)' }));
    s.appendChild(svg('path', { d: line, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));

    labels.forEach(function (lb, i) {
      if (labels.length > 12 && i % Math.ceil(labels.length / 6) !== 0) return;
      var t = svg('text', { x: pts[i][0], y: h - 6, 'text-anchor': 'middle', 'font-size': 8.5, fill: 'var(--ink-4)', 'font-family': 'var(--mono)' });
      t.textContent = lb;
      s.appendChild(t);
    });

    host.innerHTML = '';
    host.appendChild(s);
    charts.push(function () { renderArea(host, labels, values, opts); });
  }

  function renderHBars(host, items, tone) {
    if (!host) return;
    var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    host.innerHTML = items.map(function (i) {
      var pct = Math.round((i.value / max) * 100);
      return '<div class="hbar"><span class="hbar-label" title="' + i.label + '">' + i.label + '</span>' +
        '<span class="hbar-track"><i class="hbar-fill" style="display:block;width:' + pct + '%;background:' + (i.color || (tone === 'bad' ? 'var(--bad)' : 'var(--accent)')) + ';opacity:.85"></i></span>' +
        '<span class="hbar-val">' + i.display + '</span></div>';
    }).join('');
  }

  function redrawCharts() {
    var list = charts.slice();
    charts = [];
    list.forEach(function (fn) { fn(); });
  }

  /* ── 页面：工作台 ─────────────────────────────────────────────────────── */
  function homeData() {
    var hours = [], ok = 0, fail = 0;
    // 24 小时阶段任务数（阶段 0 / 1 / 2 合计），合计 46，失败 4
    var shape = [1, 0, 0, 0, 1, 1, 2, 3, 4, 4, 3, 3, 2, 3, 4, 2, 2, 2, 2, 1, 1, 2, 2, 1];
    var failAt = { 6: 1, 9: 1, 15: 1, 21: 1 };
    for (var i = 0; i < 24; i++) {
      var hh = (new Date().getHours() - 23 + i + 24) % 24;
      var total = shape[i];
      var f = failAt[i] && total > 0 ? 1 : 0;
      hours.push({ label: ('0' + hh).slice(-2), ok: total - f, fail: f });
      ok += total - f; fail += f;
    }
    return { hours: hours, ok: ok, fail: fail };
  }

  function initHome() {
    var data = homeData();
    renderTrend($('#trend-chart'), data.hours);

    renderSpark($('#spark-tasks'), [2, 1, 1, 0, 1, 2, 3, 4, 4, 3, 2, 3, 4, 3, 3, 2, 3, 4, 3, 2].map(function (v) { return v + 1; }));
    renderSpark($('#spark-rate'), [78, 80, 79, 81, 83, 84, 82, 81, 83, 84, 83, 82, 84, 85, 83, 82, 84, 83, 82, 82.4], 'ok');
    renderSpark($('#spark-p95'), [1, 1, 0, 0, 1, 2, 2, 3, 3, 4, 3, 4, 4, 3, 4, 4, 4, 4, 4, 4], 'warn');
    renderSpark($('#spark-cost'), [0.9, 1.2, 1.0, 1.4, 1.8, 2.2, 3.1, 4.4, 3.9, 3.2, 3.6, 4.2, 4.6, 4.1, 3.8, 4.4, 4.9, 5.2, 4.8, 4.82]);

    var refresh = $('#home-refresh');
    if (refresh) refresh.addEventListener('click', function () {
      refresh.setAttribute('disabled', '');
      refresh.textContent = '刷新中';
      setTimeout(function () {
        refresh.removeAttribute('disabled');
        refresh.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.6v3.2H10" stroke-linecap="round" stroke-linejoin="round"/></svg> 刷新';
        var meta = $('#home-updated');
        if (meta) meta.textContent = '刚刚更新';
        toast('已拉取最新数据（演示）', 'ok');
      }, 620);
    });

    var todo = $('.rows');
    if (todo) {
      $$('.rrow', todo).forEach(function (row) {
        row.addEventListener('click', function (e) {
          if (e.target.closest('button, a')) return;
          if (row.dataset.href) { location.href = row.dataset.href; return; }
          toast('进入 ' + (row.dataset.target || '详情') + '（演示）', 'info');
        });
      });
    }
  }

  /* ── 页面：Issue 中心 ─────────────────────────────────────────────────── */
  // stage: 0 格式检查 / 1 标签分类 / 2 Agent / 3 已结束
  // state: pending / running / awaiting_info / blocked / ready / closed
  var ISSUES = [
    {
      n: 318, title: '登录页在 Safari 17 下无法聚焦验证码输入框', repo: 'acme/web-console',
      stage: 2, state: 'awaiting_info', cat: 'defect', runs: [1, 1, 3], wait: 26,
      turns: 7, cursor: 12, age: 3, stale: false, actor: 'linwei', cost: 0.021,
      labels: ['bug', 'needs-info'],
      f: { body: '模板 4 项齐全：复现步骤、期望结果、实际结果、环境版本。没有需要补充的字段，直接进入分类。', turns: 2, dur: '11s' },
      c: { body: '判定为<b>缺陷</b>，落点 <span class="mono">packages/auth/src/otp.ts:112</span>：<span class="mono">focus()</span> 在 <span class="mono">autoComplete</span> 稳定前调用。', ev: ['packages/auth/src/otp.ts:112', 'packages/auth/src/otp.spec.ts:44'], turns: 4, dur: '42s', mgr: '@linwei · defect 首次' },
      a: { body: '已复现 3 / 3 浏览器组合，Safari 17.3 稳定命中。最后一轮在问作者：「自动填充」开关是否默认开启，这决定复现脚本的预置条件。' }
    },
    {
      n: 322, title: '导出 CSV 时中文列名变成乱码', repo: 'acme/web-console',
      stage: 0, state: 'awaiting_info', cat: null, runs: [2, 0, 0], wait: 192,
      turns: 2, cursor: 3, age: 0, stale: false, actor: 'zhangyu', cost: 0.006,
      labels: ['needs-info'],
      f: { body: '缺 3 项：浏览器版本、导出入口、原始列名。已在 issue 里回复一次并打 <span class="mono">needs-info</span>；48 小时内无补充将自动关闭。', turns: 2, dur: '9s' }
    },
    {
      n: 301, title: 'feat: 支持按负责人批量重新分配任务', repo: 'acme/web-console',
      stage: 2, state: 'blocked', cat: 'requirement', runs: [1, 1, 2], wait: 1260,
      turns: 12, cursor: 19, age: 6, stale: false, actor: 'chenmo', cost: 0.041,
      labels: ['enhancement', 'blocked'],
      f: { body: '模板齐全，验收标准以「批量接口 + 表驱动用例」表述，可直接进入分类。', turns: 2, dur: '14s' },
      c: { body: '判定为<b>需求</b>：已有 <span class="mono">assignment.batch</span> 服务，缺的是批量入口与权限校验。', ev: ['src/assignments/batch.ts:38', 'docs/rbac.md:12'], turns: 3, dur: '51s', mgr: '@chenmo · requirement 首次' },
      a: { body: '测试套件在容器内 <span class="mono">9m02s</span> 超时（<span class="mono">assignment.batch.spec.ts</span>）。<b>连续 2 次运行失败</b> → blocked；重跑不限次数，需要人工判断是环境问题还是用例本身写得过重。', reason: 'test_failed' }
    },
    {
      n: 312, title: 'refactor: 把 webhook 重试逻辑抽成独立模块', repo: 'acme/payments-api',
      stage: 2, state: 'running', cat: 'requirement', runs: [1, 1, 1], wait: 12,
      turns: 3, cursor: 5, age: 0, stale: false, actor: 'chenmo', cost: 0.022,
      labels: ['refactor'],
      f: { body: '模板齐全：背景、目标、非目标、验收标准四段都有。', turns: 2, dur: '12s' },
      c: { body: '判定为<b>需求</b>，非缺陷；影响面 <span class="mono">src/webhooks/*</span>，无对外契约变更。', ev: ['src/webhooks/retry.ts:1', 'src/webhooks/index.ts:22'], turns: 3, dur: '38s', mgr: '@chenmo · requirement 已通知' },
      a: { body: '第 3 轮正在读 <span class="mono">retry.ts</span> 与退避表，准备产出拆分方案。尚未写回。' }
    },
    {
      n: 305, title: '新增团队成员时权限继承不符合预期', repo: 'acme/web-console',
      stage: 3, state: 'closed', cat: 'defect', runs: [1, 1, 2], wait: null,
      turns: 5, cursor: 9, age: 4, stale: false, actor: 'wangjing', cost: 0.033,
      labels: ['bug', 'fixed'],
      f: { body: '复现步骤完整，附带组织与团队两级截图。', turns: 2, dur: '10s' },
      c: { body: '判定为<b>缺陷</b>：<span class="mono">team.inherit.ts:64</span> 在角色合并时覆盖了组织级权限。', ev: ['src/teams/inherit.ts:64'], turns: 3, dur: '44s', mgr: '@wangjing · defect 首次' },
      a: { body: '已开 PR <span class="mono">#412</span> 并合并，回归用例 <span class="mono">team.inherit.spec.ts</span> 补了 3 条。流水线在第 5 轮关闭。', close: 'fixed' }
    },
    {
      n: 299, title: '上传大文件时进度条静止超过 30 秒', repo: 'acme/web-console',
      stage: 0, state: 'awaiting_info', cat: null, runs: [1, 0, 0], wait: 2640,
      turns: 2, cursor: 3, age: 2, stale: false, actor: 'linwei', cost: 0.009,
      labels: ['needs-info'],
      f: { body: '缺 2 项：文件体积、网络环境（内网 / 公网）。已回复一次，作者 44 小时未补充。', turns: 2, dur: '8s' }
    },
    {
      n: 287, title: 'build: 升级 Vite 8 后 HMR 明显变慢', repo: 'acme/web-console',
      stage: 2, state: 'ready', cat: 'other', runs: [1, 1, 2], wait: 300,
      turns: 6, cursor: 11, age: 2, stale: false, actor: 'chenmo', cost: 0.017,
      labels: ['performance'],
      f: { body: '模板齐全，附了冷启动与热更新的耗时对比，数据可直接复核。', turns: 2, dur: '13s' },
      c: { body: '判定为<b>其他</b>：不是缺陷也不是需求，属于构建性能观察项，不 @ 管理人员。', ev: ['vite.config.ts:18'], turns: 3, dur: '40s', mgr: '不通知（other）' },
      a: { body: '已完成分析：热更新 180ms → 640ms，定位到依赖预构建缓存失效。结论已写回 issue，等待维护者决定是否单开需求。' }
    },
    {
      n: 276, title: '搜索框在中文输入法下重复触发请求', repo: 'acme/web-console',
      stage: 2, state: 'awaiting_info', cat: 'defect', runs: [1, 1, 3], wait: 2760,
      turns: 4, cursor: 8, age: 3, stale: false, actor: 'wangjing', cost: 0.021,
      labels: ['bug', 'i18n'],
      f: { body: '模板齐全，输入法版本与系统语言都写了。', turns: 2, dur: '11s' },
      c: { body: '判定为<b>缺陷</b>：<span class="mono">compositionend</span> 之前触发了 debounce。', ev: ['src/search/useQuery.ts:57'], turns: 4, dur: '46s', mgr: '@wangjing · defect 已通知' },
      a: { body: '在问作者：Safari 下 <span class="mono">compositionend</span> 早于 <span class="mono">input</span>，要不要额外加 100ms 缓冲。已等 46 小时。' }
    },
    {
      n: 281, title: '空状态插画在深色模式下几乎不可见', repo: 'acme/web-console',
      stage: 3, state: 'closed', cat: 'defect', runs: [1, 1, 1], wait: null,
      turns: 3, cursor: 6, age: 2, stale: false, actor: 'zhangyu', cost: 0.008,
      labels: ['bug', 'fixed'],
      f: { body: '附了深浅两种模式的对比截图。', turns: 2, dur: '9s' },
      c: { body: '判定为<b>缺陷</b>：插画使用固定深色填充，没有跟随主题。', ev: ['src/ui/EmptyState.tsx:31'], turns: 2, dur: '31s', mgr: '@zhangyu · defect 首次' },
      a: { body: '替换为双色插画，深色模式对比度 4.8:1。已写回并关闭。', close: 'fixed' }
    },
    {
      n: 315, title: '支付回调偶发重复入账（约 1/2000）', repo: 'acme/payments-api',
      stage: 2, state: 'ready', cat: 'defect', runs: [1, 1, 2], wait: 120,
      turns: 9, cursor: 14, age: 3, stale: true, actor: 'linwei', cost: 0.087,
      labels: ['bug', 'priority:high'],
      f: { body: '复现步骤与发生频率都给了，日志脱敏后可直接用。', turns: 2, dur: '15s' },
      c: { body: '判定为<b>缺陷</b>：幂等键只用了 <span class="mono">order_id</span>，同订单多事件会重复入账。', ev: ['src/payments/idempotency.ts:41'], turns: 3, dur: '58s', mgr: '@linwei · defect 首次' },
      a: { body: '结论已写回：建议幂等键改为 <span class="mono">order_id + event_id</span>，并附历史数据补偿口径。作者在 2 小时前编辑了正文，结论未回退，只记了一次 stale。' }
    },
    {
      n: 311, title: '搜索结果排序在同义词下不稳定', repo: 'acme/web-console',
      stage: 1, state: 'running', cat: null, runs: [1, 1, 0], wait: 4,
      turns: 2, cursor: 3, age: 0, stale: false, actor: 'zhangyu', cost: 0.007,
      labels: ['bug', 'search'],
      f: { body: '模板齐全：查询词、期望顺序、实际顺序都给了，附两条同义词的对比。', turns: 2, dur: '10s' }
    },
    {
      n: 308, title: '搜索排名疑似被人工降权（查不到证据）', repo: 'acme/web-console',
      stage: 1, state: 'awaiting_info', cat: 'not_found', runs: [1, 2, 0], wait: 900,
      turns: 3, cursor: 6, age: 1, stale: false, actor: 'wangjing', cost: 0.019,
      labels: ['needs-info', 'pipeline:classify'],
      f: { body: '模板齐全：给了查询词、对比截图与期望排名。', turns: 2, dur: '10s' },
      c: { body: '按描述检索 <span class="mono">src/search/*</span>、<span class="mono">src/rank/*</span> 与近 30 天发布记录，<b>查不到</b>人工干预入口或权重配置。已 @ 维护者确认是否存在内部权重表。', ev: ['src/search/rank.ts', 'src/rank/config/*', '近 30 天发布记录'], turns: 3, dur: '44s', mgr: '@chenmo · not_found 要求管理员回复' }
    },
    {
      n: 296, title: '文档站的搜索索引在构建后没有更新', repo: 'acme/infra-terraform',
      stage: 1, state: 'running', cat: null, runs: [1, 2, 0], wait: 4,
      turns: 3, cursor: 5, age: 0, stale: false, actor: 'wangjing', cost: 0.012,
      labels: ['bug', 'docs'],
      f: { body: '模板齐全，附了构建日志与 CDN 发布记录。', turns: 2, dur: '10s' }
    },
    {
      n: 309, title: 'CI 在 Node 22 上偶发 OOM', repo: 'acme/infra-terraform',
      stage: 2, state: 'blocked', cat: 'defect', runs: [1, 1, 2], wait: 180,
      turns: 8, cursor: 13, age: 5, stale: false, actor: 'zhangyu', cost: 0.055,
      labels: ['ci', 'blocked'],
      f: { body: '模板齐全，附了容器内存曲线。', turns: 2, dur: '12s' },
      c: { body: '判定为<b>缺陷</b>：<span class="mono">node --test</span> 峰值 2.3 GB，超过 2 GB 上限。', ev: ['.github/workflows/ci.yml:57'], turns: 3, dur: '41s', mgr: '@zhangyu · defect 首次' },
      a: { body: '容器 OOM，退出码 137，<b>连续 2 次</b> → blocked。建议把测试并发降到 2 或把该 job 调到 4 GB；需人工改 workflow，Agent 不改 CI 配置。', reason: 'container_oom' }
    },
    {
      n: 291, title: 'docs: 补充本地开发环境的容器说明', repo: 'acme/infra-terraform',
      stage: 3, state: 'closed', cat: 'other', runs: [1, 1, 1], wait: null,
      turns: 3, cursor: 5, age: 1, stale: false, actor: 'chenmo', cost: 0.014,
      labels: ['docs', 'fixed'],
      f: { body: '模板不适用（docs 类），按宽松通道放行。', turns: 2, dur: '8s' },
      c: { body: '判定为<b>其他</b>：纯文档补充，不 @ 管理人员。', turns: 2, dur: '29s', mgr: '不通知（other）' },
      a: { body: '已开 PR <span class="mono">#408</span> 并合并，补了 <span class="mono">docker compose</span> 的端口冲突说明。', close: 'fixed' }
    }
  ];

  var STATE_META = {
    pending: { label: '排队', cls: '' },
    running: { label: '执行中', cls: 'info' },
    awaiting_info: { label: '待人补充', cls: 'warn' },
    blocked: { label: '阻塞', cls: 'bad' },
    ready: { label: '已就绪', cls: 'ok' },
    closed: { label: '已关闭', cls: '' }
  };

  var CAT_META = {
    requirement: { label: '需求', cls: 'info' },
    defect: { label: '缺陷', cls: 'bad' },
    not_found: { label: '当前查不到', cls: '' },
    other: { label: '其他', cls: '' }
  };

  var STAGES = [
    { name: '格式检查', kind: 'format_check', ver: 'v3' },
    { name: '标签分类', kind: 'classify', ver: 'v2' },
    { name: 'Agent 执行', kind: 'agent', ver: 'v4' }
  ];

  function waitText(mins) {
    if (mins == null) return '—';
    if (mins < 60) return Math.round(mins) + ' 分钟';
    var h = mins / 60;
    return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)) + ' 小时';
  }

  function stageState(item, idx) {
    if (item.stage === 3) return 'done';
    if (idx < item.stage) return 'done';
    if (idx > item.stage) return 'todo';
    if (item.state === 'running') return 'on';
    if (item.state === 'awaiting_info') return 'warn';
    if (item.state === 'blocked') return 'bad';
    if (item.state === 'ready') return 'done';
    return 'todo';
  }

  function stagePill(st, label) {
    var map = {
      done: ['通过', 'ok'],
      on: ['执行中', 'info'],
      warn: ['待人补充', 'warn'],
      bad: ['阻塞', 'bad'],
      todo: ['未开始', '']
    };
    var m = map[st] || map.todo;
    return '<span class="pill ' + m[1] + '"><i class="dot"></i>' + (label || m[0]) + '</span>';
  }

  function initIssues() {
    var state = { q: '', stage: 'all', status: 'all', selected: null, repo: currentRepo() };
    var rowsHost = $('#issue-rows');
    if (!rowsHost) return;

    function repoItems() {
      return ISSUES.filter(function (i) { return i.repo === state.repo; });
    }

    function filtered() {
      return repoItems().filter(function (i) {
        if (state.stage !== 'all' && String(i.stage) !== state.stage) return false;
        if (state.status !== 'all' && i.state !== state.status) return false;
        if (state.q && (i.title + ' #' + i.n).toLowerCase().indexOf(state.q.toLowerCase()) < 0) return false;
        return true;
      });
    }

    function paintChips() {
      var base = repoItems();
      $$('[data-state]').forEach(function (chip) {
        var key = chip.dataset.state;
        var n = key === 'all' ? base.length : base.filter(function (i) { return i.state === key; }).length;
        var box = chip.querySelector('.n');
        if (box) box.textContent = n;
        chip.hidden = key !== 'all' && n === 0;
      });
    }

    function renderList() {
      var items = filtered();
      paintChips();
      var count = $('#issue-count');
      if (count) count.textContent = items.length + ' / ' + repoItems().length;

      if (!items.length) {
        rowsHost.innerHTML = '<div class="empty"><div class="empty-title">当前筛选下没有 issue</div><div class="empty-sub">清空搜索，或切回「全部阶段」</div></div>';
        return;
      }

      rowsHost.innerHTML = items.map(function (i) {
        var meta = (i.stage === 1 && i.state === 'awaiting_info') ? { label: '等管理员', cls: 'warn' } : STATE_META[i.state];
        var cat = i.cat ? CAT_META[i.cat] : null;
        var segs = [0, 1, 2].map(function (k) { return '<i class="' + stageState(i, k) + '"></i>'; }).join('');
        var stageName = i.stage === 3 ? '已结束' : '阶段 ' + i.stage + ' · ' + STAGES[i.stage].name;
        var extra = '';
        if (i.stage === 0 && i.runs[0] > 0) {
          extra += '<span class="pill line">失败 ' + i.runs[0] + ' / 5</span>';
        } else if ((i.stage === 1 || i.stage === 2) && i.runs[i.stage] > 1) {
          extra += '<span class="pill line">重跑 ' + i.runs[i.stage] + ' 次</span>';
        }
        if (i.stale) extra += '<span class="pill warn">结论陈旧</span>';
        return '<div class="irow' + (state.selected === i.n ? ' is-active' : '') + '" data-n="' + i.n + '" tabindex="0">' +
          '<span class="irow-num">#' + i.n + '</span>' +
          '<div class="irow-main"><div class="irow-title">' + i.title + '</div>' +
          '<div class="irow-meta">' +
          '<span class="stagebar" title="' + stageName + '">' + segs + '</span>' +
          '<span class="stage-name">' + stageName + '</span>' +
          (cat ? '<span class="pill line">' + cat.label + '</span>' : '') +
          extra +
          '</div></div>' +
          '<div class="irow-right"><span class="pill ' + meta.cls + '"><i class="dot"></i>' + meta.label + '</span>' +
          '<span class="irow-time">' + (i.wait == null ? '已结束' : '停留 ' + waitText(i.wait)) + '</span></div></div>';
      }).join('');

      $$('.irow', rowsHost).forEach(function (row) {
        row.addEventListener('click', function () { select(parseInt(row.dataset.n, 10)); });
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter') select(parseInt(row.dataset.n, 10)); });
      });
    }

    function select(n) {
      state.selected = n;
      renderList();
      renderDetail();
    }

    function stageBody(item, idx) {
      var st = stageState(item, idx);
      if (st === 'todo') return '<p class="faint">未开始 · 上一步通过后自动开始，不与前一步共用会话。</p>';
      var d = idx === 0 ? item.f : idx === 1 ? item.c : item.a;
      if (!d) return '<p class="faint">该阶段尚未产出结论。</p>';
      var html = '<p>' + d.body + '</p>';
      if (d.ev) {
        html += '<div class="evidence">' + d.ev.map(function (p) { return '<span class="evidence-chip">' + p + '</span>'; }).join('') + '</div>';
      }
      if (d.mgr) html += '<p class="faint" style="font-size:10px;margin-top:6px">管理人员通知：' + d.mgr + '</p>';
      if (d.reason) html += '<p class="faint" style="font-size:10px;margin-top:6px">blocked_reason：<span class="mono">' + d.reason + '</span></p>';
      return html;
    }

    function stageMeta(item, idx) {
      var st = stageState(item, idx);
      if (st === 'todo') return '<span>—</span>';
      var d = idx === 0 ? item.f : idx === 1 ? item.c : item.a;
      var parts = [];
      if (idx < 2) {
        parts.push('一次性会话');
        if (d && d.turns) parts.push(d.turns + ' 轮');
        if (d && d.dur) parts.push(d.dur);
        parts.push('已归档');
      } else {
        parts.push('复用会话');
        parts.push(item.turns + ' 轮');
        parts.push('cursor ' + item.cursor);
        parts.push(item.age >= 1 ? item.age + ' 天前建立' : '今天建立');
      }
      var meta = '<span>' + parts.join('</span><span class="sep">·</span><span>') + '</span>';
      if (item.stage >= idx) {
        meta += '<a class="open" href="run.html">打开会话 →</a>';
      }
      return meta;
    }

    function renderDetail() {
      var host = $('#issue-detail');
      if (!host) return;
      var item = ISSUES.filter(function (i) { return i.n === state.selected; })[0];
      if (!item) {
        host.innerHTML = '<div class="empty" style="flex:1"><div class="empty-title">从左侧选择一个 issue</div><div class="empty-sub">j / k 移动，Enter 打开</div></div>';
        return;
      }
      var meta = (item.stage === 1 && item.state === 'awaiting_info') ? { label: '等管理员', cls: 'warn' } : STATE_META[item.state];
      var cat = item.cat ? CAT_META[item.cat] : null;
      var attempt = item.runs[Math.min(item.stage, 2)];

      var steps = [0, 1, 2].map(function (idx) {
        var st = stageState(item, idx);
        var s = STAGES[idx];
        var num = st === 'done' ? '✓' : st === 'bad' ? '!' : st === 'warn' ? '?' : String(idx);
        return '<div class="pstep ' + st + '">' +
          '<div class="pstep-rail"><span class="pstep-dot">' + num + '</span></div>' +
          '<div class="pstep-card">' +
          '<div class="pstep-h"><h5>' + s.name + '</h5>' +
          '<span class="mono">' + s.kind + ' ' + s.ver + '</span>' + stagePill(st, idx === 1 && st === 'warn' ? '等管理员' : '') + '</div>' +
          '<div class="pstep-b">' + stageBody(item, idx) + '</div>' +
          '<div class="pstep-m">' + stageMeta(item, idx) + '</div>' +
          '</div></div>';
      }).join('');

      var alerts = '';
      if (item.state === 'awaiting_info' && item.stage === 1) {
        alerts = '<div class="detail-sec"><h4>等待管理员</h4>' +
          '<div class="notice" style="align-items:flex-start"><span class="dot tone-warn" style="margin-top:4px"></span>' +
          '<span>分类结论是 <b>not-found</b>（查不到缺陷证据）。已 @ 维护者要求回复，<b>只有 managers 的评论会触发重分类</b>；作者或他人的评论只记录、不重跑。</span></div>' +
          '<div class="faint" style="font-size:10.5px;margin-top:7px"><span class="mono">info_requested_at = NULL</span> · 不计入 48 小时关闭扫描；<span class="mono">/pipeline next</span> 可直接进入阶段 2。</div></div>';
      } else if (item.state === 'awaiting_info') {
        var leftMin = Math.max(0, 48 * 60 - item.wait);
        var lh = Math.floor(leftMin / 60);
        var lm = Math.round(leftMin % 60);
        var pct = Math.max(4, Math.min(100, (item.wait / 60 / 48) * 100));
        alerts = '<div class="detail-sec"><h4>自动关闭倒计时</h4>' +
          '<div style="display:flex;align-items:baseline;gap:7px;margin-bottom:6px">' +
          '<span class="num" style="font-size:15px;color:var(--ink)">' + lh + '</span>' +
          '<span class="faint" style="font-size:10.5px">小时' + (lm ? ' ' + lm + ' 分' : '') + '后自动关闭 · 已等待 ' + waitText(item.wait) + '</span></div>' +
          '<div class="bar ' + (lh < 10 ? 'bad' : 'warn') + '"><i style="width:' + pct + '%"></i></div>' +
          '<div class="faint" style="font-size:10.5px;margin-top:7px">确定性作业 <span class="mono">pipeline-close</span> 每 10 分钟扫描一次；期间收到 @ 仍会优先当评论处理。</div></div>';
      } else if (item.state === 'blocked') {
        alerts = '<div class="detail-sec"><h4>阻塞</h4><div class="notice bad" style="align-items:flex-start">' +
          '<span class="dot tone-bad" style="margin-top:4px"></span>' +
          '<span><b>连续 ' + attempt + ' 次运行失败</b>（<span class="mono">' + ((item.a && item.a.reason) || 'unknown') + '</span>）→ blocked。重跑不限次数；<span class="mono">/pipeline next</span> 可解禁并推进到下一阶段，仅 managers 可用。</span></div></div>';
      } else if (item.stale) {
        alerts = '<div class="detail-sec"><h4>结论时效</h4><div class="notice">' +
          '<span class="dot tone-warn"></span><span>作者在结论产出后编辑了正文。<b>结论不回退</b>，只记录 <span class="mono">stale_at</span>；需要新结论请手动 <span class="mono">/recheck</span>。</span></div></div>';
      } else if (item.state === 'ready') {
        alerts = '<div class="detail-sec"><h4>结论时效</h4><div class="notice info">' +
          '<span class="dot tone-info"></span><span>已产出结论并写回。此后正文改动不会让流水线回退到分类阶段，只标记为陈旧。</span></div></div>';
      }

      host.innerHTML =
        '<div class="detail-h"><div class="detail-kicker"><span class="mono">' + item.repo + '</span><span>·</span><span>#' + item.n + '</span>' +
        (cat ? '<span class="pill ' + cat.cls + '" style="margin-left:auto"><i class="dot"></i>' + cat.label + '</span>' : '<span style="margin-left:auto"></span>') +
        '</div><div class="detail-title">' + item.title + '</div>' +
        '<div class="detail-tags"><span class="pill ' + meta.cls + '"><i class="dot"></i>' + meta.label + '</span>' +
        '<span class="pill line">' + (item.stage === 3 ? '已结束' : '阶段 ' + item.stage + ' / 3') + '</span>' +
        (item.stage === 0 && item.runs[0] > 0 ? '<span class="pill line">失败 ' + item.runs[0] + ' / 5</span>' :
          (item.stage < 3 && item.runs[item.stage] > 1 ? '<span class="pill line">重跑 ' + item.runs[item.stage] + ' 次</span>' : '')) +
        item.labels.map(function (l) { return '<span class="pill line">' + l + '</span>'; }).join('') +
        '<span class="pill">@' + item.actor + '</span></div></div>' +
        '<div class="detail-body">' +
        '<div class="detail-sec"><h4>三步流水线 · 每步一个独立会话</h4><div class="psteps">' + steps + '</div></div>' +
        alerts +
        '<div class="detail-sec"><h4>口径</h4><dl class="kv">' +
        '<dt>阶段重跑</dt><dd class="num">' + item.runs.join(' / ') + ' 次</dd>' +
        '<dt>累计成本</dt><dd class="num">$' + item.cost.toFixed(3) + '</dd>' +
        '<dt>触发人</dt><dd class="mono">@' + item.actor + '</dd>' +
        '<dt>写回闸门</dt><dd>' + (item.state === 'blocked' ? '<span class="pill bad"><i class="dot"></i>未写回</span>' : '<span class="pill ok"><i class="dot"></i>动作已应用</span>') + '</dd>' +
        '</dl></div></div>' +
        '<div class="detail-f">' +
        (item.state === 'blocked'
          ? '<button class="btn sm primary" type="button" data-act="next">/pipeline next</button>' +
            '<a class="btn sm" href="run.html">打开会话</a>'
          : (item.stage < 3 ? '<a class="btn sm primary" href="run.html">打开当前会话</a>' : '<a class="btn sm primary" href="run.html">查看最后会话</a>')) +
        '<button class="btn sm" type="button" data-act="recheck">/recheck</button>' +
        (item.stage > 0 && item.stage < 3 ? '<button class="btn sm ghost" type="button" data-act="prev">/pipeline prev</button>' : '') +
        '<button class="btn sm ghost" type="button" data-act="gh">在 GitHub 打开</button>' +
        '</div>';

      $$('[data-act]', host).forEach(function (b) {
        b.addEventListener('click', function () {
          var map = {
            recheck: '已排队 /recheck：只重跑当前阶段（演示）',
            next: '已排队 /pipeline next：仅 managers，blocked 时等价解禁（演示）',
            prev: '已排队 /pipeline prev：退回上一阶段并重跑（仅 managers）',
            gh: '将跳转 github.com/' + item.repo + '/issues/' + item.n
          };
          toast(map[b.dataset.act], b.dataset.act === 'next' ? 'warn' : 'ok');
        });
      });
    }

    $$('[data-state]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.status = chip.dataset.state;
        $$('[data-state]').forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
        renderList();
      });
    });
    var stageSel = $('#issue-stage');
    if (stageSel) stageSel.addEventListener('change', function () { state.stage = stageSel.value; renderList(); });
    var search = $('#issue-search');
    if (search) search.addEventListener('input', function () { state.q = search.value; renderList(); });

    document.addEventListener('repo:change', function (e) {
      state.repo = e.detail.repo;
      var first = ISSUES.filter(function (i) { return i.repo === state.repo; })[0];
      state.selected = first ? first.n : null;
      renderList();
      renderDetail();
    });

    document.addEventListener('keydown', function (e) {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      var items = filtered();
      if (!items.length) return;
      var idx = items.findIndex(function (i) { return i.n === state.selected; });
      if (e.key === 'j') { e.preventDefault(); select(items[Math.min(items.length - 1, idx + 1)].n); }
      else if (e.key === 'k') { e.preventDefault(); select(items[Math.max(0, idx - 1)].n); }
      else if (e.key === 'Enter' && state.selected) { location.href = 'run.html'; }
    });

    var start = ISSUES.filter(function (i) { return i.repo === state.repo; })[0];
    state.selected = start ? start.n : null;
    renderList();
    renderDetail();
  }

  /* ── 页面：运行详情 ───────────────────────────────────────────────────── */
  function initRun() {
    $$('[data-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        $$('[data-tab]').forEach(function (t) { t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
        $$('[data-tab-panel]').forEach(function (p) {
          p.hidden = p.dataset.tabPanel !== tab.dataset.tab;
        });
      });
    });
    $$('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () { copyText(b.dataset.copy, '已复制到剪贴板'); });
    });
    $$('[data-event-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var mode = chip.dataset.eventFilter;
        $$('[data-event-filter]').forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
        $$('.event').forEach(function (row) {
          row.style.display = mode === 'error' && !row.classList.contains('is-error') ? 'none' : 'grid';
        });
      });
    });
    $$('[data-expand]').forEach(function (b) {
      b.addEventListener('click', function () {
        var target = document.getElementById(b.dataset.expand);
        if (!target) return;
        target.hidden = !target.hidden;
        b.textContent = target.hidden ? '展开 JSON' : '收起 JSON';
      });
    });
    $$('[data-disabled]').forEach(function (b) {
      b.addEventListener('click', function () { toast(b.dataset.disabled, 'warn'); });
    });
  }

  /* ── 页面：成本 ───────────────────────────────────────────────────────── */
  function initCosts() {
    var host = $('#cost-chart');
    if (!host) return;

    // 30 天基数：形状固定，总和归一到与「按仓库」表一致（$142.86）
    var shape = [0.62, 0.78, 1.05, 0.92, 1.18, 1.32, 0.54, 0.48, 1.12, 1.26, 1.02, 0.88, 1.34, 1.46, 1.28,
      1.1, 0.96, 0.5, 0.46, 1.16, 1.3, 1.42, 1.2, 1.06, 1.38, 1.5, 1.62, 0.58, 0.52, 1.28];
    var shapeSum = shape.reduce(function (a, b) { return a + b; }, 0);
    var BASE_TOTAL = 142.86;
    var BASE_TASKS = 1374;
    var labels = [];
    var values = [];
    for (var i = 0; i < 30; i++) {
      var d = new Date(Date.now() - (29 - i) * 864e5);
      labels.push((d.getMonth() + 1) + '/' + d.getDate());
      values.push(+(shape[i] * (BASE_TOTAL / shapeSum)).toFixed(2));
    }

    function paint(days) {
      var tail = values.slice(30 - days);
      var tailLabels = labels.slice(30 - days);
      renderArea(host, tailLabels, tail, { prefix: '$', decimals: 1, height: 190, zero: true });

      var total = tail.reduce(function (a, b) { return a + b; }, 0);
      var avg = total / days;
      var peak = Math.max.apply(null, tail);
      var peakIdx = tail.indexOf(peak);
      var ratio = total / BASE_TOTAL;
      var tasks = Math.round(BASE_TASKS * ratio);

      var set = function (id, text) { var n = document.getElementById(id); if (n) n.textContent = text; };
      set('cost-total', '$' + total.toFixed(2));
      set('cost-avg', '$' + avg.toFixed(2));
      set('cost-peak', '$' + peak.toFixed(2));
      set('cost-peak-date', tailLabels[peakIdx]);
      set('cost-unit', '$' + (total / tasks).toFixed(3));
      set('cost-tasks', fmt(tasks) + ' 个任务');
      set('cost-note', '最近 ' + days + ' 天 · UTC');

      $$('[data-repo-row]').forEach(function (row) {
        var baseCost = parseFloat(row.dataset.baseCost);
        var baseTasks = parseInt(row.dataset.baseTasks, 10);
        var cost = baseCost * ratio;
        var repoTasks = Math.round(baseTasks * ratio);
        row.querySelector('[data-cell="cost"]').textContent = '$' + cost.toFixed(2);
        row.querySelector('[data-cell="tasks"]').textContent = fmt(repoTasks);
        row.querySelector('[data-cell="share"]').textContent = (cost / total * 100).toFixed(1) + '%';
        row.querySelector('[data-cell="avg"]').textContent = '$' + (cost / (repoTasks || 1)).toFixed(3);
      });

      var totalRow = $('#cost-total-row');
      if (totalRow) {
        totalRow.querySelector('[data-cell="tasks"]').textContent = fmt(tasks);
        totalRow.querySelector('[data-cell="cost"]').textContent = '$' + total.toFixed(2);
        totalRow.querySelector('[data-cell="share"]').textContent = '100%';
        totalRow.querySelector('[data-cell="avg"]').textContent = '$' + (total / tasks).toFixed(3);
      }
    }

    $$('[data-window]').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('[data-window]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        paint(parseInt(b.dataset.window, 10));
      });
    });

    $$('th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var table = th.closest('table');
        var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
        var tbody = table.querySelector('tbody');
        var rows = Array.prototype.slice.call(tbody.children);
        var numeric = /成本|任务|占比|次数|均价|tokens/.test(th.textContent);
        var dir = th.dataset.dir === 'desc' ? 1 : -1;
        $$('th', table).forEach(function (h) { h.dataset.dir = ''; });
        th.dataset.dir = dir === 1 ? 'desc' : 'asc';
        rows.sort(function (a, b) {
          var av = a.children[idx].textContent.replace(/[$,\s%]/g, '');
          var bv = b.children[idx].textContent.replace(/[$,\s%]/g, '');
          if (numeric) return (parseFloat(av) - parseFloat(bv)) * dir;
          return av.localeCompare(bv) * dir;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
        toast('已按「' + th.textContent.trim() + '」排序', 'info');
      });
    });

    paint(30);
  }

  /* ── 页面：质量 ───────────────────────────────────────────────────────── */
  function initQuality() {
    var byCommand = [
      { label: '/review-pr', value: 38, display: '8.1%' },
      { label: '/issue-triage', value: 21, display: '4.2%' },
      { label: '/issue-repro', value: 14, display: '5.0%' },
      { label: '自动分类', value: 9, display: '2.6%' }
    ];
    var byRepo = [
      { label: 'acme/web-console', value: 44, display: '7.4%' },
      { label: 'acme/payments-api', value: 25, display: '5.2%' },
      { label: 'acme/infra-terraform', value: 13, display: '4.1%' }
    ];
    var host = $('#revert-bars');
    function paint(mode) {
      renderHBars(host, mode === 'repo' ? byRepo : byCommand, 'bad');
      var note = $('#revert-note');
      if (note) note.textContent = mode === 'repo' ? '按仓库分组 · 窗口内已应用动作' : '按命令分组 · 窗口内已应用动作';
    }
    $$('[data-group]').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('[data-group]').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        paint(b.dataset.group);
      });
    });
    paint('command');

    $$('[data-revert-row]').forEach(function (row) {
      row.addEventListener('click', function () {
        var detail = row.nextElementSibling;
        if (!detail) return;
        detail.hidden = !detail.hidden;
      });
    });
  }

  /* ── 页面：审计 ───────────────────────────────────────────────────────── */
  function initAudit() {
    var tbody = $('#audit-body');
    if (!tbody) return;

    $$('[data-audit-row]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        var detail = row.nextElementSibling;
        if (detail && detail.classList.contains('audit-detail')) detail.hidden = !detail.hidden;
      });
    });

    var search = $('#audit-search');
    var action = $('#audit-action');
    function apply() {
      var q = (search ? search.value : '').toLowerCase();
      var act = action ? action.value : '';
      $$('#audit-body > tr[data-audit-row]').forEach(function (row) {
        var text = row.textContent.toLowerCase();
        var okQ = !q || text.indexOf(q) >= 0;
        var okA = !act || row.dataset.action === act;
        var show = okQ && okA;
        row.style.display = show ? '' : 'none';
        var detail = row.nextElementSibling;
        if (detail && detail.classList.contains('audit-detail') && !show) detail.hidden = true;
      });
      var visible = $$('#audit-body > tr[data-audit-row]').filter(function (r) { return r.style.display !== 'none'; }).length;
      var count = $('#audit-count');
      if (count) count.textContent = visible + ' / 8 条';
    }
    if (search) search.addEventListener('input', apply);
    if (action) action.addEventListener('change', apply);
    var exportBtn = $('#audit-export');
    if (exportBtn) exportBtn.addEventListener('click', function () { toast('已导出 CSV（演示，未写入磁盘）', 'ok'); });
  }

  /* ── 页面：技能 ───────────────────────────────────────────────────────── */
  function initSkills() {
    $$('.switch[data-skill]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        toast((next ? '已启用 ' : '已停用 ') + sw.dataset.skill + '（演示）', next ? 'ok' : 'warn');
      });
    });

    var wrap = $('#skill-drawer');
    function open(drawerData) {
      if (!wrap) return;
      $('#skill-drawer-title').textContent = drawerData.name;
      $('#skill-drawer-path').textContent = drawerData.path;
      $('#skill-drawer-yaml').textContent = drawerData.yaml;
      $('#skill-drawer-stats').innerHTML = drawerData.stats.map(function (s) {
        return '<div><span class="faint" style="font-size:10px">' + s.k + '</span><div class="num" style="font-size:13px;font-weight:500">' + s.v + '</div></div>';
      }).join('');
      wrap.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    $$('[data-skill-open]').forEach(function (b) {
      b.addEventListener('click', function () {
        var yamlNode = document.getElementById(b.dataset.yamlId);
        open({
          name: b.dataset.skillOpen,
          path: 'skills/' + b.dataset.skillOpen.replace(/^\//, '') + '/SKILL.md',
          yaml: yamlNode ? yamlNode.textContent : '',
          stats: [{ k: '近 7 天调用', v: b.dataset.calls }, { k: '成功率', v: b.dataset.rate }, { k: '平均耗时', v: b.dataset.dur }]
        });
      });
    });
    $$('[data-close-drawer]').forEach(function (b) {
      b.addEventListener('click', function () {
        wrap.classList.remove('open');
        document.body.style.overflow = '';
      });
    });
    if (wrap) wrap.addEventListener('mousedown', function (e) {
      if (e.target === wrap) { wrap.classList.remove('open'); document.body.style.overflow = ''; }
    });

    var dry = $('#skill-dryrun');
    if (dry) dry.addEventListener('click', function () { toast('已排队一次 dry-run（演示，不写 GitHub）', 'ok'); });
  }

  /* ── 页面：系统 ───────────────────────────────────────────────────────── */
  function initSystem() {
    var run = $('#doctor-run');
    if (run) run.addEventListener('click', function () {
      run.setAttribute('disabled', '');
      run.textContent = '体检中';
      var rows = $$('.check-row');
      rows.forEach(function (r) {
        var s = r.querySelector('[data-check-state]');
        if (!s) return;
        s.className = 'pill';
        s.innerHTML = '<i class="dot"></i>等待';
      });
      var i = 0;
      var timer = setInterval(function () {
        if (i >= rows.length) {
          clearInterval(timer);
          run.removeAttribute('disabled');
          run.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.6v3.2H10" stroke-linecap="round" stroke-linejoin="round"/></svg> 重新体检';
          var stamp = $('#doctor-stamp');
          if (stamp) stamp.textContent = '刚刚 · 14 项完成（1 降级）';
          toast('体检完成：14 项，13 通过 1 降级', 'warn');
          return;
        }
        var s = rows[i].querySelector('[data-check-state]');
        if (s) {
          var name = rows[i].querySelector('.check-name').textContent;
          var isWarn = name === 'repo.settings';
          s.className = 'pill ' + (isWarn ? 'warn' : 'ok');
          s.innerHTML = '<i class="dot"></i>' + (isWarn ? '降级' : '通过');
        }
        i++;
      }, 170);
    });

    var pause = $('#pause-all');
    var dialog = $('#pause-dialog');
    if (pause && dialog) {
      pause.addEventListener('click', function () { dialog.classList.add('open'); });
      $$('[data-close-dialog]', dialog).forEach(function (b) {
        b.addEventListener('click', function () { dialog.classList.remove('open'); });
      });
      var confirm = $('#pause-confirm');
      if (confirm) confirm.addEventListener('click', function () {
        dialog.classList.remove('open');
        var banner = $('#paused-banner');
        if (banner) {
          banner.hidden = false;
          banner.innerHTML = '<span class="dot tone-warn"></span><span><b>已暂停全部自动执行</b> · 解除时间 11:10（UTC+8）· 期间新事件只入队</span><button class="link" type="button" id="resume-btn" style="margin-left:auto">恢复</button>';
          var resume = $('#resume-btn');
          if (resume) resume.addEventListener('click', function () {
            banner.hidden = true;
            pause.textContent = '暂停全部自动执行';
            toast('已解除暂停（演示）', 'ok');
          });
        }
        pause.textContent = '恢复自动执行';
        toast('已写入 runtime_flags.rate_limit_pause（演示）', 'warn');
      });
    }
  }

  /* ── 页面：设置 ───────────────────────────────────────────────────────── */
  function initSettings() {
    var body = $('.settings-body');
    if (!body) return;
    var dirty = false;
    var saveBar = $('#save-bar');

    function setDirty(next) {
      dirty = next;
      if (saveBar) saveBar.classList.toggle('show', dirty);
    }

    function showSection(id) {
      $$('.settings-nav button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.section === id ? 'true' : 'false'); });
      $$('.section-switch').forEach(function (p) { p.classList.toggle('on', p.dataset.section === id); });
      var bodyEl = $('.settings-scroll');
      if (bodyEl) bodyEl.scrollTop = 0;
    }

    $$('.settings-nav button').forEach(function (btn) {
      btn.addEventListener('click', function () { showSection(btn.dataset.section); });
    });

    var initial = (location.hash || '').replace('#', '');
    if (initial) showSection(initial);

    $$('.settings-scroll input, .settings-scroll textarea, .settings-scroll select, .settings-scroll .switch').forEach(function (input) {
      input.addEventListener('input', function () { setDirty(true); });
      input.addEventListener('change', function () { setDirty(true); });
      input.addEventListener('click', function () { if (input.classList.contains('switch')) setDirty(true); });
    });

    var save = $('#save-btn');
    if (save) save.addEventListener('click', function () {
      save.setAttribute('disabled', '');
      save.textContent = '保存中';
      setTimeout(function () {
        save.removeAttribute('disabled');
        save.textContent = '保存更改';
        setDirty(false);
        toast('已保存并触发配置校验：通过（演示）', 'ok');
      }, 520);
    });
    var reset = $('#reset-btn');
    if (reset) reset.addEventListener('click', function () { setDirty(false); toast('已丢弃未保存的更改', 'info'); });

    $$('[data-preview]').forEach(function (b) {
      b.addEventListener('click', function () {
        var wrap = $('#prompt-drawer');
        if (!wrap) return;
        var key = b.dataset.preview;
        var src = document.getElementById('pv-' + key);
        var target = $('#prompt-drawer-body');
        var title = $('#prompt-drawer-title');
        if (!target || !src) return;
        var body = src.textContent.replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
        var layers = [
          ['head 硬骨架', 1240], ['P1 项目约定', 620], ['AGENTS.md', 1040], ['技能 frontmatter', 360], ['tail 输出契约', 440]
        ];
        if (title) title.textContent = '提示词预览 · ' + key;
        target.innerHTML =
          '<div class="panel-pad" style="background:var(--surface-2);border-radius:7px;border:1px solid var(--line);margin-bottom:12px">' +
          '<div class="faint" style="font-size:10px;margin-bottom:7px">渲染后的系统提示词 · 只读</div>' +
          '<pre style="margin:0;white-space:pre-wrap;font-family:var(--mono);font-size:11px;line-height:1.7;color:var(--ink-2)">' + body + '</pre></div>' +
          '<div class="faint" style="font-size:10px;margin-bottom:6px">拼接层序 · 括号内为字符数</div>' +
          '<div class="budget">' +
          layers.map(function (l) {
            var pct = Math.round((l[1] / 4000) * 100);
            return '<div class="budget-row"><span class="budget-name">' + l[0] + '</span>' +
              '<span class="budget-track"><i style="width:' + pct + '%"></i></span>' +
              '<span class="num">' + l[1] + '</span></div>';
          }).join('') +
          '</div>';
        wrap.classList.add('open');
      });
    });

    $$('.seg[data-prompt-src]').forEach(function (seg) {
      $$('button', seg).forEach(function (btn) {
        btn.addEventListener('click', function () {
          $$('button', seg).forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
          setDirty(true);
          toast(btn.textContent === '系统默认'
            ? '已切换为系统默认，保存后生成配置 PR（演示）'
            : '已切换为项目版本，保存后生成配置 PR（演示）', 'info');
        });
      });
    });
    $$('[data-close-drawer]').forEach(function (b) {
      b.addEventListener('click', function () {
        var wrap = b.closest('.drawer-wrap');
        if (wrap) wrap.classList.remove('open');
      });
    });

    document.addEventListener('repo:change', function (e) {
      var t = $('#settings-repo');
      if (t) t.textContent = e.detail.repo;
    });
  }

  /* ── 启动 ─────────────────────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initRepoSwitcher();
    initPalette();

    // 全局：没有写接口的动作，点了只解释原因，不假装成功
    $$('[data-disabled-reason]').forEach(function (b) {
      b.addEventListener('click', function () { toast(b.dataset.disabledReason, 'warn'); });
    });

    // 全局：可点击行支持 Enter
    $$('[role="link"][tabindex]').forEach(function (row) {
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
      });
    });

    // 全局：开关（技能卡片有自己的提示，跳过）
    $$('.switch:not([data-skill])').forEach(function (sw) {
      sw.addEventListener('click', function () {
        sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      });
    });

    // 全局：Esc 关闭浮层
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      $$('.drawer-wrap.open, .overlay.open').forEach(function (el) {
        if (el.id === 'palette-overlay') return;
        el.classList.remove('open');
      });
      document.body.style.overflow = '';
    });

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(redrawCharts, 160);
    });

    var page = document.body.dataset.page;
    var map = {
      home: initHome,
      issues: initIssues,
      run: initRun,
      costs: initCosts,
      quality: initQuality,
      audit: initAudit,
      skills: initSkills,
      system: initSystem,
      settings: initSettings
    };
    if (map[page]) map[page]();

    var menu = $('#menu-btn');
    if (menu) menu.addEventListener('click', function () { $('#rail').classList.toggle('open'); });
  });
})();
