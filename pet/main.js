/*
 * 桌面管家 — gold holographic desktop pet
 * A tiny, dependency-free Electron shell: transparent always-on-top window,
 * tray icon, native menu, drag-to-move and click-through outside the orb.
 */
'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  dialog,
  globalShortcut,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { load: loadConfig, setChitchat: writeChitchat } = require('./config');
const voice = require('./voice');
const dshVoice = require('./dsh-voice');
const tools = require('./tools');

const APP_ROOT = __dirname;
const BASE_W = 460;
const BASE_H = 423;
const SIZES = { small: 380, medium: 460, large: 580 };

// Keep every writable artifact inside the app folder so the pet also runs
// from a portable / sandboxed copy.
app.setPath('userData', path.join(APP_ROOT, 'data'));

let win = null;
let settingsWin = null;
let settingsHidePet = false;
let tray = null;
let ignoreMouse = true;
let drag = null;
let forcedQuit = false;
let bubbleOpen = false;
let menuOpen = false;
let pointerTimer = null;
let state = {
  width: BASE_W,
  height: BASE_H,
  x: null,
  y: null,
  alwaysOnTop: true,
  muted: false,
  /** 语音常开：渲染进程持续监听，静音分段后自动发一轮对话 */
  alwaysListen: false,
  /** gold | blue — 金色全息 / 冷蓝全息 */
  theme: 'gold',
};

const THEMES = new Set(['gold', 'blue', 'cinematic', 'live-gold', 'live-blue']);

const stateFile = () => path.join(app.getPath('userData'), 'desktop-butler-state.json');
const logFile = () => path.join(app.getPath('userData'), 'desktop-butler.log');
const workStatusFile = () => path.join(app.getPath('userData'), 'work-status.json');

/** Speech turns live in memory only; a restart is a fresh conversation. */
let chatHistory = [];
let config = { file: path.join(APP_ROOT, 'desktop-butler-config.json'), data: null };

// 闲聊模式的节流状态。开关本身在 desktop-butler-config.json 的 chitchat 段，这样
// DSH 设置页和右键菜单操作的是同一份配置。
let voicePhase = 'idle';
let lastInteractionAt = Date.now();
let chitchatTimer = null;
let chitchatBusy = false;
let chitchatHour = -1;
let chitchatHourCount = 0;
let chitchatTopicsUsed = [];

// DSH 工作状态：插件写 data/work-status.json，这里轮询，变化时推给渲染进程。
let workTimer = null;
let workKey = '';
let workSnapshot = null;

const reason = (err) => (err && err.message ? err.message : String(err));

/**
 * 语音识别常把游戏名返回成英文；工具层和日志统一用中文名。
 * 只替换完整游戏名，避免把普通的 "lol" 笑声也当成游戏。
 */
function normalizeHeard(text) {
  return String(text || '')
    .replace(/\bLeague\s+of\s+Legends?\b/gi, '英雄联盟')
    // 只在明确的开关命令里把 LOL 当游戏名，避免把笑声 "lol" 也替换掉。
    .replace(/(打开|开启|启动|关闭|关掉|退出|把)\s*LOL\b/gi, '$1英雄联盟');
}

/** DSH 语音桥地址：环境变量 > desktop-butler-config.json 的 bridge.baseUrl > 默认本机端口 */
const bridgeBase = () =>
  dshVoice.resolveBase(config.data && config.data.bridge ? config.data.bridge.baseUrl : '');

/** One-line append log; the app is windowless, so this is the only trace. */
function logWarn(text) {
  try {
    fs.appendFileSync(logFile(), new Date().toISOString() + ' ' + text + '\n', 'utf8');
  } catch {
    /* logging must never break the pet */
  }
}

function reloadConfig() {
  try {
    config = loadConfig(APP_ROOT);
    // 改完配置可能刚打开/关掉闲聊模式，计时器要跟着对齐。
    syncChitchat();
    return true;
  } catch (err) {
    logWarn('config: ' + reason(err));
    return false;
  }
}

// --------------------------------------------------- DSH 工作状态 (work) --

const WORK_STATES = new Set(['thinking', 'working', 'result', 'waiting', 'success', 'error']);
/** 插件 15s 一次心跳；45s 没新心跳就当插件已经不在了，回到空闲。 */
const WORK_STALE_MS = 45000;

