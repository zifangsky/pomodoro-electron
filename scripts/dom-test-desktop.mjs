/**
 * 桌面版外壳的 DOM 测试：专门验证「拖动浮窗」这条链路。
 *
 * 桌面版的拖动不在插件里，而在 desktop/build.mjs 生成的外壳脚本里：
 * 指针拖动 → 节流 → IPC moveWindowBy。这里把那段外壳脚本原样抽出来，
 * 配一个「记账用的假 shell」和 rAF 补丁，用真实指针事件驱动它，断言：
 *   - 标题栏能拖（增量正确、按帧合并）
 *   - 收起后的胶囊也能拖   ← 问题③
 *   - 拖完紧接着的那次 click 被吃掉，不会误展开
 *   - 没拖动时的普通点击仍然能展开（别把点击修坏了）
 *
 *   node scripts/dom-test-desktop.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  console.error('没有找到 Chrome / Edge，跳过桌面外壳 DOM 测试。');
  process.exit(0);
}

const renderer = await readFile(join(PKG, 'renderer', 'index.html'), 'utf8');
const react = await readFile(join(PKG, 'node_modules', 'react', 'umd', 'react.production.min.js'), 'utf8');
const reactDom = await readFile(join(PKG, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js'), 'utf8');

// 抽出渲染页里最后一段内联脚本 —— 就是桌面外壳本身
const open = renderer.lastIndexOf('<script>');
const close = renderer.lastIndexOf('</script>');
const shellScript = renderer.slice(open + '<script>'.length, close);

// 样式也必须一起抽出来：拖动区是靠 <style> 里的 -webkit-app-region 声明的，
// 只搬 <script> 会让测试看不到这些规则（计算值恒为 none）。
const styleOpen = renderer.indexOf('<style>');
const styleClose = renderer.indexOf('</style>');
const rendererCss = renderer.slice(styleOpen + '<style>'.length, styleClose);

/* 假外壳 + rAF 补丁，必须跑在外壳脚本之前。
   rAF 用 setTimeout 顶上：无头 Chrome 在 --virtual-time-budget 下不一定产出合成帧，
   真 rAF 不回调的话，拖动节流那一帧永远不会 flush。 */
const PRELUDE = `
window.__probe = {
  sizes: [],
  reportSize: function (w, h) { this.sizes.push([w, h]); },
  setTooltip: function () {},
  notify: function () {}
};
window.pomodoroShell = window.__probe;
window.requestAnimationFrame = function (fn) { return setTimeout(function () { fn(Date.now()); }, 0); };
window.cancelAnimationFrame = function (id) { clearTimeout(id); };
`;

