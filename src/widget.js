/**
 * 番茄钟组件 —— 唯一真源。
 *
 * 这里写的是 CommonJS 风格的「工厂体」：没有 import / export，只有一个 require('react')。
 * build.mjs 会把它连同 React UMD 一起内联进 renderer/index.html，
 * 所以整个应用不需要打包器。
 *
 * 对外导出：name / apply(ctx) / Pomodoro / store
 *   - apply(ctx) 需要一个最小 ctx：{ effect, slots: { inject, register } }
 *   - store 是计时引擎句柄，外壳用它做托盘提示与系统通知
 */

'use strict';

const React = require('react');
const h = React.createElement;

const PLUGIN_ID = 'pomodoro-electron';
const STORE_KEY = 'pomodoro-electron/state/v1';
const SLOT = 'shell.overlay';
const TICK_MS = 200;

/* ------------------------------------------------------------------ 文案 */

const LANG = (() => {
  try {
    const raw = String(navigator.language || navigator.userLanguage || 'zh').toLowerCase();
    if (raw.indexOf('zh') === 0) return 'zh';
    if (raw.indexOf('en') === 0) return 'en';
    return 'zh';
  } catch {
    return 'zh';
  }
})();

const STRINGS = {
  zh: {
    appName: '番茄钟',
    focus: '专注',
    short: '短休息',
    long: '长休息',
    start: '开始',
    pause: '暂停',
    resume: '继续',
    reset: '重置',
    skip: '跳过',
    switchLocked: '计时中不可切换，先点「重置」回到未启动',
    expand: '展开番茄钟',
    collapse: '收起番茄钟',
    settings: '设置',
    minutes: '分钟',
    autoStart: '自动开始下一段',
    sound: '结束提示音',
    longEvery: '长休息间隔',
    everyUnit: '个番茄',
    roundOf: '第 {n}/{total} 个番茄',
    doneN: '已完成 {n} 个',
    running: '进行中',
    idle: '已暂停',
    ready: '准备开始',
    toastFocus: '专注结束，休息一下',
    toastBreak: '休息结束，继续专注',
    toastLong: '一轮完成，长休息一下',
  },
  en: {
    appName: 'Pomodoro',
    focus: 'Focus',
    short: 'Short break',
    long: 'Long break',
    start: 'Start',
    pause: 'Pause',
    resume: 'Resume',
    reset: 'Reset',
    skip: 'Skip',
    switchLocked: 'Reset first — switching is locked while the timer is active',
    expand: 'Expand pomodoro',
    collapse: 'Collapse pomodoro',
    settings: 'Settings',
    minutes: 'min',
    autoStart: 'Auto-start next',
    sound: 'Chime',
    longEvery: 'Long break every',
    everyUnit: 'sessions',
    roundOf: 'Session {n}/{total}',
    doneN: '{n} done',
    running: 'Running',
    idle: 'Paused',
    ready: 'Ready',
    toastFocus: 'Focus done — take a break',
    toastBreak: 'Break over — back to focus',
    toastLong: 'Round complete — long break',
  },
};

function t(key, vars) {
  const table = STRINGS[LANG] || STRINGS.zh;
  let text = table[key] != null ? table[key] : STRINGS.zh[key] != null ? STRINGS.zh[key] : key;
  if (vars) {
    for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
  }
  return text;
}

/* ------------------------------------------------------------------ 常量 */

const PHASES = ['focus', 'short', 'long'];

const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, autoStart: true, sound: true };

const LIMITS = {
  focus: [1, 180],
  short: [1, 60],
  long: [1, 120],
  every: [1, 12],
};

/** 每个阶段一个强调色，全部走主题 token，跟随浅色/深色自动切换。 */
const ACCENTS = {
  focus: 'var(--dsw-alias-brand-primary, #4c8dff)',
  short: 'var(--dsw-alias-state-success-primary, #22c55e)',
  long: 'var(--dsw-alias-state-warn-primary, #f5a524)',
};

