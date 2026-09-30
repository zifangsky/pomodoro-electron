'use strict';

/**
 * 主进程与渲染页之间唯一的通道。只暴露三个窄接口，
 * 不开 nodeIntegration，渲染页也拿不到 ipcRenderer 本体。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pomodoroShell', {
  /** 组件实际尺寸变了，请主进程按右下角锚定调整窗口。 */
  reportSize(width, height) {
    ipcRenderer.send('widget-size', { width, height });
  },
  /** 更新托盘悬浮提示。 */
  setTooltip(text) {
    ipcRenderer.send('tray-tooltip', text);
  },
  /** 弹一条系统通知。 */
  notify(body) {
    ipcRenderer.send('notify', { body });
  },
});