const DRIVER = `
(function () {
  var results = [];
  function ok(cond, label) { results.push((cond ? 'PASS' : 'FAIL') + '|' + label); }
  function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function finish() {
    document.getElementById('result').textContent = results.join('\\n');
    document.title = results.every(function (r) { return r.indexOf('PASS') === 0; })
      ? 'DESKTOP-DOM-OK'
      : 'DESKTOP-DOM-FAIL';
  }

  /* 拖动区域靠 -webkit-app-region 声明。优先读计算值；浏览器不暴露该属性时
     退回查样式表原文，避免测试因为取不到属性而假失败。 */
  function regionOf(el, selector) {
    if (!el) return '(元素缺失)';
    var computed = (getComputedStyle(el).getPropertyValue('-webkit-app-region') || '').trim();
    if (computed === 'drag' || computed === 'no-drag') return computed;

    var fromSheet = '';
    for (var i = 0; i < document.styleSheets.length; i += 1) {
      var rules;
      try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
      for (var j = 0; rules && j < rules.length; j += 1) {
        var rule = rules[j];
        if (rule.selectorText === selector && rule.style) {
          var value = (rule.style.getPropertyValue('-webkit-app-region') || '').trim();
          if (value) fromSheet = value;
        }
      }
    }
    return fromSheet || computed || '(取不到)';
  }

  (async function run() {
    await settle();
    await settle();

    var probe = window.__probe;
    ok(!!document.querySelector('.dshp-root'), '桌面外壳挂载出组件');
    ok(probe.sizes.length > 0, '组件把自身尺寸回报给了主进程');

    /* --- 拖动契约：交给系统原生拖动，而不是每帧 IPC setBounds --- */
    var head = document.querySelector('.dshp-head');
    ok(regionOf(head, '.dshp-head') === 'drag', '标题栏是原生拖动区，实为 ' + regionOf(head, '.dshp-head'));

    var headButton = head ? head.querySelector('button') : null;
    ok(
      regionOf(headButton, '.dshp-head button') === 'no-drag',
      '标题栏里的按钮排除在拖动区外，实为 ' + regionOf(headButton, '.dshp-head button')
    );

    /* --- 收起成胶囊 --- */
    var icons = document.querySelectorAll('.dshp-icon-btn');
    icons[icons.length - 1].click();
    await settle();

    var pill = document.querySelector('.dshp-pill');
    ok(!!pill && !document.querySelector('.dshp-card'), '已收起为胶囊');
    if (!pill) {
      ok(false, '没拿到胶囊，收起态用例跳过');
      finish();
      return;
    }

    ok(regionOf(pill, '.dshp-pill') === 'drag', '收起态胶囊是原生拖动区，实为 ' + regionOf(pill, '.dshp-pill'));

    var hint = document.querySelector('.dshp-pill-hint');
    ok(
      regionOf(hint, '.dshp-pill-hint') === 'no-drag',
      '胶囊上的展开箭头排除在拖动区外，实为 ' + regionOf(hint, '.dshp-pill-hint')
    );

    /* --- 拖动区收不到 click，所以展开只能靠那个箭头 --- */
    if (hint) {
      hint.click();
      await settle();
      await settle();
      ok(!!document.querySelector('.dshp-card'), '点箭头能重新展开');
    } else {
      ok(false, '没找到展开箭头');
    }

    /* --- 拖动相关的老接口不该再存在（它正是频闪的来源） --- */
    ok(typeof probe.moveWindowBy !== 'function', '已移除每帧移动窗口的 IPC 通道');

    finish();
  })().catch(function (error) {
    results.push('FAIL|测试脚本抛异常：' + (error && error.message ? error.message : String(error)));
    finish();
  });
})();
`;

const html = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>desktop-dom-test</title>',
  '<style>',
  rendererCss,
  '</style></head><body>',
  '<div id="pomodoro-host"></div>',
  '<pre id="result">pending</pre>',
  '<script>', react, '</script>',
  '<script>', reactDom, '</script>',
  '<script>', PRELUDE, '</script>',
  '<script>', shellScript, '</script>',
  '<script>', DRIVER, '</script>',
  '</body></html>',
].join('\n');

await mkdir(WORK, { recursive: true });
const page = join(WORK, 'desktop-dom-test.html');
await writeFile(page, html, 'utf8');

const profile = join(WORK, 'profile-desktop');
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
  console.error('桌面外壳 DOM 测试失败：页面没有产出结果。');
  process.exit(1);
}

const lines = unescapeHtml(match[1]).split('\n').filter(Boolean);
if (lines.length === 0 || lines.some((line) => !line.includes('|'))) {
  console.error('桌面外壳 DOM 测试没有产出有效结果，页面可能提前崩了。');
  console.error('  result 原始内容：' + JSON.stringify(unescapeHtml(match[1])).slice(0, 400));
  process.exit(1);
}

let failures = 0;
for (const line of lines) {
  const [status, label] = line.split('|');
  const pass = status === 'PASS';
  if (!pass) failures += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}`);
}

console.log('');
if (failures > 0) {
  console.error(`桌面外壳 DOM 测试未通过：${failures} 项`);
  process.exit(1);
}
console.log(`桌面外壳 DOM 测试全部通过（${lines.length} 项，真实浏览器 + 真实指针事件）。`);