/* ------------------------------------------------------------------ 工具 */

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0 ? hours + ':' + pad(mins) + ':' + pad(secs) : pad(mins) + ':' + pad(secs);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readPersisted() {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------- 计时引擎 */

function createStore() {
  const saved = readPersisted();
  const rawSettings = saved.settings && typeof saved.settings === 'object' ? saved.settings : {};

  const settings = {
    focus: clampInt(rawSettings.focus, LIMITS.focus[0], LIMITS.focus[1], DEFAULTS.focus),
    short: clampInt(rawSettings.short, LIMITS.short[0], LIMITS.short[1], DEFAULTS.short),
    long: clampInt(rawSettings.long, LIMITS.long[0], LIMITS.long[1], DEFAULTS.long),
    every: clampInt(rawSettings.every, LIMITS.every[0], LIMITS.every[1], DEFAULTS.every),
    autoStart: rawSettings.autoStart !== false,
    sound: rawSettings.sound !== false,
  };

  const listeners = new Set();
  const rawPos = saved.pos && typeof saved.pos === 'object' ? saved.pos : {};

  let state = {
    phase: PHASES.indexOf(saved.phase) >= 0 ? saved.phase : 'focus',
    // idle = 未启动（只有这个状态允许手动切阶段）｜paused = 已暂停｜running = 计时中
    status: 'idle',
    remaining: 0,
    total: 0,
    completed: clampInt(saved.completed, 0, 9999, 0),
    open: saved.open !== false,
    showSettings: false,
    pos: { dx: Number(rawPos.dx) || 0, dy: Number(rawPos.dy) || 0 },
    toast: null,
    pulse: 0,
  };

  let deadline = 0;
  let timer = null;
  let toastTimer = null;

  const durationMs = (phase) => settings[phase] * 60000;
  state.total = durationMs(state.phase);
  state.remaining = state.total;

  // 刷新/热重载后接着跑：存的是绝对 deadline，而不是剩余量。
  if (saved.status === 'running' && Number.isFinite(saved.deadline)) {
    const left = saved.deadline - Date.now();
    if (left > 1000) {
      deadline = saved.deadline;
      state.status = 'running';
      state.remaining = left;
    }
  } else if (saved.status === 'paused') {
    const left = Number(saved.remaining);
    if (Number.isFinite(left) && left > 0 && left <= state.total) {
      state.status = 'paused';
      state.remaining = left;
    }
  }

  function persist() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          phase: state.phase,
          status: state.status,
          completed: state.completed,
          open: state.open,
          pos: state.pos,
          settings,
          remaining: state.status === 'idle' ? null : state.remaining,
          deadline: state.status === 'running' ? deadline : null,
        }),
      );
    } catch {
      /* localStorage 不可用时静默降级为纯内存状态 */
    }
  }

  function notify() {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        /* 单个订阅者出错不影响其他人 */
      }
    }
  }

  function set(patch, options) {
    state = Object.assign({}, state, patch);
    if (!options || options.persist !== false) persist();
    notify();
  }

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function toast(text) {
    if (toastTimer !== null) clearTimeout(toastTimer);
    set({ toast: text }, { persist: false });
    toastTimer = setTimeout(() => {
      toastTimer = null;
      set({ toast: null }, { persist: false });
    }, 7000);
  }

  function playChime() {
    if (!settings.sound) return;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      if (!audio) audio = new Ctor();
      if (audio.state === 'suspended') audio.resume();
      const now = audio.currentTime;
      const notes = [880, 1174.66, 1567.98];
      notes.forEach((freq, i) => {
        const at = now + i * 0.16;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
        osc.connect(gain);
        gain.connect(audio.destination);
        osc.start(at);
        osc.stop(at + 0.55);
      });
    } catch {
      /* 没有音频权限就安静地跳过 */
    }
  }

  let audio = null;

  function run() {
    clearTimer();
    timer = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        complete();
        return;
      }
      set({ remaining: left }, { persist: false });
    }, TICK_MS);
  }

  function nextPhaseAfter(phase, completed) {
    if (phase !== 'focus') return 'focus';
    return completed % settings.every === 0 ? 'long' : 'short';
  }

  function complete() {
    clearTimer();
    const finished = state.phase;
    const completed = finished === 'focus' ? state.completed + 1 : state.completed;
    const next = nextPhaseAfter(finished, completed);
    playChime();
    toast(finished === 'focus' ? (next === 'long' ? t('toastLong') : t('toastFocus')) : t('toastBreak'));
    deadline = settings.autoStart ? Date.now() + durationMs(next) : 0;
    set({
      phase: next,
      completed,
      total: durationMs(next),
      remaining: durationMs(next),
      status: settings.autoStart ? 'running' : 'idle',
      pulse: state.pulse + 1,
    });
    if (settings.autoStart) run();
  }

  function start() {
    if (state.status === 'running') return;
    const base = state.remaining > 0 ? state.remaining : durationMs(state.phase);
    deadline = Date.now() + base;
    set({ status: 'running', remaining: base, toast: null, total: durationMs(state.phase) });
    run();
  }

  function pause() {
    if (state.status !== 'running') return;
    clearTimer();
    const left = Math.max(0, deadline - Date.now());
    set({ status: 'paused', remaining: left > 0 ? left : durationMs(state.phase) });
  }

  function toggle() {
    if (state.status === 'running') pause();
    else start();
  }

  function reset() {
    clearTimer();
    set({ status: 'idle', remaining: durationMs(state.phase), total: durationMs(state.phase), toast: null });
  }

  /**
   * 跳过 = 立刻结束本阶段，并按「长休息节律」进入下一阶段。
   * 专注被跳过同样计入完成数 —— 否则一路点跳过永远到不了长休息
   * （这是之前的一个真 bug：skip 写死了 focus→short 且不计数）。
   */
  function skip() {
    clearTimer();
    const finished = state.phase;
    const completed = finished === 'focus' ? state.completed + 1 : state.completed;
    const next = nextPhaseAfter(finished, completed);
    set({
      phase: next,
      completed,
      status: 'idle',
      total: durationMs(next),
      remaining: durationMs(next),
      toast: null,
    });
  }

  /** 手动切阶段只允许在「未启动」状态下进行；计时中/暂停中一律忽略。 */
  function choosePhase(phase) {
    if (PHASES.indexOf(phase) < 0) return;
    if (state.status !== 'idle') return;
    clearTimer();
    set({ phase, status: 'idle', total: durationMs(phase), remaining: durationMs(phase), toast: null });
  }

  function setDuration(key, value) {
    if (!Object.prototype.hasOwnProperty.call(LIMITS, key)) return null;
    const limits = LIMITS[key];
    const next = clampInt(value, limits[0], limits[1], settings[key]);
    settings[key] = next;
    if (key === state.phase || key === 'every') {
      // 未启动：跟着新的总时长走；暂停中：只在超出新总时长时收紧；计时中：不动剩余量
      const total = durationMs(state.phase);
      const remaining = state.status === 'idle' ? total : Math.min(state.remaining, total);
      state = Object.assign({}, state, { total, remaining });
    }
    persist();
    notify();
    return next;
  }

  function toggleSetting(key) {
    if (key !== 'autoStart' && key !== 'sound') return;
    settings[key] = !settings[key];
    persist();
    notify();
  }

  function setOpen(open) {
    set({ open: !!open });
  }

  function toggleSettings() {
    set({ showSettings: !state.showSettings }, { persist: false });
  }

  function setPos(dx, dy) {
    set({ pos: { dx, dy } }, { persist: false });
  }

  return {
    get: () => state,
    settings: () => settings,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    pause,
    toggle,
    reset,
    skip,
    choosePhase,
    setDuration,
    toggleSetting,
    setOpen,
    toggleSettings,
    setPos,
    persistPos: persist,
    dispose() {
      clearTimer();
      if (toastTimer !== null) clearTimeout(toastTimer);
      listeners.clear();
    },
  };
}