/** 读插件写的状态文件；坏文件 / 过期 / 未知档位一律当空闲。 */
function readWorkStatus() {
  let raw;
  try {
    raw = fs.readFileSync(workStatusFile(), 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!data || !WORK_STATES.has(data.state)) return null;
  const ts = Number(data.ts) || 0;
  if (!ts || Date.now() - ts > WORK_STALE_MS) return null;
  return {
    state: data.state,
    task: typeof data.task === 'string' && data.task ? data.task.slice(0, 120) : null,
    ts,
  };
}

/** 把当前工作状态推给渲染进程；只有 state/task 真的变了才发（force 时补发但不重复记日志）。 */
function pushWorkStatus(force) {
  const next = readWorkStatus();
  const key = next ? next.state + '|' + (next.task || '') : 'idle';
  const changed = key !== workKey;
  if (!force && !changed) return;
  workKey = key;
  workSnapshot = next;
  if (changed) logWarn('work ' + (next ? next.state + (next.task ? ' · ' + next.task : '') : 'idle'));
  send('work:status', next);
}

function startWorkWatch() {
  stopWorkWatch();
  pushWorkStatus(true);
  workTimer = setInterval(() => pushWorkStatus(false), 600);
}

function stopWorkWatch() {
  if (workTimer) {
    clearInterval(workTimer);
    workTimer = null;
  }
}

/** Keep the prompt bounded: last N turns, oldest dropped first. */
function trimHistory() {
  const limit = Math.max(1, Number(config.data && config.data.voice.historyTurns) || 6) * 2;
  if (chatHistory.length > limit) chatHistory = chatHistory.slice(-limit);
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object') {
      for (const key of ['width', 'height', 'x', 'y']) {
        if (Number.isFinite(Number(raw[key]))) state[key] = Number(raw[key]);
      }
      state.alwaysOnTop = raw.alwaysOnTop !== false;
      state.muted = raw.muted === true;
      state.alwaysListen = raw.alwaysListen === true;
      state.theme = THEMES.has(raw.theme) ? raw.theme : 'gold';
    }
  } catch {
    /* first run */
  }
  if (!state.width) state.width = BASE_W;
  state.width = Math.min(SIZES.large, Math.max(SIZES.small, state.width || BASE_W));
  state.height = Math.round(state.width * 0.92);
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(
      stateFile(),
      JSON.stringify(
        {
          width: state.width,
          height: state.height,
          x: state.x,
          y: state.y,
          alwaysOnTop: state.alwaysOnTop,
          muted: state.muted,
          alwaysListen: state.alwaysListen,
          theme: state.theme,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* non-fatal */
  }
}

function applyTheme(theme) {
  const next = THEMES.has(theme) ? theme : 'gold';
  if (state.theme !== next) {
    state.theme = next;
    persist();
  }
  send('pet:theme', next);
}

function workAreaFor(x, y) {
  const displays = screen.getAllDisplays();
  const found = displays.find((d) => {
    const a = d.workArea;
    return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
  });
  return (found || screen.getPrimaryDisplay()).workArea;
}

function clampToScreen(x, y, w, h) {
  const a = workAreaFor(x + w / 2, y + h / 2);
  return {
    x: Math.max(a.x - 8, Math.min(x, a.x + a.width - w + 8)),
    y: Math.max(a.y - 8, Math.min(y, a.y + a.height - h + 8)),
  };
}

function defaultPosition(w, h) {
  const a = screen.getPrimaryDisplay().workArea;
  return { x: a.x + a.width - w - 18, y: a.y + a.height - h - 18 };
}

function setClickThrough(flag) {
  if (!win || win.isDestroyed()) return;
  if (ignoreMouse === flag) return;
  ignoreMouse = flag;
  win.setIgnoreMouseEvents(flag, { forward: true });
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function showBubble(text) {
  send('pet:bubble', text);
}

/**
 * 让桌宠说一句（主动台词 / 菜单台词）。优先 Edge 神经语音，失败回落到
 * 渲染进程的系统发音人。
 * @param {string} text
 * @param {boolean} requireIdle - 说话前再确认用户没在听/想/说、气泡没开
 */
async function sayWithVoice(text, requireIdle) {
  if (!text) return;
  if (requireIdle && (voicePhase !== 'idle' || bubbleOpen || drag || menuOpen)) {
    logWarn('say dropped: user became active');
    return;
  }
  const tts = config.data && config.data.tts;
  if (tts && (tts.mode === 'edge' || tts.mode === 'auto')) {
    try {
      const spoken = await dshVoice.speak(bridgeBase(), text, tts);
      if (requireIdle && (voicePhase !== 'idle' || bubbleOpen)) {
        logWarn('say dropped after tts: user became active');
        return;
      }
      logWarn('tts[edge] say ' + spoken.buffer.length + ' bytes');
      send('voice:say-audio', {
        text,
        audio: spoken.buffer.toString('base64'),
        mime: spoken.mime,
      });
      return;
    } catch (err) {
      logWarn('edge say failed, using system voice: ' + reason(err));
    }
  }
  if (tts && tts.mode === 'cloud') {
    try {
      const spoken = await voice.synthesize(text, tts);
      if (spoken) {
        send('voice:say-audio', {
          text,
          audio: spoken.buffer.toString('base64'),
          mime: spoken.mime,
        });
        return;
      }
    } catch (err) {
      logWarn('cloud say failed, using system voice: ' + reason(err));
    }
  }
  if (requireIdle && (voicePhase !== 'idle' || bubbleOpen)) return;
  send('voice:say', text);
}

const LINES = [
  '为您服务。',
  '系统一切正常。',
  '全息核心在线。',
  '需要我做什么？',
  '正在监听您的指令。',
  '所有系统已就绪。',
  '注意休息。',
  '我已为您待命。',
  '能量水平稳定。',
  '随时听候吩咐。',
];

function randomLine() {
  return LINES[Math.floor(Math.random() * LINES.length)];
}

// ------------------------------------------------------- 闲聊模式 (chitchat) --

function chitchatConfig() {
  return config.data && config.data.chitchat ? config.data.chitchat : {};
}

/** 真正会主动开口的条件：开关打开 + 已经接入大脑。 */
function chitchatEnabled() {
  return Boolean(config.data && chitchatConfig().enabled === true && voice.hasBrain(config.data.llm));
}

function chitchatDelayMs() {
  const c = chitchatConfig();
  const min = Math.max(30, Number(c.minIntervalSec) || 90) * 1000;
  const max = Math.max(min, (Number(c.maxIntervalSec) || 210) * 1000);
  return min + Math.random() * (max - min);
}

/** 排下一次主动搭话；重复调用会先取消旧的计时器。 */
function scheduleChitchat(delayMs) {
  if (chitchatTimer) {
    clearTimeout(chitchatTimer);
    chitchatTimer = null;
  }
  if (!chitchatEnabled()) return;
  const wait = Number.isFinite(Number(delayMs)) ? Math.max(1500, Number(delayMs)) : chitchatDelayMs();
  chitchatTimer = setTimeout(() => {
    chitchatTimer = null;
    void runChitchat('timer');
  }, wait);
}

/** 启动 / 重新载入配置时，把计时器和渲染进程的认知对齐到当前开关。 */
function syncChitchat() {
  const on = chitchatEnabled();
  if (!on) {
    if (chitchatTimer) {
      clearTimeout(chitchatTimer);
      chitchatTimer = null;
    }
  } else if (!chitchatTimer) {
    // 刚启动时先安静十几秒，不要把开场白和「系统已上线」叠在一起。
    scheduleChitchat(15000 + Math.random() * 15000);
  }
  if (config.data) {
    const why = on ? 'on' : chitchatConfig().enabled === true ? 'off (no llm key)' : 'off';
    logWarn('chitchat ' + why);
  }
  send('chitchat:state', on);
}

/** 从配置的话题种子里随机挑一条，最近用过的先避开。 */
function pickChitchatTopic() {
  const configured = Array.isArray(chitchatConfig().topics)
    ? chitchatConfig().topics.filter((topic) => typeof topic === 'string' && topic.trim())
    : [];
  const topics = configured.length ? configured : ['随口和您聊一句'];
  const fresh = topics.filter((topic) => !chitchatTopicsUsed.includes(topic));
  const pool = fresh.length ? fresh : topics;
  const topic = pool[Math.floor(Math.random() * pool.length)];
  chitchatTopicsUsed.push(topic);
  const keep = Math.max(3, Math.min(6, topics.length - 1));
  if (chitchatTopicsUsed.length > keep) chitchatTopicsUsed.shift();
  return topic;
}

function clockText() {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  } catch {
    return new Date().toLocaleString();
  }
}

function ageText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return seconds + ' 秒';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' 分钟';
  return Math.round(minutes / 60) + ' 小时';
}

