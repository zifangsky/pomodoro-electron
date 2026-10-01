'use strict';

/**
 * Electron 主进程。
 *
 * 窗口就是组件本身：无边框、透明、始终置顶、不占任务栏。
 * 渲染侧用 ResizeObserver 量出组件的实际尺寸回报过来，主进程按
 * **右下角锚定**去改窗口大小，于是收起成胶囊时窗口跟着缩小，
 * 不会留下一块看不见却挡点击的透明区域。
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, Notification, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const ASSETS = path.join(__dirname, 'assets');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const LOG_FILE = path.join(app.getPath('userData'), 'app.log');
const APP_ID = 'com.pomodoro.electron';
/** 置顶在 Windows 上会被后激活的置顶窗口挤下去，所以要定期重新申明 */
const TOPMOST_INTERVAL_MS = 2500;

let win = null;
let tray = null;
let alwaysOnTop = true;
let state = {};
let rendererReady = false;

/* ---------------------------------------------------------------- 日志 */

/**
 * 追加一行启动日志。
 * 「双击了没反应」这类故障如果没有日志就只能靠猜 —— 尤其是「第二个实例到底有没有
 * 走到主进程」这种问题，只有日志能给出答案。文件超过 256 KB 就重开。
 */
function logLine(message) {
  try {
    try {
      if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.rmSync(LOG_FILE, { force: true });
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  pid=${process.pid}  ${message}\n`);
  } catch {
    /* 写不进去不影响使用 */
  }
}

/* ------------------------------------------------------------ 窗口状态 */

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  state = Object.assign({}, state, {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    alwaysOnTop,
  });
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* 写不进去就算了，不影响使用 */
  }
}

let stateWriteTimer = null;

/**
 * 原生拖动结束后把窗口拉回工作区内，至少留 60px 横向 / 40px 纵向可见，
 * 免得拖到屏幕外再也抓不回来。放在防抖里做，拖动过程中不去和系统抢位置。
 */
function clampIntoWorkArea() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = workAreaAt(bounds.x, bounds.y);
  const x = Math.min(Math.max(bounds.x, area.x - bounds.width + 60), area.x + area.width - 60);
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - 40);
  if (x !== bounds.x || y !== bounds.y) {
    win.setBounds({ x, y, width: bounds.width, height: bounds.height });
  }
}

/** 拖动窗口时 'moved' 每帧都会触发，落盘必须防抖，否则状态文件会被疯狂重写。 */
function scheduleWriteState() {
  if (stateWriteTimer !== null) clearTimeout(stateWriteTimer);
  stateWriteTimer = setTimeout(() => {
    stateWriteTimer = null;
    clampIntoWorkArea();
    writeState();
  }, 400);
}

function flushWriteState() {
  if (stateWriteTimer !== null) {
    clearTimeout(stateWriteTimer);
    stateWriteTimer = null;
  }
}

function workAreaAt(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x, y }).workArea;
  } catch {
    return screen.getPrimaryDisplay().workArea;
  }
}

/* ---------------------------------------------------------------- 窗口 */

function createWindow() {
  state = readState();
  alwaysOnTop = state.alwaysOnTop !== false;

  const width = Number.isFinite(state.width) ? state.width : 300;
  const height = Number.isFinite(state.height) ? state.height : 340;
  const area = screen.getPrimaryDisplay().workArea;
  const x = Number.isFinite(state.x) ? state.x : area.x + area.width - width - 16;
  const y = Number.isFinite(state.y) ? state.y : area.y + area.height - height - 16;

  win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: '番茄钟',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(alwaysOnTop, 'floating');
  win.setMenuBarVisibility(false);
  win.loadFile(RENDERER);
  win.once('ready-to-show', () => {
    logLine('ready-to-show：窗口已绘制，显示浮窗');
    // 上次退出后如果屏幕配置变了（换显示器、改分辨率），保存的位置可能已经在屏幕外
    clampIntoWorkArea();
    win.showInactive();
  });

  win.on('moved', scheduleWriteState);
  win.on('close', () => {
    flushWriteState();
    writeState();
  });
  win.on('closed', () => {
    win = null;
  });

  // 这个窗口只加载本地页面，任何外跳都拒掉
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

/** 组件尺寸变化：右下角保持不动，并夹在工作区内。 */
function applyWidgetSize(size) {
  if (!win || win.isDestroyed()) return;
  const width = Math.max(96, Math.round(Number(size && size.width) || 0));
  const height = Math.max(40, Math.round(Number(size && size.height) || 0));
  if (width <= 0 || height <= 0) return;

  const bounds = win.getBounds();
  if (bounds.width === width && bounds.height === height) return;

  const area = workAreaAt(bounds.x, bounds.y);
  const x = Math.min(Math.max(bounds.x + (bounds.width - width), area.x), area.x + area.width - width);
  const y = Math.min(Math.max(bounds.y + (bounds.height - height), area.y), area.y + area.height - height);

  win.setBounds({ x, y, width, height });
  state = Object.assign({}, state, { x, y, width, height });
}

function toggleVisible() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    enforceTopmost();
  }
}

/* ------------------------------------------------------------ 置顶守护 */

let topmostTimer = null;

/**
 * 重新申明一次置顶。
 *
 * 只在创建时调一次 setAlwaysOnTop 是不够的 —— 这是 Windows 上一个很反直觉的机制：
 * 「置顶」不是一种属性，而是一个**组**。组内谁在前面由**激活顺序**决定，而本窗口是
 * showInactive 显示的、从不激活，于是任何之后被激活的置顶窗口都会盖到它上面：
 * 任务栏、资源管理器、以及各种国产软件的悬浮窗（实测这台机器上就有一个腾讯系的
 * GetCorbicula 窗口常年置顶）。
 *
 * 实测数据：窗口本身 exStyle=0x00000008（WS_EX_TOPMOST）没问题，但它上面压着
 * 两个 explorer 进程的置顶窗口和一个腾讯系置顶窗口。
 *
 * 所以必须定期重新申明，并用 moveTop() 把它拎回组内最前。
 */
function enforceTopmost() {
  if (!win || win.isDestroyed() || !alwaysOnTop || !win.isVisible()) return;
  win.setAlwaysOnTop(true, 'floating');
  if (typeof win.moveTop === 'function') win.moveTop();
}

function restartTopmostWatch() {
  if (topmostTimer !== null) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }
  if (alwaysOnTop) {
    topmostTimer = setInterval(enforceTopmost, TOPMOST_INTERVAL_MS);
    logLine(`置顶守护已开启：每 ${TOPMOST_INTERVAL_MS}ms 重新申明一次`);
  } else {
    logLine('置顶守护已关闭（用户关掉了「始终置顶」）');
  }
}

/* ---------------------------------------------------------------- 托盘 */

function rebuildTray() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏浮窗', click: toggleVisible },
      { type: 'separator' },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: alwaysOnTop,
        click: (item) => {
          alwaysOnTop = item.checked;
          if (win && !win.isDestroyed()) win.setAlwaysOnTop(alwaysOnTop, 'floating');
          restartTopmostWatch();
          enforceTopmost();
          writeState();
          rebuildTray();
        },
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: login,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
          rebuildTray();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const file = path.join(ASSETS, 'tray.png');
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('番茄钟');
  tray.on('click', toggleVisible);
  rebuildTray();
}

/* ---------------------------------------------------------- 渲染侧通道 */

ipcMain.on('widget-size', (event, size) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;

  // 渲染页第一次量到自己，说明 React 树真的挂载成功、组件确实渲染出来了。
  // 这是「白屏」这类故障唯一可靠的自动化信号：进程活着、窗口也「在」，
  // 但页面根本没画出来时，只有这里能区分。
  if (!rendererReady) {
    rendererReady = true;
    try {
      fs.writeFileSync(
        path.join(app.getPath('userData'), 'renderer-ready.json'),
        JSON.stringify({ at: Date.now(), width: size && size.width, height: size && size.height }),
      );
    } catch {
      /* 写不进去不影响使用 */
    }
  }

  applyWidgetSize(size);
});

/**
 * 拖动浮窗走的是 CSS 的 `-webkit-app-region: drag`，由系统接管，
 * 这里不需要任何 IPC —— 之前那套「每帧 setBounds 移动窗口」会让
 * Windows 上的透明窗口疯狂频闪，已经拿掉了。
 */

ipcMain.on('tray-tooltip', (event, text) => {
  if (!tray || typeof text !== 'string') return;
  if (event.sender !== (win && win.webContents)) return;
  tray.setToolTip(text.slice(0, 120) || '番茄钟');
});

ipcMain.on('notify', (event, payload) => {
  if (!Notification.isSupported()) return;
  if (event.sender !== (win && win.webContents)) return;
  const body = typeof payload?.body === 'string' ? payload.body.slice(0, 200) : '';
  if (!body) return;
  try {
    const notification = new Notification({ title: '番茄钟', body, silent: true });
    notification.on('click', () => {
      if (win && !win.isDestroyed()) win.showInactive();
    });
    notification.show();
  } catch {
    /* 通知失败不影响计时 */
  }
});

/* ------------------------------------------------------------ 生命周期 */

app.setAppUserModelId(APP_ID);

logLine('主进程启动，尝试获取单实例锁');

if (!app.requestSingleInstanceLock()) {
  // 已经有实例在跑：**必须留下痕迹**，否则用户看到的就是「双击了没反应」
  logLine('未拿到单实例锁 —— 已有实例在运行，本进程退出');
  app.quit();
} else {
  logLine('拿到单实例锁');

  app.on('second-instance', () => {
    logLine('收到 second-instance：用户又启动了一次');
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    // 用户明确又双击了一次，就该让浮窗「明确地回应」：
    // 拉回工作区 → 显示 → 恢复置顶 → 聚焦 → 让渲染页展开并闪一下。
    // 只做「显示」是不够的：窗口本来就是可见的（可能只是个收起的小胶囊），
    // 那样用户看到的仍然是「什么都没发生」。
    clampIntoWorkArea();
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(alwaysOnTop, 'floating');
    win.focus();
    win.webContents
      .executeJavaScript('window.__pomodoroReveal ? window.__pomodoroReveal() : false')
      .then((revealed) => logLine('已唤醒已有窗口，渲染页回应=' + revealed))
      .catch((error) => logLine('唤醒渲染页失败：' + error.message));
  });

  app.whenReady().then(() => {
    logLine('app ready，创建窗口与托盘');
    createWindow();
    createTray();
    restartTopmostWatch();
  });

  app.on('before-quit', () => {
    logLine('before-quit：应用即将退出');
    if (topmostTimer !== null) clearInterval(topmostTimer);
  });

  // 托盘常驻：关掉窗口不退出应用
  app.on('window-all-closed', () => {});
}
