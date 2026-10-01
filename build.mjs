#!/usr/bin/env node
/**
 * 生成 Electron 用的渲染页 renderer/index.html。
 *
 *   node build.mjs
 *
 * UI 的唯一真源是 src/widget.js；这里补上桌面形态特有的三件事：
 *   1. 页面透明、没有页面级说明卡 —— 窗口就是组件本身；
 *   2. 量出组件的真实尺寸回报主进程；
 *   3. 把计时状态送到托盘提示与系统通知。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_TOKENS_CSS } from './src/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;

const pluginSource = await readFile(join(ROOT, 'src', 'widget.js'), 'utf8');

try {
  new Function(pluginSource);
} catch (error) {
  console.error(`src/widget.js 语法错误：${error.message}`);
  process.exit(1);
}

async function vendor(pkg, file) {
  const target = join(ROOT, 'node_modules', pkg, 'umd', file);
  try {
    return await readFile(target, 'utf8');
  } catch {
    console.error('缺少 ' + target + ' —— 先跑一次 npm install');
    process.exit(1);
  }
}

const react = await vendor('react', 'react.production.min.js');
const reactDom = await vendor('react-dom', 'react-dom.production.min.js');

const SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>番茄钟</title>
<style>
/*__TOKENS__*/

html,body{
  margin:0; padding:0; height:100%; overflow:hidden;
  background:transparent;
  font-family:"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
}
/* 窗口就是组件：位置交给窗口，禁掉组件在窗口内的位移（用 !important 压过内联样式）。
   留 13px 让阴影有地方画。 */
.dshp-root{
  right:13px !important;
  bottom:13px !important;
}
/* 拖动走系统原生 -webkit-app-region: drag。
   之前用「每帧 IPC + setBounds 移动窗口」，在 Windows 上高频移动 transparent 窗口
   会不停触发分层窗口重绘 —— 表现就是疯狂频闪。原生拖动由系统接管，不闪。
   代价：拖动区收不到 click，所以胶囊的「展开」必须挂在 no-drag 的子元素上。 */
.dshp-head { -webkit-app-region: drag; }
.dshp-head button { -webkit-app-region: no-drag; }
.dshp-pill { -webkit-app-region: drag; }
.dshp-pill, .dshp-head { cursor: grab; }
.dshp-pill:active, .dshp-head:active { cursor: grabbing; }