/**
 * 一次主动搭话：生成 → 朗读/气泡 → 记进对话历史。
 * 用户正在听/想/说、气泡还开着、菜单打开、拖拽中都会让路。
 * @param {'timer' | 'manual'} trigger
 */
async function runChitchat(trigger) {
  const manual = trigger === 'manual';
  if (!chitchatEnabled()) return;
  if (chitchatBusy) {
    scheduleChitchat();
    return;
  }
  if (!win || win.isDestroyed() || !win.isVisible()) {
    scheduleChitchat(60000);
    return;
  }
  if (drag || menuOpen) {
    scheduleChitchat(15000);
    return;
  }
  if (voicePhase !== 'idle' || bubbleOpen) {
    // 手动点「现在聊一句」时如果正好在说话，过几秒再补上，而不是盖掉当前这句。
    scheduleChitchat(manual ? 8000 : 20000);
    return;
  }

  let idleSec = 0;
  try {
    idleSec = powerMonitor.getSystemIdleTime();
  } catch {
    /* 拿不到就当用户在场 */
  }
  const awayAfterMin = Number(chitchatConfig().awayAfterMin);
  if (!manual && awayAfterMin > 0 && idleSec > awayAfterMin * 60) {
    // 键鼠空闲太久，多半人不在；不要对着空房间说话。配置成 0 可关闭这个判断。
    scheduleChitchat(90000);
    return;
  }

  const hour = Math.floor(Date.now() / 3600000);
  if (hour !== chitchatHour) {
    chitchatHour = hour;
    chitchatHourCount = 0;
  }
  const cap = Math.max(1, Number(chitchatConfig().maxPerHour) || 20);
  if (!manual && chitchatHourCount >= cap) {
    scheduleChitchat(120000);
    return;
  }

  chitchatBusy = true;
  try {
    const line = await voice.chitchat(config.data, {
      recent: chatHistory,
      topic: pickChitchatTopic(),
      timeText: clockText(),
      agoText: ageText(Date.now() - lastInteractionAt),
    });
    // 生成这一两秒里用户可能已经开口；这时候插嘴很讨厌，直接丢掉这句。
    if (!chitchatEnabled() || voicePhase !== 'idle' || bubbleOpen) {
      logWarn('chitchat dropped: user became active');
      return;
    }
    chatHistory.push({ role: 'assistant', content: line });
    trimHistory();
    chitchatHourCount += 1;
    logWarn('chitchat[' + trigger + '] ' + line);
    if (chitchatConfig().speak === false) showBubble(line);
    else await sayWithVoice(line, true);
  } catch (err) {
    // 闲聊失败不该打扰您，下一轮再试。
    logWarn('chitchat failed: ' + reason(err));
  } finally {
    chitchatBusy = false;
    scheduleChitchat();
  }
}