const store = createStore();

/* ------------------------------------------------------------------ 组件 */

function useStore() {
  const [snapshot, setSnapshot] = React.useState(store.get());
  React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), []);
  return snapshot;
}

function Ring(props) {
  const { size, stroke, ratio } = props;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return h(
    'svg',
    {
      className: 'dshp-ring',
      width: size,
      height: size,
      viewBox: '0 0 ' + size + ' ' + size,
      'aria-hidden': 'true',
    },
    h('circle', {
      cx: size / 2,
      cy: size / 2,
      r,
      fill: 'none',
      stroke: 'var(--dsw-alias-border-l3, rgba(0,0,0,.12))',
      strokeWidth: stroke,
    }),
    h('circle', {
      className: 'dshp-ring-fill',
      cx: size / 2,
      cy: size / 2,
      r,
      fill: 'none',
      stroke: 'var(--dshp-accent)',
      strokeWidth: stroke,
      strokeLinecap: 'round',
      strokeDasharray: String(circumference),
      strokeDashoffset: String(circumference * (1 - ratio)),
      transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
    }),
  );
}

function IconSliders() {
  return h(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
    },
    h('line', { key: 'l1', x1: 4, y1: 8, x2: 20, y2: 8 }),
    h('circle', { key: 'c1', cx: 9, cy: 8, r: 2.6, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
    h('line', { key: 'l2', x1: 4, y1: 16, x2: 20, y2: 16 }),
    h('circle', { key: 'c2', cx: 15, cy: 16, r: 2.6, fill: 'var(--dsw-alias-bg-layer-1, #fff)' }),
  );
}

function IconChevron(props) {
  return h(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      style: { transform: props.up ? 'rotate(180deg)' : 'none' },
    },
    h('polyline', { points: '6 9 12 15 18 9' }),
  );
}

