/**
 * 真实浏览器 DOM 测试。
 *
 * smoke-test.mjs 用的是「伪 React + 伪 DOM」，能覆盖逻辑，但覆盖不到真实浏览器的行为：
 * 比如「被 disabled 的按钮点下去到底有没有反应」「React 18 concurrent 渲染之后 DOM 是否已更新」
 * 「localStorage 是否真的写进去了」。这里用无头 Chrome/Edge 跑真页面来补这一层。
 *
 *   node scripts/dom-test.mjs
 *
 * 退出码 0 = 全部通过。
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DSH_TOKENS_CSS } from '../src/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const WORK = join(PKG, '.dom-test');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (!browser) {
  console.error('没有找到 Chrome / Edge，跳过 DOM 测试。');
  process.exit(0);
}

const pluginSource = await readFile(join(PKG, 'src', 'widget.js'), 'utf8');
const react = await readFile(join(PKG, 'node_modules', 'react', 'umd', 'react.production.min.js'), 'utf8');
const reactDom = await readFile(join(PKG, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js'), 'utf8');

/* 页面内测试脚本。刻意不用反引号与 ${}，因为它本身要放进模板字符串。 */
const HARNESS = `
(function () {
  var results = [];
  var errors = [];

  function ok(cond, label) { results.push((cond ? 'PASS' : 'FAIL') + '|' + label); }
  function text(sel) { var el = document.querySelector(sel); return el ? el.textContent : ''; }
  function chips() { return Array.prototype.slice.call(document.querySelectorAll('.dshp-chip')); }
  /* 等 React 把这次更新提交到 DOM。
     用 setTimeout(0) 而不是 requestAnimationFrame：无头 Chrome 在
     --virtual-time-budget 下不一定产出合成帧，rAF 可能永远不回调，测试会卡在第一步。 */
  function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

  window.addEventListener('error', function (event) { errors.push(String(event.message)); });

  /* ---- 可控时钟与定时器 ----
     只接管 setInterval（计时器的心跳）和 Date.now。
     千万别动 setTimeout —— React 的调度器依赖它，替换掉整个渲染都不会发生。 */
  var now = 1700000000000;
  Date.now = function () { return now; };
  var intervals = [];
  window.setInterval = function (fn) { intervals.push(fn); return intervals.length; };
  window.clearInterval = function () {};
  function tick() { intervals.slice().forEach(function (fn) { fn(); }); }

  /* ---- 装配插件（与独立版/桌面版同一套外壳） ---- */
  var plugin = (function () {
    var module = { exports: {} };
    var exports = module.exports;
    var require = function (id) {
      if (id === 'react') return window.React;
      throw new Error('unexpected require: ' + id);
    };
/*__PLUGIN__*/
    return module.exports;
  })();

  var host = document.getElementById('host');
  var Widget = null;
  var ctx = {
    effect: function (fn) { var d = fn(); return typeof d === 'function' ? d : function () {}; },
    slots: {
      inject: function (name, cb) { return cb(); },
      register: function (options, Component) { Widget = Component; return function () {}; }
    }
  };

  plugin.apply(ctx);
  window.ReactDOM.createRoot(host).render(window.React.createElement(Widget));
  var store = plugin.store;

  function click(sel) { var el = document.querySelector(sel); el.click(); return settle(); }

  (async function run() {
    await settle();
    await settle();

    ok(document.querySelectorAll('.dshp-chip').length === 3, '渲染出 3 个阶段按钮');
    ok(text('.dshp-time') === '25:00', '初始 25:00，实为 ' + text('.dshp-time'));
    ok(text('.dshp-btn-primary') === '开始', '初始按钮为「开始」');
    ok(chips().every(function (c) { return !c.disabled; }), '未启动时阶段按钮可点');

    /* --- 问题①：计时中锁住手动切阶段 --- */
    await click('.dshp-btn-primary');
    ok(text('.dshp-btn-primary') === '暂停', '开始后按钮变「暂停」');
    ok(chips().every(function (c) { return c.disabled; }), '计时中三个阶段按钮被 disabled');
    ok(chips()[0].getAttribute('aria-disabled') === 'true', '禁用态带 aria-disabled');

    chips()[1].click();
    await settle();
    ok(chips()[0].getAttribute('aria-selected') === 'true', '计时中点击阶段按钮不生效');

    now += 61000;
    tick();
    await settle();
    ok(text('.dshp-time') === '23:59', '走时 61 秒后显示 23:59，实为 ' + text('.dshp-time'));
    ok(text('.dshp-status') === '进行中', '状态显示「进行中」');

    await click('.dshp-btn-primary');
    ok(text('.dshp-status') === '已暂停', '暂停后显示「已暂停」');
    ok(text('.dshp-btn-primary') === '继续', '暂停后按钮为「继续」');
    ok(chips().every(function (c) { return c.disabled; }), '暂停中仍然禁用阶段按钮');

    await click('.dshp-btn-ghost');
    ok(text('.dshp-time') === '25:00', '重置回到 25:00');
    ok(chips().every(function (c) { return !c.disabled; }), '重置后阶段按钮恢复可点');

    chips()[1].click();
    await settle();
    ok(text('.dshp-time') === '05:00', '手动切到短休息，实为 ' + text('.dshp-time'));

    chips()[0].click();
    await settle();
    ok(text('.dshp-time') === '25:00', '手动切回专注');

    /* --- 问题②：跳过也要走长休息节律 --- */
    var before = store.get().completed;
    var ghosts = document.querySelectorAll('.dshp-btn-ghost');
    ghosts[1].click();
    await settle();
    ok(store.get().completed === before + 1, '「跳过」专注计入完成数');
    ok(
      store.get().phase === ((before + 1) % 4 === 0 ? 'long' : 'short'),
      '「跳过」按长休息节律选下一阶段，实为 ' + store.get().phase
    );

    var reachedLong = false;
    for (var i = 0; i < 4; i += 1) {
      store.choosePhase('focus');
      store.skip();
      if (store.get().phase === 'long') reachedLong = true;
    }
    ok(reachedLong, '连续跳过 4 个专注必定出现长休息');

    store.choosePhase('focus');
    store.reset();
    await settle();
    ok(/第 \\d+\\/4 个番茄/.test(text('.dshp-sub')), '副标题显示节律进度：' + text('.dshp-sub'));

    /* --- 收起 / 展开 --- */
    var icons = document.querySelectorAll('.dshp-icon-btn');
    icons[icons.length - 1].click();
    await settle();
    ok(!!document.querySelector('.dshp-pill'), '收起后出现胶囊');
    ok(!document.querySelector('.dshp-card'), '收起后卡片消失');

    var pill = document.querySelector('.dshp-pill');
    pill.click();
    await settle();
    ok(!!document.querySelector('.dshp-card'), '点胶囊重新展开');

    /* --- 持久化 --- */
    var saved = window.localStorage.getItem('pomodoro-electron/state/v1');
    var parsed = null;
    try { parsed = JSON.parse(saved); } catch (e) { parsed = null; }
    ok(parsed !== null, 'localStorage 写入了状态');
    ok(parsed && parsed.status === 'idle', '持久化的状态为 idle');

    document.getElementById('result').textContent = results.join('\\n');
    document.title = errors.length === 0 && results.every(function (r) { return r.indexOf('PASS') === 0; })
      ? 'DOM-TEST-OK'
      : 'DOM-TEST-FAIL';
    var box = document.getElementById('errors');
    if (box) box.textContent = errors.join(' | ');
  })().catch(function (error) {
    /* 异步测试链里抛的异常不会被 window.onerror 抓到，得自己兜住 */
    results.push('FAIL|测试脚本抛异常：' + (error && error.message ? error.message : String(error)));
    document.getElementById('result').textContent = results.join('\\n');
    document.title = 'DOM-TEST-FAIL';
  });
})();
`;

