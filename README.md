# 番茄钟 · Pomodoro Electron

一个 Windows 桌面番茄钟浮窗：**无边框、透明、始终置顶**，带托盘图标与系统通知。

基于 Electron 44，界面由 React 18 渲染。渲染页不是常规前端工程构建出来的 —— 而是由
`build.mjs` 把组件源码与一份 React UMD **直接内联成一个自包含 HTML**，因此没有打包器，
产物容易审查。

![番茄钟浮窗](docs/screenshot.png)

[English](README.en.md) · [MIT License](LICENSE)

---

## 功能

### 计时

- **专注 / 短休息 / 长休息** 三段循环，默认 25 / 5 / 15 分钟，均可调整
- **长休息间隔**可调（默认每完成 4 个番茄进入一次长休息）
- 开始 / 暂停 / 继续 / 重置 / 跳过
- **自动开始下一段**可关闭；关掉后每段结束会停在「未启动」状态等你手动开始
- 阶段结束时三音提示，用 WebAudio 现场合成，**不依赖任何音频文件**
- 同时弹一条 Windows 系统通知（静音，避免和提示音重复）

### 交互规则

- **计时中 / 暂停中，最下面一排阶段按钮是禁用的** —— 避免绕过正规出口直接跳阶段
- 换阶段只有两条正规路径：
  - **跳过** —— 结束当前阶段，按长休息节律进入下一阶段；专注被跳过**同样计入完成数**
  - **重置** —— 回到未启动状态，**此时**才能手动切阶段
- 副标题 `第 n/N 个番茄` 显示本轮进度，一眼看出还差几个进长休息

### 窗口

- 无边框 + 透明 + 始终置顶，**不占任务栏**
- 拖动标题栏移动窗口，位置与尺寸会被记住
- 点右上角 ⌄ 收起成小胶囊；**窗口会跟着缩到胶囊大小**，不会留下一块看不见却挡点击的透明区域
- 收起后**胶囊本身也是拖动区**，可直接拖动窗口
- 收起状态点胶囊右侧 **⌃ 箭头**展开（系统拖动区收不到点击，所以箭头是唯一热区）
- 拖出屏幕会自动拉回工作区，始终保留一部分可见，随时能抓回来

### 托盘

| 菜单项 | 作用 |
| --- | --- |
| 显示 / 隐藏浮窗 | 左键单击托盘图标同效 |
| 始终置顶 | 关掉即变成普通窗口 |
| 开机自启 | 写入当前用户启动项 |
| 退出 | 真正退出（关窗口不会退出，托盘常驻） |

托盘悬浮提示实时显示 `番茄钟 · 专注 24:31` 这样的进度。

### 健壮性

- 刷新/重启后**正在跑的计时接着走**（持久化的是绝对时间戳，不是剩余量）
- 内联脚本有语法错误时**构建期直接失败**，不会把白屏包发出去
- 关闭时自动清理注入的样式与定时器

---

## 系统架构

### 进程模型

```
┌──────────────────── 主进程 main.js ─────────────────────┐
│ BrowserWindow（frameless / transparent / alwaysOnTop）   │
│ Tray + Menu（显示隐藏 / 置顶 / 自启 / 退出）               │
│ ipcMain：widget-size · tray-tooltip · notify             │
│ window-state.json：位置尺寸持久化（防抖写入）              │
└───────────────┬──────────────────────────────────────────┘
                │ contextBridge（只暴露 3 个窄接口）
┌───────────────▼────────── preload.js ────────────────────┐
│ window.pomodoroShell.{ reportSize, setTooltip, notify }  │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──── renderer/index.html（构建产物）──────┐
│ React 18 UMD（内联）                                      │
│ + 组件源码 src/widget.js（内联）                           │
│ + 设计 token src/tokens.mjs（内联成 CSS 变量）             │
│ ─ 装配：最小 ctx（slots / effect）→ 挂载组件               │
│ ─ ResizeObserver 量组件尺寸 → reportSize                  │
│ ─ 订阅 store → 托盘提示 / 阶段结束系统通知                  │
└───────────────────────────────────────────────────────────┘
```

