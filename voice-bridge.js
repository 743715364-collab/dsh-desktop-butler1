/**
 * Edge 神经语音（Microsoft Edge Read Aloud）桥。
 *
 * dsh-chatting-pet 的语音默认引擎就是它：免费、无需 key、中文音色比 Windows SAPI
 * 自然很多。这里只保留「一段文本 → WebM/Opus Buffer」这一件事，播放仍由桌面管家
 * 渲染进程负责。
 *
 * 为什么用子进程：msedge-tts 是纯 CJS（依赖 ws/axios），而 DSH 宿主对 profile 里
 * 外部包的 require 有包装，直接在宿主里加载会抛 `createRequire.resolve.paths`。
 * 所以每次合成拉起一个干净的 `ELECTRON_RUN_AS_NODE` 进程跑 `edge-tts-worker.cjs`，
 * 父进程只负责传文本、收 base64。依赖从当前 profile 的 node_modules 里找。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'edge-tts-worker.cjs');
const WORKER_TIMEOUT_MS = 60000;

/** 设置页可选的音色；Desktop Butler 默认用云希（年轻男声），也可以换回晓晓。 */
export const EDGE_VOICES = [
  { id: 'zh-CN-YunxiNeural', label: '云希 · 年轻男声（推荐）' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 成熟男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 播音男声' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 自然女声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 元气少女' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北甜妹' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾甜音' },
];

const DEFAULT_VOICE = 'zh-CN-YunxiNeural';
const DEFAULT_RATE = '+2%';
const DEFAULT_PITCH = '+0Hz';
const DEFAULT_VOLUME = '+0%';

/** 声音名只允许字母数字和连字符，防止把 SSML 拼坏 */
function cleanVoice(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9-]{5,64}$/.test(text) ? text : DEFAULT_VOICE;
}

/** 语速/音高/音量只接受 `+2%`、`-4Hz` 这类值 */
function cleanProsody(value, fallback) {
  const text = String(value || '').trim();
  return /^[+-]?\d+(?:\.\d+)?(?:Hz|%)$/.test(text) ? text : fallback;
}

const lookup = { errors: [] };

/** 找到当前 profile / 插件目录里的 msedge-tts 入口文件 */
export function findEdgeEntry() {
  lookup.errors = [];
  const profileDir = process.env.DSH_PROFILE_DIR
    || join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE || 'desktop');
  const dirs = [
    join(profileDir, 'node_modules', 'msedge-tts'),
    join(HERE, 'node_modules', 'msedge-tts'),
    join(HERE, '..', 'node_modules', 'msedge-tts'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      lookup.errors.push(dir + ': not found');
      continue;
    }
    for (const entry of [join(dir, 'dist', 'index.js'), join(dir, 'dist', 'index'), join(dir, 'index.js')]) {
      if (existsSync(entry)) return entry;
      if (existsSync(entry + '.js')) return entry + '.js';
    }
    lookup.errors.push(dir + ': entry not found');
  }
  return null;
}

/**
 * 跑一次 Edge worker。
 * @param {string} entry - msedge-tts 入口绝对路径
 * @param {object} payload - { text, voice, rate, pitch, volume }
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
function runWorker(entry, payload) {
  return new Promise((resolve, reject) => {
    const executable = process.env.DSH_NODE_EXECUTABLE || process.execPath;
    // 只给 worker 必要的系统环境：DSH 宿主的 NODE_OPTIONS / 加载钩子不能带进去，
    // 否则一个干净的 CJS 包也会被宿主模块系统影响。
    const env = {
      ELECTRON_RUN_AS_NODE: '1',
      EDGE_TTS_ENTRY: entry,
    };
    for (const key of [
      'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA',
      'LOCALAPPDATA', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'NUMBER_OF_PROCESSORS',
      'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn(executable, [WORKER], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(reject, new Error('Edge TTS 超时'));
    }, WORKER_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', () => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let parsed = null;
      try {
        parsed = JSON.parse(lines[lines.length - 1] || '');
      } catch {
        parsed = null;
      }
      if (!parsed) {
        finish(reject, new Error('Edge worker 返回异常' + (stderr ? '：' + stderr.trim().slice(0, 200) : '')));
        return;
      }
      if (!parsed.ok) {
        finish(reject, new Error(parsed.error || 'Edge 合成失败'));
        return;
      }
      const buffer = Buffer.from(String(parsed.audio || ''), 'base64');
      if (!buffer.length) {
        finish(reject, new Error('Edge 返回空音频'));
        return;
      }
      finish(resolve, { buffer, mime: parsed.mime || 'audio/webm' });
    });
    child.stdin.on('error', () => {
      /* worker exited early; close handler reports */
    });
    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

export class EdgeSpeaker {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.lastErrorText = '';
  }

  /** 只查文件在不在；真正合成失败会在 lastError 里 */
  available() {
    return Boolean(findEdgeEntry());
  }

  /** 解析/合成失败时给排查用的最后错误（成功则为空串） */
  lastError() {
    if (this.lastErrorText) return this.lastErrorText;
    findEdgeEntry();
    return lookup.errors.join(' | ');
  }

  /**
   * 合成一段文本。
   * @param {string} text
   * @param {{voice?: string, rate?: string, pitch?: string, volume?: string}} [options]
   * @returns {Promise<{buffer: Buffer, mime: string}>}
   */
  async synthesize(text, options = {}) {
    const entry = findEdgeEntry();
    if (!entry) throw new Error('msedge-tts 不可用：' + lookup.errors.join(' | '));
    const input = String(text || '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim()
      .slice(0, 800);
    if (!input) throw new Error('要合成的文本为空');
    const payload = {
      text: input,
      voice: cleanVoice(options.voice),
      rate: cleanProsody(options.rate, DEFAULT_RATE),
      pitch: cleanProsody(options.pitch, DEFAULT_PITCH),
      volume: cleanProsody(options.volume, DEFAULT_VOLUME),
    };
    try {
      return await runWorker(entry, payload);
    } catch (error) {
      this.lastErrorText = error && error.message ? error.message : String(error);
      this.log('edge tts failed: ' + this.lastErrorText);
      throw error;
    }
  }

  dispose() {
    /* worker 是每次调用一个进程，没有常驻连接要关 */
  }
}
