/*
 * 桌面管家 → DSH 语音桥（Node 侧，零依赖）。
 *
 * 桌宠自己也能识别（Windows SAPI / 云端 ASR）和合成（系统语音 / 云端 TTS），
 * 但 dsh-chatting-pet 那条链路更强：识别走 DSH 内置 SenseVoice，合成走 Edge
 * 神经语音。插件 `dsh-desktop-butler` 把这两件事挂成 /desktop-butler/transcribe|speak，
 * 这里只负责 HTTP 调用；插件不在 / DSH 没开时抛错，由 main.js 回落到原链路。
 */
'use strict';

const DEFAULT_BASE = 'http://127.0.0.1:62012';

/**
 * 解析桥地址。
 * @param {string} [configured] - desktop-butler-config.json 的 bridge.baseUrl
 * @returns {string}
 */
function resolveBase(configured) {
  const env = typeof process.env.DESKTOP_BUTLER_DSH_URL === 'string' ? process.env.DESKTOP_BUTLER_DSH_URL.trim() : '';
  const text = env || (typeof configured === 'string' ? configured.trim() : '') || DEFAULT_BASE;
  return text.replace(/\/+$/, '');
}

/**
 * POST JSON 到 DSH 插件路由。
 * @param {string} base
 * @param {string} path
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function postJson(base, path, payload, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  try {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('语音桥返回的不是 JSON（HTTP ' + response.status + '）');
    }
    if (!response.ok || json.ok === false) {
      throw new Error((json && json.error) || 'HTTP ' + response.status);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 DSH 内置识别转写 WAV。
 * @param {string} base
 * @param {Buffer|Uint8Array} wav - 16kHz mono PCM16 WAV
 * @param {string} [language]
 * @returns {Promise<string>} 识别文本（空串 = 没听到人声）
 */
async function transcribe(base, wav, language) {
  if (!wav || wav.length < 1200) throw new Error('录音太短');
  const payload = { audioBase64: Buffer.from(wav).toString('base64') };
  if (language) payload.language = String(language);
  const json = await postJson(base, '/desktop-butler/transcribe', payload, 90000);
  return String(json.text || '').trim();
}

/**
 * 用 Edge 神经语音合成。
 * @param {string} base
 * @param {string} text
 * @param {{edgeVoice?: string, edgeRate?: string, edgePitch?: string, edgeVolume?: string}} [options]
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
async function speak(base, text, options = {}) {
  const json = await postJson(
    base,
    '/desktop-butler/speak',
    {
      text: String(text || ''),
      voice: options.edgeVoice,
      rate: options.edgeRate,
      pitch: options.edgePitch,
      volume: options.edgeVolume,
    },
    60000,
  );
  const buffer = Buffer.from(String(json.audio || ''), 'base64');
  if (!buffer.length) throw new Error('语音桥返回空音频');
  return { buffer, mime: json.mime || 'audio/webm' };
}

module.exports = { resolveBase, transcribe, speak, DEFAULT_BASE };
