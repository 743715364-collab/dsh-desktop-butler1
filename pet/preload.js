'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopButler', {
  ignore: (flag) => ipcRenderer.send('pet:ignore', Boolean(flag)),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragMove: () => ipcRenderer.send('pet:drag-move'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  menu: () => ipcRenderer.send('pet:menu'),
  openSettings: () => ipcRenderer.send('pet:open-settings'),
  bubble: (open) => ipcRenderer.send('pet:bubble', Boolean(open)),
  say: () => ipcRenderer.send('pet:say'),
  /** 点击桌宠时把随机台词交给主进程合成语音。 */
  sayText: (text) => ipcRenderer.send('pet:say-text', String(text || '')),
  resize: (width) => ipcRenderer.send('pet:resize', width),
  quit: () => ipcRenderer.send('pet:quit'),
  getWidth: () => ipcRenderer.invoke('pet:get-width'),
  onWidth: (cb) => ipcRenderer.on('pet:width', (_e, width) => cb(width)),
  onBubble: (cb) => ipcRenderer.on('pet:bubble', (_e, text) => cb(text)),
  /** gold | blue：主进程或测试入口切换主题。 */
  setTheme: (theme) => ipcRenderer.send('pet:set-theme', ['blue', 'cinematic', 'live-gold', 'live-blue'].includes(theme) ? theme : 'gold'),
  /** gold | blue | cinematic | live-gold | live-blue：右键菜单切换主题时由主进程推送。 */
  onTheme: (cb) => ipcRenderer.on('pet:theme', (_e, theme) => cb(['blue', 'cinematic', 'live-gold', 'live-blue'].includes(theme) ? theme : 'gold')),

  // ---- voice ----
  /** Ask the main process to transcribe + answer. `wav` is an ArrayBuffer. */
  voiceAsk: (wav) => ipcRenderer.invoke('voice:ask', wav),
  /** Which knobs the renderer needs (VAD thresholds, TTS mode, persona name). */
  voiceConfig: () => ipcRenderer.invoke('voice:config'),
  /** Hotkey / menu asked for a recording; `on` is the desired state. */
  onVoiceToggle: (cb) => ipcRenderer.on('voice:toggle', () => cb()),
  /** Main wants to say something without going through the mic. */
  onVoiceSay: (cb) => ipcRenderer.on('voice:say', (_e, text) => cb(text)),
  /** Same, but main already synthesized Edge audio: { text, audio, mime }. */
  onVoiceSayAudio: (cb) => ipcRenderer.on('voice:say-audio', (_e, payload) => cb(payload)),
  /** A tool is about to run; `label` is a ready-to-show line. */
  onVoiceTool: (cb) => ipcRenderer.on('voice:tool', (_e, label) => cb(label)),
  /** 闲聊模式开关变了（菜单 / 配置页），静态待机台词要让位。 */
  onChitchatState: (cb) => ipcRenderer.on('chitchat:state', (_e, on) => cb(Boolean(on))),
  /** DSH 工作状态变化：{ state, task } 或 null（空闲）。 */
  onWorkStatus: (cb) => ipcRenderer.on('work:status', (_e, status) => cb(status)),
  /** Report the pipeline state so the tray tooltip / menu can follow along. */
  voiceState: (state) => ipcRenderer.send('pet:voice-state', state),
  /** 语音常开开关持久化到 desktop-butler-state.json。 */
  setAlwaysListen: (on) => ipcRenderer.send('pet:always-listen', Boolean(on)),
  /** 右键菜单切「语音常开」：main 发来期望状态。 */
  onContinuous: (cb) => ipcRenderer.on('voice:continuous', (_e, on) => cb(Boolean(on))),
});