function Switch(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': props.value ? 'true' : 'false',
      'aria-label': props.label,
      title: props.label,
      className: 'dshp-switch' + (props.value ? ' is-on' : ''),
      onClick: props.onToggle,
    },
    h('span', { className: 'dshp-knob' }),
  );
}

function DurationInput(props) {
  return h('input', {
    className: 'dshp-num',
    type: 'number',
    inputMode: 'numeric',
    min: props.min,
    max: props.max,
    defaultValue: String(props.value),
    'aria-label': props.label,
    onKeyDown: (event) => {
      if (event.key === 'Enter') event.currentTarget.blur();
    },
    onBlur: (event) => {
      const applied = props.onCommit(event.currentTarget.value);
      if (applied !== null && applied !== undefined) event.currentTarget.value = String(applied);
    },
  });
}

function Pomodoro() {
  const state = useStore();
  const settings = store.settings();
  const rootRef = React.useRef(null);
  const movedRef = React.useRef(false);

  const onDragStart = React.useCallback(
    (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const node = rootRef.current;
      if (!node) return;

      // 拖拽要绑在「本组件所在文档」的 window 上，而不是全局 window：
      // 组件可能被搬进另一个文档（例如独立版的 Document Picture-in-Picture 悬浮窗），
      // 那时全局 window 收不到那个文档里的事件。ownerDocument.defaultView 在两种场景下都对。
      const view = (node.ownerDocument && node.ownerDocument.defaultView) || window;

      const rect = node.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startDx = store.get().pos.dx;
      const startDy = store.get().pos.dy;
      const { width, height } = rect;
      let dragging = false;

      const onMove = (moveEvent) => {
        const moved = Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
        if (!dragging && moved < 4) return;
        dragging = true;
        movedRef.current = true;

        const viewportW = view.innerWidth || 0;
        const viewportH = view.innerHeight || 0;
        let dx = startDx + (moveEvent.clientX - startX);
        let dy = startDy + (moveEvent.clientY - startY);

        // 右下角锚点：right = 18 - dx，bottom = 18 - dy，保证 8px 内边距始终留在视口内
        dx = Math.min(10, Math.max(18 - (viewportW - 8 - width), dx));
        dy = Math.min(10, Math.max(18 - (viewportH - 8 - height), dy));

        store.setPos(dx, dy);
        if (moveEvent.cancelable) moveEvent.preventDefault();
      };

      const onEnd = () => {
        view.removeEventListener('pointermove', onMove);
        view.removeEventListener('pointerup', onEnd);
        view.removeEventListener('pointercancel', onEnd);
        if (dragging) store.persistPos();
        view.setTimeout(() => {
          movedRef.current = false;
        }, 0);
      };

      view.addEventListener('pointermove', onMove);
      view.addEventListener('pointerup', onEnd);
      view.addEventListener('pointercancel', onEnd);
    },
    [],
  );

  const phase = state.phase;
  const accent = ACCENTS[phase];
  const total = state.total > 0 ? state.total : 1;
  const remaining = Math.max(0, state.remaining);
  const ratio = Math.max(0, Math.min(1, remaining / total));
  const timeText = formatTime(remaining);
  const running = state.status === 'running';

  const rootStyle = {
    right: 18 - state.pos.dx + 'px',
    bottom: 18 - state.pos.dy + 'px',
    '--dshp-accent': accent,
  };

  if (!state.open) {
    return h(
      'div',
      { className: 'dshp-root', style: rootStyle, ref: rootRef },
      h(
        'button',
        {
          type: 'button',
          className: 'dshp-pill' + (running ? ' is-running' : ''),
          title: t('expand'),
          'aria-label': t('appName') + ' · ' + timeText,
          onPointerDown: onDragStart,
          onClick: () => {
            if (movedRef.current) return;
            store.setOpen(true);
          },
        },
        h('span', { className: 'dshp-pill-dot' }),
        h('span', { className: 'dshp-pill-time' }, timeText),
        h('span', { className: 'dshp-pill-hint' }, h(IconChevron, { up: true })),
        h(
          'span',
          { className: 'dshp-pill-bar' },
          h('span', { className: 'dshp-pill-bar-fill', style: { width: ratio * 100 + '%' } }),
        ),
      ),
    );
  }

  // 显示的是「本轮内第几个」，不是累计数：完成 10 个、每 4 个长休时，
  // 当前应该是第 3/4 个，而不是「第 11/4 个」。
  const subText =
    phase === 'focus'
      ? t('roundOf', { n: (state.completed % settings.every) + 1, total: settings.every })
      : t('doneN', { n: state.completed });

  // 只有「未启动」才显示准备开始；暂停中要明确说是暂停，别和没开始混为一谈
  const statusText =
    state.status === 'running' ? t('running') : state.status === 'paused' ? t('idle') : t('ready');

  const dial = h(
    'div',
    { className: 'dshp-dial', key: 'dial-' + state.pulse },
    h(Ring, { size: 116, stroke: 7, ratio }),
    h(
      'div',
      { className: 'dshp-dial-text' },
      h('span', { className: 'dshp-time' }, timeText),
      h('span', { className: 'dshp-sub' }, subText),
    ),
    h('span', { className: 'dshp-status' }, statusText),
  );

  const actions = h(
    'div',
    { className: 'dshp-actions' },
    h(
      'button',
      { type: 'button', className: 'dshp-btn dshp-btn-primary', onClick: () => store.toggle() },
      running ? t('pause') : state.status === 'paused' ? t('resume') : t('start'),
    ),
    h('button', { type: 'button', className: 'dshp-btn dshp-btn-ghost', onClick: () => store.reset() }, t('reset')),
    h('button', { type: 'button', className: 'dshp-btn dshp-btn-ghost', onClick: () => store.skip() }, t('skip')),
  );

  // 手动切阶段只在未启动时可用：计时中/暂停中禁用，避免绕过「跳过 / 重置」这两个正规出口
  const canChoose = state.status === 'idle';

  const phases = h(
    'div',
    { className: 'dshp-phases', role: 'tablist' },
    PHASES.map((key) =>
      h(
        'button',
        {
          key,
          type: 'button',
          role: 'tab',
          disabled: !canChoose,
          'aria-selected': key === phase ? 'true' : 'false',
          'aria-disabled': canChoose ? 'false' : 'true',
          title: canChoose ? undefined : t('switchLocked'),
          className: 'dshp-chip' + (key === phase ? ' is-active' : '') + (canChoose ? '' : ' is-locked'),
          onClick: () => store.choosePhase(key),
        },
        t(key),
      ),
    ),
  );

  const more = state.showSettings
    ? h(
        'div',
        { className: 'dshp-more' },
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('focus')),
          h(DurationInput, {
            value: settings.focus,
            min: LIMITS.focus[0],
            max: LIMITS.focus[1],
            label: t('focus'),
            onCommit: (value) => store.setDuration('focus', value),
          }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('short')),
          h(DurationInput, {
            value: settings.short,
            min: LIMITS.short[0],
            max: LIMITS.short[1],
            label: t('short'),
            onCommit: (value) => store.setDuration('short', value),
          }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('long')),
          h(DurationInput, {
            value: settings.long,
            min: LIMITS.long[0],
            max: LIMITS.long[1],
            label: t('long'),
            onCommit: (value) => store.setDuration('long', value),
          }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('longEvery')),
          h(DurationInput, {
            value: settings.every,
            min: LIMITS.every[0],
            max: LIMITS.every[1],
            label: t('longEvery'),
            onCommit: (value) => store.setDuration('every', value),
          }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('autoStart')),
          h(Switch, {
            value: settings.autoStart,
            label: t('autoStart'),
            onToggle: () => store.toggleSetting('autoStart'),
          }),
        ),
        h(
          'div',
          { className: 'dshp-row' },
          h('span', null, t('sound')),
          h(Switch, {
            value: settings.sound,
            label: t('sound'),
            onToggle: () => store.toggleSetting('sound'),
          }),
        ),
      )
    : null;

  return h(
    'div',
    { className: 'dshp-root', style: rootStyle, ref: rootRef },
    h(
      'div',
      { className: 'dshp-card' + (running ? ' is-running' : '') },
      h(
        'div',
        { className: 'dshp-head', onPointerDown: onDragStart },
        h('span', { className: 'dshp-title' }, t('appName')),
        h(
          'button',
          {
            type: 'button',
            className: 'dshp-icon-btn' + (state.showSettings ? ' is-active' : ''),
            title: t('settings'),
            'aria-label': t('settings'),
            'aria-pressed': state.showSettings ? 'true' : 'false',
            onClick: () => store.toggleSettings(),
          },
          h(IconSliders, null),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshp-icon-btn',
            title: t('collapse'),
            'aria-label': t('collapse'),
            onClick: () => store.setOpen(false),
          },
          h(IconChevron, { up: false }),
        ),
      ),
      dial,
      actions,
      phases,
      state.toast ? h('div', { className: 'dshp-toast' }, state.toast) : null,
      more,
    ),
  );
}

