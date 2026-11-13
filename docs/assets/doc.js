/* global window, document */
// 目录高亮：与 docs/requirements.html 内联脚本同一套实现，抽出来给所有文档共用。
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('#toc a'));
  if (!links.length) return;
  var targets = links.map(function (a) { return document.querySelector(a.getAttribute('href')); });
  function sync() {
    var y = window.scrollY + 120, idx = 0;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i] && targets[i].offsetTop <= y) idx = i;
    }
    links.forEach(function (a, i) { a.classList.toggle('on', i === idx); });
  }
  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
})();