/**
 * 切换闲聊模式并持久化。
 * @param {boolean} enabled
 * @param {boolean} announce - 是否用气泡告诉用户结果
 */
function applyChitchat(enabled, announce) {
  if (!config.data) return false;
  const next = Boolean(enabled);
  try {
    writeChitchat(config.file, next);
  } catch (err) {
    logWarn('chitchat config write failed: ' + reason(err));
  }
  config.data.chitchat.enabled = next;
  if (chitchatTimer) {
    clearTimeout(chitchatTimer);
    chitchatTimer = null;
  }
  const ready = next && voice.hasBrain(config.data.llm);
  // 等「闲聊模式已开启」的气泡收起来再开口，别自己盖自己的话。
  if (ready) scheduleChitchat(12000 + Math.random() * 6000);
  send('chitchat:state', ready);
  if (next && !ready) showBubble('闲聊模式需要先填 llm.apiKey。');
  if (announce) {
    showBubble(
      next
        ? ready
          ? '闲聊模式已开启。我会自己找话题。'
          : '闲聊模式已记下，但没有 Key 我还开不了口。'
        : '闲聊模式已关闭。',
    );
  }
  return next;
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  }
  if (tray) {
    tray.setToolTip(win.isVisible() ? '桌面管家 · 在线' : '桌面管家 · 已隐藏');
  }
}

function resetPosition() {
  if (!win) return;
  const b = win.getBounds();
  const p = defaultPosition(b.width, b.height);
  win.setPosition(p.x, p.y);
  state.x = p.x;
  state.y = p.y;
  persist();
}

function applySize(width) {
  if (!win) return;
  const w = Math.max(SIZES.small, Math.min(SIZES.large, Math.round(width)));
  const b = win.getBounds();
  const h = Math.round(w * 0.92);
  const x = b.x + b.width - w;
  const y = b.y + b.height - h;
  const p = clampToScreen(x, y, w, h);
  win.setBounds({ x: p.x, y: p.y, width: w, height: h });
  state.width = w;
  state.height = h;
  state.x = p.x;
  state.y = p.y;
  persist();
  send('pet:width', w);
}