/* ------------------------------------------------------------------ 样式 */

const CSS = `
.dshp-root{
  position:fixed; z-index:80; pointer-events:auto;
  font-family:"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  font-size:13px; line-height:1.45; color:var(--dsw-alias-label-primary);
  -webkit-font-smoothing:antialiased;
  user-select:none; -webkit-user-select:none;
}
.dshp-root *{box-sizing:border-box;}

/* ---------- 收起态胶囊 ---------- */
.dshp-pill{
  position:relative; display:flex; align-items:center; gap:8px;
  height:34px; padding:0 11px 0 12px; overflow:hidden;
  border:1px solid var(--dsw-alias-border-l1); border-radius:999px;
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  box-shadow:0 6px 20px rgba(0,0,0,.16), 0 1px 2px rgba(0,0,0,.08);
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  cursor:pointer; font:inherit; touch-action:none;
  transition:transform .16s ease, box-shadow .16s ease, border-color .16s ease;
}
.dshp-pill:hover{transform:translateY(-1px); box-shadow:0 10px 26px rgba(0,0,0,.2);}
.dshp-pill:active{transform:translateY(0) scale(.985);}
.dshp-pill:focus-visible,.dshp-btn:focus-visible,.dshp-chip:focus-visible,
.dshp-icon-btn:focus-visible,.dshp-switch:focus-visible,.dshp-num:focus-visible{
  outline:2px solid var(--dsw-alias-state-business-primary, #4176e6); outline-offset:2px;
}
.dshp-pill-dot{
  width:8px; height:8px; border-radius:50%; flex:none;
  background:var(--dshp-accent);
}
.dshp-pill.is-running .dshp-pill-dot{animation:dshp-blink 1.8s ease-in-out infinite;}
.dshp-pill-time{
  font-weight:600; font-variant-numeric:tabular-nums;
  letter-spacing:.02em; min-width:46px; text-align:left;
}
.dshp-pill-hint{color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1;}
.dshp-pill-bar{
  position:absolute; left:12px; right:12px; bottom:4px; height:2px;
  border-radius:2px; background:var(--dsw-alias-border-l3, rgba(0,0,0,.12)); overflow:hidden;
}
.dshp-pill-bar-fill{
  display:block; height:100%; border-radius:2px;
  background:var(--dshp-accent);
  transition:width .25s linear;
}

/* ---------- 展开态卡片 ---------- */
.dshp-card{
  width:238px; padding:12px; display:flex; flex-direction:column; gap:10px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:16px;
  background:var(--dsw-alias-bg-overlay);
  box-shadow:0 18px 44px rgba(0,0,0,.24), 0 2px 6px rgba(0,0,0,.1);
  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
  animation:dshp-rise .18s ease;
}
.dshp-head{
  display:flex; align-items:center; gap:4px;
  margin:-4px -4px 0; padding:4px; border-radius:8px;
  cursor:grab; touch-action:none;
}
.dshp-head:active{cursor:grabbing;}
.dshp-title{
  flex:1; min-width:0;
  font-size:12px; font-weight:600; letter-spacing:.04em;
  color:var(--dsw-alias-label-secondary);
  display:flex; align-items:center; gap:6px;
}
.dshp-title::before{
  content:""; width:6px; height:6px; border-radius:50%;
  background:var(--dshp-accent); flex:none;
}
.dshp-icon-btn{
  width:22px; height:22px; flex:none; padding:0; display:grid; place-items:center;
  border:0; border-radius:6px; background:transparent;
  color:var(--dsw-alias-label-secondary); cursor:pointer;
  transition:background .14s ease, color .14s ease;
}
.dshp-icon-btn:hover,.dshp-icon-btn.is-active{
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
}

.dshp-dial{position:relative; display:grid; place-items:center; margin:2px 0;}
.dshp-dial-text{
  position:absolute; display:flex; flex-direction:column; align-items:center; gap:3px;
}
.dshp-time{
  font-size:29px; font-weight:600; line-height:1;
  font-variant-numeric:tabular-nums; letter-spacing:-.01em;
}
.dshp-sub{font-size:11px; color:var(--dsw-alias-label-secondary);}
.dshp-status{
  position:absolute; bottom:-4px; padding:1px 7px; border-radius:999px;
  font-size:10px; letter-spacing:.04em;
  color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);
}
.dshp-ring-fill{transition:stroke-dashoffset .25s linear, stroke .3s ease;}
.dshp-card.is-running .dshp-dial{animation:none;}

.dshp-actions{display:flex; gap:6px; margin-top:6px;}
.dshp-btn{
  flex:1; height:32px; padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:9px;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  font:inherit; font-weight:500; cursor:pointer;
  transition:background .14s ease, border-color .14s ease, transform .1s ease;
}
.dshp-btn:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-btn:active{transform:scale(.98);}
.dshp-btn-ghost{flex:0 0 auto; padding:0 11px; color:var(--dsw-alias-label-secondary);}
.dshp-btn-ghost:hover{color:var(--dsw-alias-label-primary);}
.dshp-btn-primary{
  flex:1.5; font-weight:600; border-color:transparent;
  background:var(--dsw-alias-brand-primary, #0f1115);
  color:var(--dsw-alias-label-primary-foreground, #fff);
}
.dshp-btn-primary:hover{background:var(--dsw-alias-button-primary-hover, #43454a);}

.dshp-phases{
  display:flex; gap:2px; padding:3px; border-radius:10px;
  background:var(--dsw-alias-bg-layer-2);
}
.dshp-chip{
  flex:1; height:26px; padding:0 4px; border:0; border-radius:7px;
  background:transparent; color:var(--dsw-alias-label-secondary);
  font:inherit; font-size:12px; cursor:pointer; white-space:nowrap;
  transition:background .14s ease, color .14s ease;
}
.dshp-chip:hover{color:var(--dsw-alias-label-primary);}
.dshp-chip.is-active{
  background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary);
  font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,.12);
}
/* 计时中/暂停中：锁住手动切阶段。当前阶段仍保持高亮，只是不可点。 */
.dshp-chip:disabled{cursor:not-allowed; opacity:.45;}
.dshp-chip:disabled:hover{color:var(--dsw-alias-label-secondary);}
.dshp-chip.is-locked.is-active{opacity:.75;}

.dshp-toast{
  padding:7px 9px; border-radius:9px; font-size:12px;
  background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary);
  border-left:3px solid var(--dshp-accent);
  animation:dshp-rise .2s ease;
}

.dshp-more{
  display:flex; flex-direction:column; gap:7px;
  padding-top:9px; border-top:1px solid var(--dsw-alias-border-l1);
}
.dshp-row{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  font-size:12px; color:var(--dsw-alias-label-secondary);
}
.dshp-num{
  width:54px; height:26px; padding:0 6px;
  border:1px solid var(--dsw-alias-border-l1); border-radius:7px;
  background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
  font:inherit; font-variant-numeric:tabular-nums; text-align:center;
}
.dshp-num:focus{outline:none; border-color:var(--dshp-accent);}

/* 开关完全照 DSH 官方 Switch 的取色：轨道用 border-l3 / brand-primary，
   圆钮用 switch-thumb / label-primary-foreground —— 深色模式下 brand 是近白色，
   自己硬编码白钮就会糊成一片。 */
.dshp-switch{
  position:relative; width:34px; height:19px; flex:none; padding:0;
  border:0; border-radius:999px;
  background:var(--dsw-alias-border-l3, rgba(0,0,0,.12));
  cursor:pointer; transition:background .16s ease;
}
.dshp-switch.is-on{background:var(--dsw-alias-brand-primary, #0f1115);}
.dshp-knob{
  position:absolute; top:2px; left:2px; width:15px; height:15px;
  border-radius:50%;
  background:var(--dsw-alias-switch-thumb, #fff);
  box-shadow:0 1px 2px rgba(0,0,0,.24);
  transition:transform .16s cubic-bezier(.4,0,.2,1), background .16s ease;
}
.dshp-switch.is-on .dshp-knob{
  background:var(--dsw-alias-label-primary-foreground, #fff);
  transform:translateX(15px);
}

@keyframes dshp-blink{0%,100%{opacity:1;}50%{opacity:.3;}}
@keyframes dshp-rise{from{opacity:0; transform:translateY(4px);} to{opacity:1; transform:none;}}
@media (prefers-reduced-motion:reduce){
  .dshp-root *{animation:none !important; transition:none !important;}
}
`;