const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>dom-test</title>',
  '<style>',
  DSH_TOKENS_CSS,
  'html,body{margin:0;background:#fff;}',
  '</style></head><body>',
  '<div id="host"></div>',
  '<pre id="result">pending</pre>',
  '<div id="errors"></div>',
  '<script>',
  react,
  '</script><script>',
  reactDom,
  '</script><script>',
  HARNESS.replace('/*__PLUGIN__*/', () => pluginSource),
  '</script></body></html>',
].join('\n');

await mkdir(WORK, { recursive: true });
const page = join(WORK, 'dom-test.html');
await writeFile(page, html, 'utf8');

const profile = join(WORK, 'profile');
rmSync(profile, { recursive: true, force: true });

const dom = await new Promise((resolve) => {
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--virtual-time-budget=15000',
      '--user-data-dir=' + profile,
      '--dump-dom',
      pathToFileURL(page).href,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.on('exit', () => resolve(out));
});

rmSync(profile, { recursive: true, force: true });

const unescapeHtml = (value) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const match = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
if (!match) {
  console.error('DOM 测试失败：页面没有产出结果（可能脚本崩了）');
  process.exit(1);
}

const lines = unescapeHtml(match[1]).split('\n').filter(Boolean);

// 页面没跑到测试就挂了（结果仍是 pending、或某行没有分隔符）——先把原始信息打出来，别让人猜
if (lines.length === 0 || lines.some((line) => !line.includes('|'))) {
  const errBox = dom.match(/<div id="errors">([\s\S]*?)<\/div>/);
  console.error('DOM 测试没有产出有效结果，页面可能提前崩了。');
  console.error('  result 原始内容：' + JSON.stringify(unescapeHtml(match[1])).slice(0, 400));
  if (errBox && unescapeHtml(errBox[1]).trim()) {
    console.error('  页面错误：' + unescapeHtml(errBox[1]).trim());
  }
  process.exit(1);
}

let failures = 0;
for (const line of lines) {
  const [status, label] = line.split('|');
  const pass = status === 'PASS';
  if (!pass) failures += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}`);
}

const errMatch = dom.match(/<div id="errors">([\s\S]*?)<\/div>/);
const pageErrors = errMatch ? unescapeHtml(errMatch[1]).trim() : '';
if (pageErrors) {
  console.log(`\n页面运行时错误：${pageErrors}`);
  failures += 1;
}

console.log('');
if (failures > 0) {
  console.error(`DOM 测试未通过：${failures} 项`);
  process.exit(1);
}
console.log(`DOM 测试全部通过（${lines.length} 项，真实浏览器）。`);