### 关键设计决策

**渲染页为什么是「构建」出来的，而不是常规前端工程**
组件源码 `src/widget.js` 写成 CommonJS 风格的「工厂体」，`build.mjs` 把它连同一份 React UMD
内联进一个 HTML。好处：不需要打包器，没有额外工具链，产物是自包含文件，容易审查。
代价：内联脚本的语法错误只会在运行时暴露 —— 所以构建期会用 `new Function` 把内联脚本解析一遍兜底。

**拖动为什么用 `-webkit-app-region` 而不是自己算坐标**
早期实现是「指针增量 → IPC → 主进程 `setBounds()` 移动窗口」。在 Windows 上**高频移动
`transparent: true` 的分层窗口会不停触发整窗重绘，表现为疯狂频闪**。改成系统原生拖动后
彻底没有这个问题，也不需要每帧 IPC。代价是拖动区收不到 `click`，所以胶囊的「展开」
只能挂在 `no-drag` 的子元素（⌃ 箭头）上。

**窗口尺寸为什么跟着组件走**
窗口按组件实测尺寸 + 26px 留白设置，并按**右下角锚定**。这样收起成胶囊时窗口一起缩小，
不会留下一块看不见却挡点击的透明区域。

**渲染页为什么要写一个 ready 文件**
「进程活着、窗口也『在』、但页面根本没画出来」这种白屏故障，用进程存活判断不出来。
`renderer-ready.json` 是「React 树真的挂载并测量了自己」的信号，端到端测试靠它判定。

**状态机为什么是三态而不是两态**
`idle`（未启动）/ `paused`（已暂停）/ `running`（计时中）。早期只有 `idle`/`running`，
暂停被归到 `idle`，导致界面无法区分「暂停中」和「没开始」，阶段按钮也就没法按状态禁用。

---

## 使用的组件

