#!/usr/bin/env node
/**
 * 构建前的前置检查：图标资源必须存在，否则 electron-builder 会静默用默认图标，
 * 或者干脆打包失败——这类问题早点报出来比打完包才发现好。
 *
 *   node scripts/check-assets.mjs
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const REQUIRED = [
  ['assets/icon.ico', '应用图标（Windows 打包用）'],
  ['assets/tray.png', '托盘图标'],
];

let failed = 0;
for (const [relative, description] of REQUIRED) {
  const absolute = join(ROOT, relative);
  const ok = existsSync(absolute) && statSync(absolute).size > 0;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${relative} — ${description}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.error('\n图标缺失。先跑：npm run icons（需要 Python + Pillow）');
  process.exit(1);
}
console.log('图标资源就绪。');