function buildMenu() {
  const template = [
    {
      label: '语音对话',
      accelerator: 'Ctrl+Alt+Space',
      click: () => send('voice:toggle'),
    },
    {
      label: '语音常开（持续聆听）',
      type: 'checkbox',
      checked: state.alwaysListen,
      click: (item) => send('voice:continuous', item.checked),
    },
    {
      label: '闲聊模式（主动搭话）',
      type: 'checkbox',
      checked: Boolean(chitchatConfig().enabled),
      click: (item) => {
        applyChitchat(item.checked, true);
      },
    },
    { type: 'separator' },
    {
      label: '大小',
      submenu: [
        { label: '小', type: 'radio', checked: state.width === SIZES.small, click: () => applySize(SIZES.small) },
        { label: '中', type: 'radio', checked: state.width === SIZES.medium, click: () => applySize(SIZES.medium) },
        { label: '大', type: 'radio', checked: state.width === SIZES.large, click: () => applySize(SIZES.large) },
      ],
    },
    {
      label: '隐藏',
      click: () => {
        if (win) win.hide();
        if (tray) tray.setToolTip('桌面管家 · 已隐藏');
      },
    },
    { type: 'separator' },
    {
      label: '更多',
      submenu: [
        {
          label: '现在聊一句',
          enabled: chitchatEnabled(),
          click: () => {
            void runChitchat('manual');
          },
        },
        {
          label: '播放每日推荐',
          click: () => {
            void shell.openExternal('orpheus://songrcmd?autoplay=1');
          },
        },
        {
          label: '打开 B 站首页',
          click: () => {
            void shell.openExternal('https://www.bilibili.com/');
          },
        },
        {
          label: '打开 B 站动态',
          click: () => {
            void shell.openExternal('https://t.bilibili.com/');
          },
        },
        {
          label: '打开经典老歌',
          click: () => {
            void shell.openExternal(
              'https://www.bilibili.com/video/BV1BDk2YCEHF/?spm_id_from=333.337.search-card.all.click&vd_source=b5f11290c00282b966446c93a1d0b2ac',
            );
          },
        },
        {
          label: '主题',
          submenu: [
            {
              label: '金色全息',
              type: 'radio',
              checked: state.theme !== 'blue' && state.theme !== 'cinematic',
              click: () => applyTheme('gold'),
            },
            {
              label: '冷蓝全息',
              type: 'radio',
              checked: state.theme === 'blue',
              click: () => applyTheme('blue'),
            },
            {
              label: '环境光',
              type: 'radio',
              checked: state.theme === 'cinematic',
              click: () => applyTheme('cinematic'),
            },
            {
              label: '实况 · 金色（v12）',
              type: 'radio',
              checked: state.theme === 'live-gold',
              click: () => applyTheme('live-gold'),
            },
            {
              label: '实况 · 深蓝（v15）',
              type: 'radio',
              checked: state.theme === 'live-blue',
              click: () => applyTheme('live-blue'),
            },
          ],
        },
        { type: 'separator' },
        {
          label: '始终置顶',
          type: 'checkbox',
          checked: state.alwaysOnTop,
          click: (item) => {
            state.alwaysOnTop = item.checked;
            if (win) win.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver');
            persist();
          },
        },
        {
          label: '回到右下角',
          click: resetPosition,
        },
        { type: 'separator' },
        {
          label: '打开语音配置',
          click: () => {
            shell.openPath(config.file);
          },
        },
        {
          label: '重新载入语音配置',
          click: () => {
            showBubble(reloadConfig() ? '语音配置已重新载入。' : '配置读不出来。');
          },
        },
        {
          label: '重建软件索引',
          click: () => {
            tools
              .appIndex(APP_ROOT, { refresh: true })
              .then((entries) => showBubble('软件索引已重建，共 ' + entries.length + ' 个。'))
              .catch(() => showBubble('软件索引重建失败。'));
          },
        },
        { type: 'separator' },
        {
          label: '关于 桌面管家',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '桌面管家',
              message: '桌面管家 · 金色全息球桌宠',
              detail:
                '单击：回应您（文字 + 语音）\n拖拽：搬动全息核心\nCtrl+Alt+Space：语音对话\n底部绿点：语音常开\n右键：打开管家菜单\n\n语音配置：desktop-butler-config.json（更多 → 打开语音配置）\n形象灵感：原创金色全息界面。',
              buttons: ['明白'],
              noLink: true,
            });
          },
        },
      ],
    },
    {
      label: '退出',
      click: () => {
        forcedQuit = true;
        app.quit();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

function showContextMenu() {
  if (!win) return;
  menuOpen = true;
  setClickThrough(false);
  const menu = buildMenu();
  menu.popup({
    window: win,
    callback: () => {
      menuOpen = false;
      // The cursor watcher will restore click-through on the next tick.
    },
  });
}

/**
 * The renderer's forwarded mousemove is not reliable across all Windows
 * transparency modes, so the authoritative hit test runs here against the
 * real OS cursor. It keeps the transparent area click-through while making
 * the orb (and an open bubble) fully interactive.
 */
function startPointerWatch() {
  if (pointerTimer) clearInterval(pointerTimer);
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (drag || menuOpen) {
      setClickThrough(false);
      return;
    }
    const b = win.getBounds();
    const stageH = (b.width * 9) / 16;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height - stageH + stageH * 0.48;
    const radius = b.width * 0.345;
    const p = screen.getCursorScreenPoint();
    const dx = p.x - cx;
    const dy = p.y - cy;
    const overOrb = dx * dx + dy * dy <= radius * radius;
    const overBubble =
      bubbleOpen &&
      p.x >= b.x + b.width * 0.05 &&
      p.x <= b.x + b.width * 0.95 &&
      p.y >= b.y + 2 &&
      p.y <= b.y + b.height - stageH + 6;
    setClickThrough(!(overOrb || overBubble));
  }, 50);
}

