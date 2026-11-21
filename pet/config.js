/*
 * 桌面管家 — voice config.
 *
 * Everything the voice pipeline needs lives in `desktop-butler-config.json` next to the
 * app, so the pet stays portable (same rule as `data/`). The file is created
 * with placeholder values on first run; the user only has to paste a key.
 *
 * Nothing here throws: a broken file falls back to defaults and the pet keeps
 * running in offline mode instead of failing to start.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'desktop-butler-config.json';

/** Spoken-reply persona. Kept short on purpose: this is read aloud, not read. */
const DEFAULT_SYSTEM = [
  '你就是桌面管家（桌面管家），一位沉稳、礼貌的的全息人工智能，称呼用户为「您」。',
  '说话风格：冷静、简练、略带英式幽默，带一点管家腔，但不要油腻，不要堆砌称呼。',
  '这是语音对话：回答必须短，一到两句话，先说结论。不要用 Markdown、列表、表情符号或链接。',
  '不要复述用户的原话，不要念出“您刚才说”这类前缀。遇到听不清的内容，直接问一句。',
].join('\n');

const DEFAULTS = {
  _help: [
    '改完这个文件要重启桌宠（或右键 → 重新载入语音配置）才生效。',
    'llm.apiKey 是唯一必须填的东西：不填就只能听不能说（走本机离线语音时仍能识别）。',
    'asr.mode 取值 auto / dsh / cloud / system：auto 优先用 DSH 内置识别（SenseVoice），不可用时回退云端/系统。',
    'tts.mode 取值 edge / system / cloud：edge 用 DSH 插件里的 Edge 神经语音（推荐），system 用系统发音人，cloud 走 OpenAI 兼容接口。',
    'chitchat.enabled 打开后，桌宠会隔一段时间主动找话题（用 llm 那一套接口）；间隔看 chitchat.minIntervalSec / maxIntervalSec。',
    'bridge.baseUrl 一般留空：插件拉起时自动注入 DSH 地址，手动启动默认连 http://127.0.0.1:62012 。',
    'baseUrl 要带版本段，例如 https://api.deepseek.com/v1 。',
  ],

  llm: {
    mode: 'auto',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    maxTokens: 260,
    temperature: 0.7,
    timeoutMs: 30000,
  },

  asr: {
    mode: 'auto',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    apiKey: '',
    language: 'zh',
    culture: 'zh-CN',
    // Extra phrases the offline recogniser should listen for verbatim. Empty by
    // default: a constrained grammar can hijack open dictation.
    phrases: [],
  },

  tts: {
    // edge = DSH 插件里的 Edge 神经语音（推荐）；system = Windows 发音人；cloud = 自定义接口
    mode: 'edge',
    edgeVoice: 'zh-CN-YunxiNeural',
    edgeRate: '+2%',
    edgePitch: '+0Hz',
    edgeVolume: '+0%',
    voice: 'Microsoft Huihui Desktop',
    rate: 1,
    pitch: 1,
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1',
    voiceId: 'alloy',
    apiKey: '',
    timeoutMs: 20000,
  },

  /**
   * 和 DSH 插件（dsh-desktop-butler）之间的本机桥：识别走 DSH 内置 SenseVoice，
   * 合成走 Edge 神经语音。baseUrl 留空 = 用插件 spawn 时注入的 DESKTOP_BUTLER_DSH_URL，
   * 手动启动则回落到 http://127.0.0.1:62012。
   */
  bridge: {
    baseUrl: '',
  },

  persona: {
    name: '桌面管家',
    system: DEFAULT_SYSTEM,
    /** 语音包的附加风格提示；留空则只用 system。 */
    style: '',
  },

  /**
   * 闲聊模式：平时它只在您开口时说话；开关打开后，它会隔一段时间自己找
   * 话题搭话（用 llm 那一套接口，不经过工具层）。默认关闭，避免不知不觉
   * 消耗 token。
   */
  chitchat: {
    enabled: false,
    /** 两次搭话之间随机等这么久（秒）；间隔越大越安静。 */
    minIntervalSec: 90,
    maxIntervalSec: 210,
    /** 每小时最多主动说几句，防止把间隔调小后话痨 + 烧 token。 */
    maxPerHour: 20,
    /** 键鼠空闲超过这么多分钟就当人不在，先不搭话；0 = 不管。 */
    awayAfterMin: 20,
    /** true = 朗读出来；false = 只弹气泡，不发声。 */
    speak: true,
    /** 单句生成上限，闲聊不需要长文。 */
    maxTokens: 140,
    /** 生成温度；比正式回答松一点，话头更像闲聊。 */
    temperature: 0.95,
    /** 追加的人设 / 风格提示，留空就用内置的闲聊约束。 */
    system: '',
    /** 话题种子（随机挑一条交给模型，可自由增删）。 */
    topics: [
      '关心一下您今天过得怎么样',
      '提醒您喝水，或者起来活动一下',
      '问问您手上正在忙的事进展如何',
      '聊一句吃的：早饭、午饭或夜宵',
      '聊一句音乐、电影或书',
      '分享一个你确定的小知识，不要编造',
      '说说你这个全息核心此刻的状态',
      '提议一起做个简短的计划',
      '接上你们刚才聊过的话题继续聊',
      '问一个轻松的小问题，比如今天最开心的事',
      '用一句英式管家的幽默点评现在的时间',
      '关心一下您的睡眠或作息',
    ],
  },

  voice: {
    /** Silence that ends an utterance. */
    silenceMs: 900,
    /** Hard cap on one utterance. */
    maxMs: 20000,
    /** Ignore taps shorter than this. */
    minMs: 400,
    /** RMS gate; raise if the room is noisy. */
    threshold: 0.015,
    /** No speech at all within this window → cancel and say so. */
    noSpeechMs: 8000,
    /** Trim leading/trailing silence before sending (shorter upload, faster ASR). */
    trimSilence: true,
    /** How many turns of history to keep in the prompt. */
    historyTurns: 6,
  },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursively overlay known defaults; unknown keys are dropped. */
function merge(defaults, incoming) {
  if (!isObj(defaults)) return incoming === undefined ? defaults : incoming;
  const out = {};
  for (const key of Object.keys(defaults)) {
    const base = defaults[key];
    const next = isObj(incoming) ? incoming[key] : undefined;
    if (isObj(base)) {
      out[key] = merge(base, next);
    } else if (Array.isArray(base)) {
      out[key] = Array.isArray(next) ? next.filter((v) => typeof v === 'string') : base.slice();
    } else if (typeof base === 'number') {
      out[key] = Number.isFinite(Number(next)) ? Number(next) : base;
    } else if (typeof base === 'boolean') {
      out[key] = typeof next === 'boolean' ? next : base;
    } else {
      out[key] = typeof next === 'string' ? next : base;
    }
  }
  return out;
}

/** Re-create the config file with documentation, keeping any values already set. */
function write(file, values) {
  const body = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === '_help') {
      body[key] = DEFAULTS._help;
    } else {
      body[key] = values && values[key] !== undefined ? values[key] : DEFAULTS[key];
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

/**
 * Flip the chitchat switch in place, keeping every other value in the file.
 *
 * The pet menu toggles this at runtime, so it cannot go through `write()`:
 * that would drop keys the user added and reset values we do not know about.
 * @param {string} file
 * @param {boolean} enabled
 * @returns {boolean} what was written
 */
function setChitchat(file, enabled) {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    /* first run or a broken file: start from an empty object */
  }
  if (!isObj(raw)) raw = {};
  const current = isObj(raw.chitchat) ? raw.chitchat : {};
  raw.chitchat = { ...current, enabled: Boolean(enabled) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return Boolean(enabled);
}

/**
 * Load the config, creating the file when it is missing or unreadable.
 * @param {string} appRoot - directory that holds the pet.
 * @returns {{file: string, data: object}}
 */
function load(appRoot) {
  const file = path.join(appRoot, FILE_NAME);
  let parsed = null;
  let existed = false;
  try {
    // Notepad and PowerShell both like to prepend a BOM; JSON.parse chokes on it.
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    existed = true;
  } catch {
    // Missing or malformed: rewrite it so the user has something to edit.
  }
  const data = merge(DEFAULTS, isObj(parsed) ? parsed : {});
  if (!existed || !isObj(parsed)) {
    try {
      write(file, data);
    } catch {
      /* read-only install: run with defaults */
    }
  }
  return { file, data };
}

module.exports = { FILE_NAME, DEFAULTS, load, setChitchat };