| 组件 | 版本 | 用途 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 44.x | 桌面运行时（Chromium + Node） |
| [React](https://react.dev/) / ReactDOM | 18.3.1（UMD） | 组件渲染，构建期内联进 HTML |
| [electron-builder](https://www.electron.build/) | 25.x | 打包免安装目录版 |
| [Pillow](https://python-pillow.org/) | 较新版本即可 | 生成 `icon.ico` / `tray.png`（仅 `npm run icons` 需要） |
| 无头 Chrome / Edge | 较新版本即可 | 自动化 DOM 测试（仅测试需要） |

**运行时没有任何第三方 npm 依赖** —— 只用 Electron 自带的能力。

---

## 目录结构

```
Pomodoro-Electron/
├─ package.json            # 依赖、脚本、electron-builder 配置
├─ main.js                 # 主进程：窗口、托盘、IPC、窗口状态持久化
├─ preload.js              # contextBridge，只暴露 3 个窄接口
├─ build.mjs               # 生成 renderer/index.html（内联 React + 组件 + token）
├─ make-icons.py           # 用 Pillow 画 icon.ico / icon.png / tray.png
├─ LICENSE                 # MIT
├─ src/
│  ├─ widget.js            # 组件唯一真源：计时引擎 + 浮窗 UI + 样式
│  └─ tokens.mjs           # 设计 token：浅色 / 深色两套 CSS 变量
├─ scripts/
│  ├─ verify-all.mjs       # 一条命令跑完构建 + 全部测试 + 打包 + 启动实测
│  ├─ dom-test.mjs         # 真实浏览器测试：组件本体（26 项）
│  └─ dom-test-desktop.mjs # 真实浏览器测试：桌面外壳拖动契约（9 项）
├─ assets/                 # 应用与托盘图标（make-icons.py 生成，已入库）
├─ renderer/               # 构建产物 index.html（已 gitignore）
└─ dist/                   # 打包产物 win-unpacked/Pomodoro.exe（已 gitignore）
```

---

## 构建与打包

### 环境要求

- **Node.js ≥ 20**（开发时用 24）
- **Windows 10 / 11 x64**
- 可选：Python + Pillow（只在重新生成图标时需要）
- 可选：Chrome / Edge（只在跑 DOM 测试时需要）

### 命令

```bash
npm install        # 安装 Electron 44 与打包工具
npm run icons      # 可选：重新生成图标
npm start          # 构建渲染页并直接运行（开发调试）
npm run dist            # 打包成免安装目录 → dist/win-unpacked/Pomodoro.exe
npm run dist:portable   # 打包成单文件     → dist/Pomodoro-1.0.0-portable.exe
```

两种产物都能直接双击运行：

| 产物 | 形态 | 启动 | 说明 |
| --- | --- | --- | --- |
| `dist/win-unpacked/Pomodoro.exe` | 一个文件夹 | 快 | 日常用；整个文件夹可拷贝到别的纯英文目录 |
| `dist/Pomodoro-1.0.0-portable.exe` | **单个 exe，约 98 MB** | 首次慢几秒 | 每次启动把运行时自解压到 `%TEMP%`，适合随身带走 |

国内网络建议先设镜像，否则 Electron 二进制（约 158 MB）从 GitHub 直连会很慢：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

### 测试

```bash
npm test                                    # 两个真实浏览器 DOM 测试
npm run verify                              # 构建 + 全部测试
npm run smoke                               # 上面全部 + 打包 + 真的把 exe 跑起来验证
node scripts/verify-all.mjs --deploy D:\Tools\Pomodoro   # 打包并复制到指定目录
```

`--smoke-app` 会启动打包好的 exe，等渲染页回报「已挂载」，然后关掉它 —— 这是
白屏类故障唯一可靠的自动化信号。

---

## 使用方式

1. 双击 `dist/win-unpacked/Pomodoro.exe`（或用 `--deploy` 复制过去的目录）
2. 浮窗出现在屏幕**右下角**，始终浮在最上层
3. **拖动标题栏**移动窗口；点右上角 **⌄** 收起成胶囊
4. 收起后点右侧 **⌃ 箭头**展开；拖动胶囊本身可直接移动窗口
5. **右键托盘图标**：显示/隐藏、始终置顶、开机自启、退出

> 关掉窗口**不会**退出应用（托盘常驻）。要真正退出请用托盘菜单的「退出」。

---

## 已知限制

- **必须放在纯英文路径下运行**，单文件版还要求 `%TEMP%` 也是纯英文路径（它要自解压到那里）。
  Chromium 的沙箱在可执行文件路径含非 ASCII 字符时会初始化失败，进程以
  `STATUS_BREAKPOINT (0x80000003)` **静默退出** —— 表现就是「双击了，什么都没发生」。
  这是 Chromium 的限制，应用层绕不过去。
- 打包产物**未做代码签名**。Windows SmartScreen 首次运行可能提示「未知发布者」，
  点「更多信息 → 仍要运行」即可。
- 单文件 `portable` 版每次启动都要把约 200 MB 的运行时自解压到 `%TEMP%`，首次启动比目录版慢几秒，
  退出后由 NSIS 清理临时目录。
- 收起状态下**点胶囊主体不会展开**（那块是系统拖动区，拿不到点击事件），必须点 ⌃ 箭头。
- 只针对 **Windows x64** 验证；代码本身跨平台，但托盘与打包配置只调过 Windows。
- 计时按系统时间推进；窗口始终可见，因此没有浏览器后台标签页那种节流问题。

---

## 许可

[MIT](LICENSE)

打包产物内含 Electron / Chromium，遵循各自的开源许可（见 `LICENSE.electron.txt`）。
React / ReactDOM 为 MIT，版权归 Meta Platforms, Inc. 及其关联公司。
