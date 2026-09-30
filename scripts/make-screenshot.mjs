#!/usr/bin/env node
/**
 * 生成 README 用的截图 docs/screenshot.png。
 *
 *   node scripts/make-screenshot.mjs
 *
 * 为什么不能直接 `--window-size=280,320 --screenshot`：
 * 无头 Chrome 的 --window-size 与真实布局视口并不总是一致，而组件是锚定在
 * 视口右下角的（right:13px / bottom:13px），结果就是截出来只露一半。
 * 所以这里按 Chrome 的默认视口 800x600 截全屏，再用 Pillow 裁到组件区域。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PAGE = join(ROOT, 'renderer', 'index.html');
const RAW = join(ROOT, 'docs', '_raw.png');
const OUT = join(ROOT, 'docs', 'screenshot.png');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
];

const PYTHONS = [
  'python',
  'C:/Users/A69721/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
];

const browser = BROWSERS.find((candidate) => existsSync(candidate));
if (!browser) {
  console.error('没有找到 Chrome / Edge，无法截图。');
  process.exit(1);
}
if (!existsSync(PAGE)) {
  console.error('还没有 renderer/index.html，先跑：npm run renderer');
  process.exit(1);
}

mkdirSync(join(ROOT, 'docs'), { recursive: true });
rmSync(RAW, { force: true });

spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--virtual-time-budget=4000',
    '--default-background-color=FFFFFFFF',
    '--user-data-dir=' + join(ROOT, '.dom-test', 'screenshot-profile'),
    '--window-size=800,600',
    '--screenshot=' + RAW,
    'file:///' + PAGE.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore' },
);

if (!existsSync(RAW)) {
  console.error('截图失败：Chrome 没有产出文件。');
  process.exit(1);
}

// 组件锚定在右下角，裁掉左上角的大片空白
const script = [
  'import sys',
  'from PIL import Image',
  'raw, out = sys.argv[1], sys.argv[2]',
  'image = Image.open(raw).convert("RGB")',
  'width, height = image.size',
  'box = (max(0, width - 300), max(0, height - 350), width, height)',
  'image.crop(box).save(out)',
  'print("cropped", image.size, "->", box)',
].join('\n');

let cropped = false;
for (const python of PYTHONS) {
  const result = spawnSync(python, ['-c', script, RAW, OUT], { encoding: 'utf8' });
  if (result.status === 0) {
    process.stdout.write((result.stdout || '').trim() + '\n');
    cropped = true;
    break;
  }
}

if (!cropped) {
  process.stdout.write('Pillow 不可用，保留未裁剪的原图。\n');
  spawnSync('cmd.exe', ['/c', 'copy', RAW, OUT], { stdio: 'ignore' });
}

rmSync(RAW, { force: true });
rmSync(join(ROOT, '.dom-test', 'screenshot-profile'), { recursive: true, force: true });
console.log('截图已生成：' + OUT);