function createTray() {
  const iconPath = path.join(APP_ROOT, 'assets', 'tray.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('桌面管家 · 在线');
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  tray.on('click', toggleWindow);
  tray.on('double-click', toggleWindow);
}

function createWindow() {
  readState();
  const w = state.width;
  const h = state.height;
  let x = state.x;
  let y = state.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const p = defaultPosition(w, h);
    x = p.x;
    y = p.y;
  }
  const p = clampToScreen(x, y, w, h);
  state.x = p.x;
  state.y = p.y;

  win = new BrowserWindow({
    x: p.x,
    y: p.y,
    width: w,
    height: h,
    minWidth: SIZES.small,
    maxWidth: SIZES.large,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.alwaysOnTop,
    focusable: true,
    show: false,
    title: '桌面管家',
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (state.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(APP_ROOT, 'index.html'), { query: { theme: state.theme } });
  // 页面每次加载完都补推一次当前工作状态：首屏 ready-to-show 的推送可能早于
  // 渲染进程注册监听，voice:config 也可能在 startWorkWatch 之前就返回了。
  win.webContents.on('did-finish-load', () => pushWorkStatus(true));

  win.once('ready-to-show', () => {
    win.showInactive();
    win.setIgnoreMouseEvents(true, { forward: true });
    ignoreMouse = true;
    send('pet:width', state.width);
    startPointerWatch();
    startWorkWatch();
    persist();
  });

  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    state.x = b.x;
    state.y = b.y;
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.on('render-process-gone', () => {
    if (forcedQuit || !win) return;
    win.reload();
  });
}

function openSettingsWindow() {
  if (!win || win.isDestroyed()) return;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  const b = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  });
  const area = display.workArea;
  const width = Math.min(1000, area.width - 24);
  const height = Math.min(760, area.height - 24);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);

  settingsWin = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    title: '桌面管家 · 设置',
    webPreferences: {
      preload: path.join(APP_ROOT, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (state.alwaysOnTop) settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.setMenuBarVisibility(false);
  settingsWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
    }
  });
  win.hide();
  settingsWin.loadFile(path.join(APP_ROOT, 'settings.html'), { query: { theme: state.theme } });
  settingsWin.once('ready-to-show', () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    settingsWin.show();
    settingsWin.focus();
  });
  settingsWin.webContents.on('did-fail-load', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (settingsHidePet) {
      settingsHidePet = false;
      return;
    }
    if (win && !win.isDestroyed()) {
      win.showInactive();
      setClickThrough(true);
    }
  });
}

function settingsState() {
  return {
    theme: state.theme,
    size: state.width,
    alwaysOnTop: state.alwaysOnTop,
    alwaysListen: state.alwaysListen,
    chitchat: Boolean(chitchatConfig().enabled),
  };
}

function pushSettingsState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('pet:settings-state', settingsState());
  }
}

function handleSettingsAction(name, value) {
  switch (name) {
    case 'voice':
      send('voice:toggle');
      break;
    case 'alwaysListen':
      state.alwaysListen = Boolean(value);
      persist();
      send('voice:continuous', Boolean(value));
      break;
    case 'chitchat':
      applyChitchat(Boolean(value), true);
      break;
    case 'theme':
      applyTheme(String(value || 'gold'));
      break;
    case 'size':
      applySize(Number(value) || BASE_W);
      break;
    case 'alwaysOnTop':
      state.alwaysOnTop = Boolean(value);
      if (win) win.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver');
      persist();
      break;
    case 'resetPosition':
      resetPosition();
      break;
    case 'hide':
      settingsHidePet = true;
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
      else if (win) win.hide();
      break;
    case 'chitchatNow':
      void runChitchat('manual');
      break;
    case 'daily':
      void shell.openExternal('orpheus://songrcmd?autoplay=1');
      break;
    case 'biliHome':
      void shell.openExternal('https://www.bilibili.com/');
      break;
    case 'biliDynamic':
      void shell.openExternal('https://t.bilibili.com/');
      break;
    case 'biliClassic':
      void shell.openExternal('https://www.bilibili.com/video/BV1BDk2YCEHF/?spm_id_from=333.337.search-card.all.click&vd_source=b5f11290c00282b966446c93a1d0b2ac');
      break;
    case 'voiceConfig':
      void shell.openPath(config.file);
      break;
    case 'reloadConfig':
      showBubble(reloadConfig() ? '语音配置已重新载入。' : '配置读不出来。');
      break;
    case 'appIndex':
      tools.appIndex(APP_ROOT, { refresh: true })
        .then((entries) => showBubble('软件索引已重建，共 ' + entries.length + ' 个。'))
        .catch(() => showBubble('软件索引重建失败。'));
      break;
    case 'about':
      dialog.showMessageBox(settingsWin || win, {
        type: 'info',
        title: '桌面管家',
        message: '桌面管家 · 金色全息桌宠',
        detail: `单击：回应您（文字 + 语音）
拖拽：移动全息核心
Ctrl+Alt+Space：语音对话
右键：打开设置

语音配置：desktop-butler-config.json
形象灵感：原创金色全息界面。`,
        buttons: ['明白'],
        noLink: true,
      });
      break;
    case 'quit':
      forcedQuit = true;
      app.quit();
      break;
    default:
      break;
  }
  pushSettingsState();
}