/* ------------------------------------------------------------------ 装配 */

function apply(ctx) {
  try {
    ctx.effect(() => {
      const tag = document.createElement('style');
      tag.setAttribute('data-plugin', PLUGIN_ID);
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag);
      };
    }, PLUGIN_ID + ':styles');
  } catch (error) {
    console.error('[' + PLUGIN_ID + '] 注入样式失败', error);
  }

  try {
    ctx.slots.inject(SLOT, () =>
      ctx.slots.register(
        {
          name: SLOT,
          id: PLUGIN_ID,
          order: 60,
          inject: () => ({}),
        },
        Pomodoro,
      ),
    );
  } catch (error) {
    console.error('[' + PLUGIN_ID + '] 注册 shell.overlay 失败', error);
  }

  try {
    ctx.effect(() => () => store.dispose(), PLUGIN_ID + ':timer');
  } catch (error) {
    console.error('[' + PLUGIN_ID + '] 注册清理失败', error);
  }
}

exports.name = PLUGIN_ID;
exports.inject = ['slots'];
exports.apply = apply;
exports.Pomodoro = Pomodoro;
// 给「非 DSH 外壳」（独立版 / Electron 桌面版）用的状态句柄：
// 它们靠它把剩余时间送到托盘提示、并在阶段结束时发系统通知。
exports.store = store;
