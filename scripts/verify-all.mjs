#!/usr/bin/env node
/**
 * 一条命令跑完构建 + 全部测试（可选再加打包与启动实测）。
 *
 *   node scripts/verify-all.mjs                          构建 + 测试
 *   node scripts/verify-all.mjs --package                再加打包（dir 目录版）
 *   node scripts/verify-all.mjs --package --portable     打包成单文件 portable exe
 *   node scripts/verify-all.mjs --package --smoke-app    再真的把 exe 跑起来验证
 *   node scripts/verify-all.mjs --package --deploy D:\Tools\Pomodoro
 *
 * 任何一步失败都会继续跑完（好一次性看到全部问题），最后汇总并返回非零退出码。
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const UNPACKED = join(ROOT, 'dist', 'win-unpacked');
const EXE = join(UNPACKED, 'Pomodoro.exe');
const PORTABLE_EXE = join(ROOT, 'dist', 'Pomodoro-1.0.0-portable.exe');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const at = argv.indexOf(flag);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const steps = [];

function step(label, command, args, options = {}) {
  process.stdout.write(`\n──────── ${label} ────────\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  const ok = result.status === 0;
  steps.push({ label, ok });
  if (!ok) process.stdout.write(`  ↑ ${label} 失败（exit=${result.status}）\n`);
  return ok;
}

const node = process.execPath;
const nodeStep = (label, script, args = []) => step(label, node, [script, ...args], { cwd: ROOT });

/* ------------------------------------------------------------ 构建 + 测试 */

nodeStep('1. 检查图标资源', join(HERE, 'check-assets.mjs'));
nodeStep('2. 构建渲染页（renderer/index.html）', join(ROOT, 'build.mjs'));
nodeStep('3. 真实浏览器 DOM 测试（组件本体）', join(HERE, 'dom-test.mjs'));
nodeStep('4. 真实浏览器 DOM 测试（桌面外壳拖动契约）', join(HERE, 'dom-test-desktop.mjs'));

/* -------------------------------------------------------------- 打包部署 */

const builderEnv = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  // NSIS 打包时会在 TEMP 里建内存映射文件；系统默认的 D:\temp 上 makensis 偶发
  // "error creating mmap"，指向项目内一个干净的 ASCII 目录就稳定。
  TEMP: join(ROOT, 'dist', '.nsis-tmp'),
  TMP: join(ROOT, 'dist', '.nsis-tmp'),
};

if (has('--package')) {
  // NSIS 会在这个目录里 mkdtemp，必须先建出来
  mkdirSync(join(ROOT, 'dist', '.nsis-tmp'), { recursive: true });

  const target = has('--portable') ? 'portable' : 'dir';
  step(`5. 打包（electron-builder --win ${target}）`, 'cmd.exe',
    ['/c', 'node_modules\\.bin\\electron-builder.cmd', '--win', target],
    { cwd: ROOT, env: builderEnv });

  const deployTo = valueOf('--deploy', null);
  if (deployTo) {
    process.stdout.write(`\n──────── 6. 部署到 ${deployTo} ────────\n`);
    try {
      // 先杀掉在跑的实例：文件被占用时删除会直接 EPERM
      spawnSync('taskkill', ['/IM', 'Pomodoro.exe', '/F'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      rmSync(deployTo, { recursive: true, force: true });
      cpSync(UNPACKED, deployTo, { recursive: true });
      process.stdout.write(`  已复制 ${UNPACKED} → ${deployTo}\n`);
      steps.push({ label: `6. 部署到 ${deployTo}`, ok: true });
    } catch (error) {
      process.stdout.write(`  部署失败：${error.message}\n`);
      steps.push({ label: `6. 部署到 ${deployTo}`, ok: false });
    }
  }
}

/* -------------------------------------------------------- 启动实测（真跑） */

if (has('--smoke-app')) {
  process.stdout.write('\n──────── 7. 启动实测（真的把 exe 跑起来） ────────\n');

  // --portable 时优先测那个单文件产物（它要自解压，启动更慢）
  const preferPortable = has('--portable');
  const exe = preferPortable
    ? existsSync(PORTABLE_EXE)
      ? PORTABLE_EXE
      : null
    : existsSync(EXE)
      ? EXE
      : existsSync(PORTABLE_EXE)
        ? PORTABLE_EXE
        : null;
  const waitMs = preferPortable ? 45000 : 15000;

  if (!exe) {
    process.stdout.write('  找不到打包产物，跳过。\n');
    steps.push({ label: '7. 启动实测（无产物）', ok: false });
  } else {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const readyFile = join(appData, '番茄钟', 'renderer-ready.json');

    spawnSync('taskkill', ['/IM', 'Pomodoro.exe', '/F'], { stdio: 'ignore' });
    rmSync(readyFile, { force: true });

    // ELECTRON_RUN_AS_NODE 会让 Electron 以 Node 模式启动并立刻崩掉 —— 必须摘掉
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const logFile = join(ROOT, 'dist', 'startup.log');
    const logFd = openSync(logFile, 'a');
    const child = spawn(exe, [], {
      cwd: dirname(exe),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnv,
    });
    child.unref();
    closeSync(logFd);

    await new Promise((resolve) => setTimeout(resolve, waitMs));

    let payload = null;
    try {
      payload = JSON.parse(await readFile(readyFile, 'utf8'));
    } catch {
      payload = null;
    }

    const fresh = payload !== null && Date.now() - Number(payload.at) < 120000;
    if (fresh) {
      process.stdout.write(
        `  渲染页已挂载（宽 ${payload.width} × 高 ${payload.height}），窗口不是白屏\n`,
      );
    } else {
      process.stdout.write(`  没有收到渲染页的就绪回报：${readyFile}\n`);
      try {
        const log = (await readFile(logFile, 'utf8')).trim();
        if (log) process.stdout.write(`  主进程输出：\n${log.split('\n').slice(-12).join('\n')}\n`);
      } catch {
        process.stdout.write('  （主进程没有输出）\n');
      }
    }
    steps.push({ label: '7. 启动实测（渲染页挂载成功）', ok: fresh });

    spawnSync('taskkill', ['/IM', 'Pomodoro.exe', '/F'], { stdio: 'ignore' });
  }
}

/* ------------------------------------------------------------------ 汇总 */

process.stdout.write('\n════════════════ 汇总 ════════════════\n');
let failed = 0;
for (const entry of steps) {
  process.stdout.write(`${entry.ok ? '  通过 ' : '  失败 '} ${entry.label}\n`);
  if (!entry.ok) failed += 1;
}
process.stdout.write(`\n${steps.length - failed}/${steps.length} 步通过\n`);

process.exit(failed === 0 ? 0 : 1);