ipcMain.handle('pet:settings-state', () => settingsState());
ipcMain.on('pet:settings-action', (_e, payload) => {
  if (!payload || typeof payload !== 'object') return;
  handleSettingsAction(String(payload.name || ''), payload.value);
});

ipcMain.on('pet:open-settings', () => openSettingsWindow());
ipcMain.on('pet:close-settings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

ipcMain.on('pet:ignore', (_e, flag) => setClickThrough(Boolean(flag)));

ipcMain.on('pet:drag-start', () => {
  if (!win) return;
  drag = {
    cursor: screen.getCursorScreenPoint(),
    bounds: win.getBounds(),
  };
  setClickThrough(false);
});

ipcMain.on('pet:drag-move', () => {
  if (!win || !drag) return;
  const pt = screen.getCursorScreenPoint();
  const dx = pt.x - drag.cursor.x;
  const dy = pt.y - drag.cursor.y;
  const p = clampToScreen(
    Math.round(drag.bounds.x + dx),
    Math.round(drag.bounds.y + dy),
    drag.bounds.width,
    drag.bounds.height,
  );
  win.setPosition(p.x, p.y);
});

ipcMain.on('pet:drag-end', () => {
  drag = null;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    state.x = b.x;
    state.y = b.y;
    persist();
  }
  setTimeout(() => setClickThrough(true), 40);
});

ipcMain.on('pet:menu', showContextMenu);
ipcMain.on('pet:bubble', (_e, open) => {
  bubbleOpen = Boolean(open);
});
ipcMain.on('pet:say', () => showBubble(randomLine()));
ipcMain.on('pet:say-text', (_e, text) => {
  const line = String(text || '').trim();
  if (line) void sayWithVoice(line, false);
});
ipcMain.on('pet:resize', (_e, width) => applySize(Number(width) || BASE_W));
ipcMain.on('pet:quit', () => {
  forcedQuit = true;
  app.quit();
});

ipcMain.handle('pet:get-width', () => state.width);

// ------------------------------------------------------------------- voice --

ipcMain.on('pet:voice-state', (_e, value) => {
  const next = String(value || 'idle');
  voicePhase = next;
  // 用户开始听/问，就算一次互动：闲聊的「多久没聊了」和让路判断都靠它。
  if (next === 'listening' || next === 'thinking') lastInteractionAt = Date.now();
  if (tray) tray.setToolTip(next === 'idle' ? '桌面管家 · 在线' : '桌面管家 · ' + next);
});

ipcMain.on('pet:always-listen', (_e, on) => {
  logWarn('always-listen ' + Boolean(on));
  state.alwaysListen = Boolean(on);
  persist();
});

ipcMain.on('pet:set-theme', (_e, theme) => {
  applyTheme(theme);
});

ipcMain.handle('voice:config', () => {
  const data = config.data;
  return {
    voice: data ? data.voice : {},
    tts: data ? data.tts : {},
    name: data && data.persona ? data.persona.name : '桌面管家',
    hasBrain: Boolean(data && voice.hasBrain(data.llm)),
    asrMode: data ? voice.asrMode(data.asr) : 'system',
    chitchat: {
      enabled: chitchatEnabled(),
      minIntervalSec: Number(chitchatConfig().minIntervalSec) || 90,
      maxIntervalSec: Number(chitchatConfig().maxIntervalSec) || 210,
    },
    alwaysListen: state.alwaysListen,
    workStatus: workSnapshot || readWorkStatus(),
  };
});

/**
 * One spoken turn: WAV in, answer (and optional cloud audio) out.
 * Failures are returned as `{ ok: false, error }` so the renderer can say them
 * out loud instead of throwing across the IPC boundary.
 */