/* 胶囊右侧的小箭头 = 展开按钮：排除在拖动区外，并放大点击热区 */
.dshp-pill-hint{
  -webkit-app-region: no-drag;
  cursor: pointer;
  padding: 5px;
  margin: -5px;
  border-radius: 6px;
  transition: background .14s ease, color .14s ease;
}
.dshp-pill-hint:hover{
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

/* 「应用已经在运行」时的视觉回应：由主进程调 window.__pomodoroReveal() 触发。
   没有它的话，第二次双击 exe 只会把已有窗口置前 —— 看起来就像什么都没发生。 */
@keyframes dshp-attention{
  0%   { box-shadow: 0 0 0 0 var(--dsw-alias-state-business-primary); }
  100% { box-shadow: 0 0 0 16px transparent; }
}
.dshp-root.dshp-attention .dshp-card,
.dshp-root.dshp-attention .dshp-pill{
  animation: dshp-attention .7s ease-out 3;
}
</style>
</head>
<body>
<div id="pomodoro-host"></div>

<script>/* React 18.3.1 UMD · MIT License */
/*__REACT__*/
</script>
<script>/* ReactDOM 18.3.1 UMD · MIT License */
/*__REACT_DOM__*/
</script>
<script>
(function () {
  'use strict';

  var shell = window.pomodoroShell || null;
  var host = document.getElementById('pomodoro-host');

  /* ---------- 1. 插件工厂体 ----------
     单独包一层 IIFE：插件正文里有自己的 const（store/React/…），
     和外壳的变量同处一个作用域会直接 SyntaxError，整页变成空白透明窗口。
     包起来之后两边互不干扰。 */
  var plugin = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (id) {
      if (id === 'react') return window.React;
      throw new Error('[desktop] 未预期的 require("' + id + '")');
    };

/*__PLUGIN__*/

    return module.exports;
  })();

  /* ---------- 2. 最小 ctx ---------- */
  var Widget = null;
  var ctx = {
    effect: function (fn) {
      var dispose = fn();
      return typeof dispose === 'function' ? dispose : function () {};
    },
    slots: {
      inject: function (name, callback) { return callback(); },
      register: function (options, Component) { Widget = Component; return function () {}; }
    }
  };

  plugin.apply(ctx);
  window.ReactDOM.createRoot(host).render(window.React.createElement(Widget));

  /* ---------- 3. 把组件尺寸报给主进程 ---------- */
  var EXTRA = 26; // 13px 定位留白 × 2

  function measure() {
    if (!shell) return;
    var root = document.querySelector('.dshp-root');
    if (!root) return;
    var rect = root.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    shell.reportSize(Math.ceil(rect.width) + EXTRA, Math.ceil(rect.height) + EXTRA);
  }

  (function watchRoot() {
    var root = document.querySelector('.dshp-root');
    if (!root) {
      window.requestAnimationFrame(watchRoot);
      return;
    }
    if (window.ResizeObserver) {
      new window.ResizeObserver(measure).observe(root);
    } else {
      setInterval(measure, 500);
    }
    window.addEventListener('resize', measure);
    measure();
  })();

  /* ---------- 4. 胶囊的「展开」按钮 + 唤醒钩子 ----------
     拖动本身交给 CSS 的 -webkit-app-region: drag（见上面的样式），由系统原生拖动，
     不走每帧 IPC setBounds —— 那会在 Windows 上让透明窗口疯狂频闪。
     但拖动区收不到 click，所以「展开」只能挂在小箭头这个 no-drag 元素上。
     用捕获阶段拦下来并 stopPropagation，避免再冒泡到胶囊自己的 onClick。 */
  (function enablePillExpand() {
    var widgetStore = plugin.store;
    if (!widgetStore) return;

    function attention() {
      var root = document.querySelector('.dshp-root');
      if (!root) return;
      root.classList.remove('dshp-attention');
      void root.offsetWidth; // 强制重排，动画才能重新播放
      root.classList.add('dshp-attention');
      window.setTimeout(function () { root.classList.remove('dshp-attention'); }, 2200);
    }

    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      if (!target.closest('.dshp-pill-hint')) return;
      event.stopPropagation();
      event.preventDefault();
      widgetStore.setOpen(true);
    }, true);

    /* 主进程在「用户又双击了一次 exe」时会调这个。
       应用是托盘常驻的，第二次启动只会把已有窗口置前；如果用户此刻看到的是
       一个收起的小胶囊，「置前」等于什么都没发生。所以这里明确地展开 + 闪一下。 */
    window.__pomodoroReveal = function () {
      try {
        widgetStore.setOpen(true);
        attention();
        return true;
      } catch (error) {
        return false;
      }
    };
  })();

  /* ---------- 5. 托盘提示 + 系统通知 ---------- */
  var store = plugin.store;
  if (!store || !shell) return;

  var ZH = String(document.documentElement.lang || navigator.language || 'zh')
    .toLowerCase()
    .indexOf('zh') === 0;
  var PHASE = ZH
    ? { focus: '专注', short: '短休息', long: '长休息' }
    : { focus: 'Focus', short: 'Break', long: 'Long break' };

  function clock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  var lastTooltip = '';
  var lastPulse = store.get().pulse;

  store.subscribe(function () {
    var state = store.get();

    var text = (PHASE[state.phase] || state.phase) + ' ' + clock(state.remaining);
    if (state.status === 'paused') text += ZH ? ' · 已暂停' : ' · paused';
    else if (state.status === 'idle') text += ZH ? ' · 未开始' : ' · ready';
    if (text !== lastTooltip) {
      lastTooltip = text;
      shell.setTooltip('番茄钟 · ' + text);
    }

    if (state.pulse !== lastPulse) {
      lastPulse = state.pulse;
      if (state.toast) shell.notify(state.toast);
    }
  });

  var initial = store.get();
  shell.setTooltip('番茄钟 · ' + (PHASE[initial.phase] || initial.phase) + ' ' + clock(initial.remaining));
})();
</script>
</body>
</html>
`;

const html = SHELL
  .replace('/*__TOKENS__*/', () => DSH_TOKENS_CSS)
  .replace('/*__REACT__*/', () => react)
  .replace('/*__REACT_DOM__*/', () => reactDom)
  .replace('/*__PLUGIN__*/', () => pluginSource);

await mkdir(join(HERE, 'renderer'), { recursive: true });
const out = join(HERE, 'renderer', 'index.html');

/*
 * 构建期防线：把最后一段内联脚本原样解析一遍。
 * 这个页面是「外壳脚本 + 插件正文」拼出来的，两边一旦有同名声明
 * （例如都叫 store），浏览器只会抛一个 SyntaxError 让整页变成空白透明窗口 ——
 * 打包、启动全都正常，肉眼完全看不出问题。new Function 解析时就会报错，
 * 于是构建直接失败，而不是把白屏发出去。
 */
try {
  const open = html.lastIndexOf('<script>');
  const close = html.lastIndexOf('</script>');
  new Function(html.slice(open + '<script>'.length, close));
} catch (error) {
  console.error('renderer/index.html 内联脚本语法错误：' + error.message);
  process.exit(1);
}

await writeFile(out, html, 'utf8');

if (!html.includes('pomodoroShell')) {
  console.error('产物自检失败：缺少桌面侧装配代码');
  process.exit(1);
}

console.log(`[desktop] renderer/index.html  ${(html.length / 1024).toFixed(1)} KB`);
