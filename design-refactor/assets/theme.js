/* global window, document */
/*
 * 演示页的深浅色开关：?theme=dark / ?theme=light 覆盖系统偏好。
 *
 * 为什么单独一个文件：四个方案页 + 对照页都要，逻辑只有一行，
 * 复制四份就会出现「改了三处漏一处」。base.css 里已有
 * `[data-theme='dark']` 与 `prefers-color-scheme` 两条通道，这里只负责写入属性。
 */
(function () {
  var query = new URLSearchParams(window.location.search).get('theme');
  if (query === 'dark' || query === 'light') {
    document.documentElement.dataset.theme = query;
  }
})();