ipcMain.handle('voice:ask', async (_event, wav) => {
  const data = config.data;
  if (!data) return { ok: false, error: '语音配置没加载起来。' };

  let audio;
  try {
    audio = Buffer.from(wav);
  } catch {
    return { ok: false, error: '音频数据不对。' };
  }

  let heard = '';
  let usedAsr = '';
  const asrMode = String(data.asr.mode || 'auto');
  const preferDsh = asrMode === 'auto' || asrMode === 'dsh';
  if (preferDsh) {
    try {
      heard = normalizeHeard(await dshVoice.transcribe(bridgeBase(), audio));
      usedAsr = 'dsh';
      logWarn('asr[dsh] ' + heard);
    } catch (err) {
      logWarn('asr[dsh] failed: ' + reason(err));
      if (asrMode === 'dsh') {
        return { ok: false, error: 'DSH 语音识别不可用：' + reason(err) };
      }
    }
  }
  if (usedAsr !== 'dsh') {
    try {
      const result = await voice.transcribe(audio, data.asr);
      heard = normalizeHeard(result.text);
      usedAsr = result.mode;
      logWarn('asr[' + result.mode + '] ' + heard);
    } catch (err) {
      logWarn('asr failed: ' + reason(err));
      return { ok: false, error: reason(err) };
    }
  }
  if (!heard) return { ok: true, heard: '', reply: '' };

  chatHistory.push({ role: 'user', content: heard });
  trimHistory();

  // Tell the pet what it is doing before it does it: a tool round costs a
  // second or two, and a silent orb reads as "it did not hear me".
  const runTool = async (name, args) => {
    const label = tools.describe(name, args);
    if (label) send('voice:tool', label);
    const result = await tools.run(name, args, { appRoot: APP_ROOT, bridgeUrl: bridgeBase() });
    logWarn('tool ' + name + ' ' + JSON.stringify(args || {}) + ' -> ' + JSON.stringify(result).slice(0, 300));
    return result;
  };

  let reply;
  try {
    reply = await voice.chat(chatHistory, data.llm, data.persona, {
      // Everything here is Windows-only; on other platforms the model is never
      // told it can touch the machine.
      tools: process.platform === 'win32' ? tools.schemas() : [],
      runTool: process.platform === 'win32' ? runTool : null,
    });
  } catch (err) {
    // A failed turn must not poison the history with an unanswered question.
    chatHistory.pop();
    logWarn('llm failed: ' + reason(err));
    return { ok: false, error: reason(err), heard };
  }
  chatHistory.push({ role: 'assistant', content: reply });
  trimHistory();
  logWarn('reply ' + reply);

  let cloudAudio = null;
  let mime = null;
  let usedTts = '';
  const ttsMode = String(data.tts.mode || 'edge');
  if (ttsMode === 'edge' || ttsMode === 'auto') {
    try {
      const spoken = await dshVoice.speak(bridgeBase(), reply, data.tts);
      cloudAudio = spoken.buffer.toString('base64');
      mime = spoken.mime;
      usedTts = 'edge';
      logWarn('tts[edge] ' + spoken.buffer.length + ' bytes');
    } catch (err) {
      // Edge 是升级项：失败就回到渲染进程的系统语音，不打断回答。
      logWarn('tts[edge] failed, using system voice: ' + reason(err));
    }
  }
  if (!cloudAudio && ttsMode === 'cloud') {
    try {
      const spoken = await voice.synthesize(reply, data.tts);
      if (spoken) {
        cloudAudio = spoken.buffer.toString('base64');
        mime = spoken.mime;
        usedTts = 'cloud';
        logWarn('tts[cloud] ' + spoken.buffer.length + ' bytes');
      }
    } catch (err) {
      // Cloud TTS is an upgrade, never a requirement: fall back to the system voice.
      logWarn('tts failed, using system voice: ' + reason(err));
    }
  }

  return { ok: true, heard, reply, audio: cloudAudio, mime, asr: usedAsr, tts: usedTts };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.showInactive();
      win.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver');
    }
  });

  app.whenReady().then(() => {
    // The transparent window has no visible chrome, so an unanswered media
    // prompt would silently kill the mic. Grant only audio capture.
    const allowMedia = (permission) => permission === 'media';
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const isAudio = !details || !details.mediaTypes || details.mediaTypes.includes('audio');
      callback(allowMedia(permission) && isAudio);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

    reloadConfig();
    createWindow();
    createTray();
    globalShortcut.register('CommandOrControl+Alt+J', toggleWindow);
    globalShortcut.register('CommandOrControl+Alt+Space', () => send('voice:toggle'));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (pointerTimer) clearInterval(pointerTimer);
    stopWorkWatch();
    if (chitchatTimer) {
      clearTimeout(chitchatTimer);
      chitchatTimer = null;
    }
  });

  app.on('before-quit', () => {
    forcedQuit = true;
    persist();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
