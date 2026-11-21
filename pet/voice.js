/*
 * 桌面管家 — voice pipeline.
 *
 * Three independent hops, each with a cloud path and a zero-config path:
 *
 *   speech → text   cloud /audio/transcriptions  or  Windows SAPI (offline)
 *   text   → reply  OpenAI-compatible /chat/completions        (needs a key)
 *   reply  → speech OpenAI-compatible /audio/speech or the renderer's
 *                   speechSynthesis (offline)
 *
 * Written without npm dependencies on purpose: the pet must keep running from a
 * plain folder with nothing but Electron. Only Node's http/https/fs are used.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SAPI_SCRIPT = path.join(__dirname, 'sapi-asr.ps1');

/** Error carrying a message fit for a speech bubble. */
class VoiceError extends Error {}

/**
 * Capability instructions live in code, not in the config file: the persona is
 * the user's to edit, but what the pet can actually do has to follow the build.
 */
const TOOL_GUIDANCE = [
  '[能力] 你可以直接操作这台电脑，已接入四个工具：打开软件、关闭软件、控制音乐播放、调节系统音量。',
  '- 用户明确要求时立刻调用工具，不要只回一句「好的」却不动手。',
  '- 一次只回一句话，不要复述调用了什么工具、也不要念参数。',
  '- 工具返回 ok:false 时，用一句话说明原因；返回 ambiguous 时，把候选念出来让用户选。',
  '- close_app 有副作用：用户明确说「关闭X」「把X关了」时这句话本身就是确认，直接调用，不要反问「您确定吗」；只有意图含糊、或可能丢失未保存内容时才先问一句。',
  '- 如果 close_app 返回 needsConfirm，不要说已经关闭；照 message 告诉用户去客户端里点「是」。',
  '- 用户说「播放音乐」「放首歌」「在 DSH 里点歌」时，用 play_dsh_music（DSH 音乐面板，需要面板已打开）；只有明确说「每日推荐」才用 play_daily_recommend。',
  '- 用户说「打开B站」「打开哔哩哔哩」时用 open_bilibili（page=home）；说「打开B站动态」时 page=dynamic；说「打开经典老歌」时 page=classic，不要用 open_app 去找客户端。',
  '- 用户没有要求时，不要主动操作电脑。',
  '- 「播放音乐」「放首歌」这类请求先调 media(action=status)；已经有音乐在放就 play_pause，没有就说明没有播放器在放歌。',
].join('\n');

/**
 * 闲聊模式：不是回答问题，而是它自己起话头。人设仍来自 config.persona，
 * 这里只补充「主动开口」这个场景的约束，避免它一开口就问「有什么可以帮您」。
 */
const CHITCHAT_GUIDANCE = [
  '[闲聊模式] 现在没有人在向你提问，轮到你主动开口，和您闲聊一句。',
  '- 结合当前时间、你们最近聊过的内容、以及距离上次互动过了多久，挑一个自然的话头。',
  '- 一到两句话，具体、自然；不要每次都以「有什么可以帮您」结尾。',
  '- 可以关心作息、聊吃的喝的、聊音乐电影书、分享一个你确定的小知识，或者问一个轻松的问题。',
  '- 不要编造实时信息（新闻、股价、外面的天气），也不要假装看到了屏幕内容。',
  '- 不要用 Markdown、列表、表情符号或链接；不要加「桌面管家：」之类的名字前缀。',
  '- 直接给出这句话本身，不要解释你在做什么。',
].join('\n');


/**
 * Minimal HTTP request helper.
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: Buffer|null, timeoutMs?: number}} options
 * @returns {Promise<{status: number, buffer: Buffer, headers: object}>}
 */
function request(url, options = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = options;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new VoiceError('接口地址不合法：' + url));
      return;
    }
    const mod = target.protocol === 'http:' ? require('http') : require('https');
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        method,
        headers: { 'user-agent': 'desktop-butler/1.0', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode || 0, buffer: Buffer.concat(chunks), headers: res.headers }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new VoiceError('请求超时（' + timeoutMs + 'ms）'));
    });
    req.on('error', (err) => {
      reject(err instanceof VoiceError ? err : new VoiceError('网络请求失败：' + err.message));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Pull a short human-readable reason out of a failed API response. */
function reasonOf(res) {
  const text = res.buffer.toString('utf8').slice(0, 600);
  try {
    const json = JSON.parse(text);
    const detail =
      (json.error && (json.error.message || json.error.code)) || json.message || json.detail || '';
    if (detail) return String(detail).slice(0, 200);
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 200) || 'HTTP ' + res.status;
}

/** JSON POST that throws a VoiceError on non-2xx. */
async function postJson(url, payload, { apiKey, timeoutMs = 30000, extra = {} }) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const res = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      authorization: 'Bearer ' + apiKey,
      ...extra,
    },
    body,
    timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) throw new VoiceError(reasonOf(res));
  try {
    return JSON.parse(res.buffer.toString('utf8'));
  } catch {
    throw new VoiceError('接口返回的不是 JSON');
  }
}

/** Encode a WAV buffer as multipart/form-data for the transcription endpoint. */
function wavForm(fields, wav) {
  const boundary = '----desktopbutler' + Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n', 'utf8'));
  }
  parts.push(
    Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n',
      'utf8',
    ),
  );
  parts.push(wav);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

/** Which recogniser will actually be used, given the config. */
function asrMode(asr) {
  if (asr.mode === 'cloud') return 'cloud';
  if (asr.mode === 'system') return 'system';
  return asr.apiKey ? 'cloud' : 'system';
}

/** Which synthesiser will actually be used, given the config. */
function ttsMode(tts) {
  if (tts.mode === 'cloud') return 'cloud';
  return 'system';
}

/** The local DSH proxy, when the plugin launched this pet. */
function dshBridge() {
  const url = String(process.env.DESKTOP_BUTLER_DSH_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.DESKTOP_BUTLER_BRIDGE_TOKEN || '').trim();
  return url && token ? { url, token } : null;
}

/** Whether a direct OpenAI-compatible endpoint is configured. */
function hasOpenAI(llm) {
  return Boolean(llm.baseUrl && llm.model && llm.apiKey);
}

/** Whether the pet has a brain configured. */
function hasBrain(llm) {
  const bridge = dshBridge();
  if (bridge && llm.mode !== 'openai') return true;
  return hasOpenAI(llm);
}

/** Chat through the DSH plugin proxy, including its local tool relay. */
async function chatViaDsh(bridge, messages, cfg, persona, options = {}) {
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const runTool = typeof options.runTool === 'function' ? options.runTool : null;
  const personaText = [persona.system, persona.style].filter(Boolean).join('\n\n');
  const working = Array.isArray(messages) ? [...messages] : [];
  for (let round = 0; round < 3; round += 1) {
    const allowTools = tools.length > 0 && runTool !== null && round < 2;
    const system = allowTools ? personaText + '\n\n' + TOOL_GUIDANCE : personaText;
    const clean = working
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'))
      .map((m) => ({ ...m, content: String(m.content || '') }));
    const payload = {
      messages: clean,
      system,
      maxTokens: cfg.maxTokens,
      temperature: cfg.temperature,
      timeoutMs: cfg.timeoutMs,
    };
    if (allowTools) payload.tools = tools;
    const json = await postJson(bridge.url + '/desktop-butler/chat', payload, {
      apiKey: bridge.token,
      timeoutMs: Math.max(10000, Number(cfg.timeoutMs) || 30000) + 5000,
    });
    if (!json || json.ok === false) throw new VoiceError((json && json.error) || 'DSH 模型没有返回内容');
    const content = String(json.reply || '').trim();
    const calls = Array.isArray(json.tool_calls) ? json.tool_calls : [];
    if (!allowTools || !calls.length) return content || '……';
    working.push({ role: 'assistant', content, tool_calls: calls });
    for (const call of calls.slice(0, 3)) {
      const fn = (call && call.function) || {};
      const name = String(fn.name || '');
      let result;
      try {
        result = await runTool(name, parseArguments(fn.arguments));
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      working.push({ role: 'tool', tool_call_id: call.id || '', content: JSON.stringify(result) });
    }
  }
  return '……';
}

/**
 * Transcribe 16 kHz mono PCM WAV.
 * @param {Buffer} wav
 * @param {object} cfg - the `asr` section.
 * @param {string} platform
 * @returns {Promise<{text: string, mode: string}>}
 */
async function transcribe(wav, cfg, platform = process.platform) {
  if (!wav || wav.length < 1200) throw new VoiceError('没录到声音');
  const mode = asrMode(cfg);
  if (mode === 'cloud') {
    const form = wavForm(
      { model: cfg.model, language: cfg.language, response_format: 'json' },
      wav,
    );
    const res = await request(cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers: {
        'content-type': form.contentType,
        'content-length': form.body.length,
        authorization: 'Bearer ' + cfg.apiKey,
      },
      body: form.body,
      timeoutMs: 30000,
    });
    if (res.status < 200 || res.status >= 300) throw new VoiceError(reasonOf(res));
    let text = '';
    try {
      text = String(JSON.parse(res.buffer.toString('utf8')).text || '');
    } catch {
      text = res.buffer.toString('utf8');
    }
    return { text: text.trim(), mode };
  }
  if (platform !== 'win32') throw new VoiceError('离线识别仅支持 Windows，请配置 asr.apiKey');
  return { text: await transcribeWithSapi(wav, cfg), mode };
}

/** Run the PowerShell recogniser bridge and read back its JSON. */
function transcribeWithSapi(wav, cfg) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'butler-asr-' + process.pid + '-' + Date.now() + '.wav');
    try {
      fs.writeFileSync(tmp, wav);
    } catch (err) {
      reject(new VoiceError('无法写入临时音频：' + err.message));
      return;
    }
    const done = (result) => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* leave it to the OS */
      }
      resolve(result);
    };
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SAPI_SCRIPT,
        '-Wav',
        tmp,
        '-Culture',
        cfg.culture || 'zh-CN',
        '-Phrases',
        JSON.stringify(Array.isArray(cfg.phrases) ? cfg.phrases : []),
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (err.length < 2000) err += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      reject(new VoiceError('离线识别超时'));
    }, 20000);
    timer.unref && timer.unref();
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new VoiceError('无法启动离线识别：' + e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(out).toString('utf8').trim();
      let parsed = null;
      try {
        parsed = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1) || raw);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        reject(new VoiceError('离线识别出错' + (err ? '：' + err.trim().slice(0, 120) : '（退出码 ' + code + '）')));
        return;
      }
      if (!parsed.ok) {
        done('');
        return;
      }
      done(String(parsed.text || '').trim());
    });
  });
}

/** Tool arguments arrive as a JSON string; a malformed one must not throw. */
function parseArguments(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * One chat turn, with optional tool use.
 *
 * Up to two tool rounds, then a hard "answer now" round with no tools offered,
 * so a model that keeps reaching for capabilities still has to speak. The tool
 * exchange is kept in a working copy: history only ever grows with what was
 * actually said, never with the plumbing.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} cfg - the `llm` section.
 * @param {object} persona - the `persona` section.
 * @param {{tools?: object[], runTool?: (name: string, args: object) => Promise<object>}} [options]
 * @returns {Promise<string>}
 */
async function chat(messages, cfg, persona, options = {}) {
  const bridge = dshBridge();
  const wantsTools = Array.isArray(options.tools) && options.tools.length > 0;
  if (bridge && cfg.mode !== 'openai' && !(cfg.mode === 'auto' && wantsTools && hasOpenAI(cfg))) {
    try {
      return await chatViaDsh(bridge, messages, cfg, persona, options);
    } catch (err) {
      if (cfg.mode === 'dsh' || !hasOpenAI(cfg)) throw err;
      // DSH proxy failed: fall back to the locally configured endpoint.
    }
  }
  if (!hasOpenAI(cfg)) {
    throw new VoiceError('还没有接入大脑：请先在 DSH 里配置默认模型，或在 desktop-butler-config.json 填 llm.apiKey');
  }
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const runTool = typeof options.runTool === 'function' ? options.runTool : null;
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const base = {
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    stream: false,
  };
  const personaText = [persona.system, persona.style].filter(Boolean).join('\n\n');
  const system = tools.length ? personaText + '\n\n' + TOOL_GUIDANCE : personaText;
  const working = [{ role: 'system', content: system }, ...messages];

  for (let round = 0; round < 3; round += 1) {
    const allowTools = tools.length > 0 && runTool !== null && round < 2;
    const payload = { ...base, messages: working };
    if (allowTools) {
      payload.tools = tools;
      payload.tool_choice = 'auto';
    }

    const json = await postJson(url, payload, { apiKey: cfg.apiKey, timeoutMs: cfg.timeoutMs });
    const first = Array.isArray(json.choices) ? json.choices[0] : null;
    const message = first && first.message;
    if (!message) throw new VoiceError('模型没有返回内容');

    if (!allowTools) {
      // Final round: whatever it says is the answer.
      const content = String(message.content || '').trim();
      return content || '……';
    }

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      const content = String(message.content || '').trim();
      if (!content) throw new VoiceError('模型没有返回内容');
      return content;
    }

    working.push({
      role: 'assistant',
      content: message.content || '',
      tool_calls: message.tool_calls,
    });

    // Three calls per round is already generous for a spoken sentence.
    for (const call of calls.slice(0, 3)) {
      const fn = (call && call.function) || {};
      const name = String(fn.name || '');
      let result;
      try {
        result = await runTool(name, parseArguments(fn.arguments));
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      working.push({
        role: 'tool',
        tool_call_id: call.id || '',
        content: JSON.stringify(result === undefined ? { ok: false } : result).slice(0, 2000),
      });
    }
  }

  throw new VoiceError('这个请求来回太多轮了');
}

/**
 * Keep a generated line fit for a speech bubble: no name prefix, no wrapping
 * quotes, no hard line breaks. Models like to add "桌面管家：" even when
 * told not to.
 * @param {string} text
 * @returns {string}
 */
function cleanLine(text) {
  let out = String(text || '').trim();
  out = out.replace(/^(?:J\.?A\.?R\.?V\.?I\.?S\.?|桌面管家)\s*[：:]\s*/i, '');
  out = out.replace(/^[「『“"'*]+|[」』”"'*]+$/g, '').trim();
  out = out.replace(/\s*[\r\n]+\s*/g, ' ');
  return out.slice(0, 240);
}

/**
 * One proactive line for 闲聊模式. No tools are offered on purpose: a line the
 * user did not ask for must never touch the machine.
 * @param {object} data - the whole config (`llm`, `persona`, `chitchat`)
 * @param {{recent?: Array<{role: string, content: string}>, topic?: string, timeText?: string, agoText?: string}} [context]
 * @returns {Promise<string>}
 */
async function chitchat(data, context = {}) {
  const llm = data && data.llm;
  const persona = (data && data.persona) || { system: '' };
  const style = (data && data.chitchat) || {};
  if (!hasBrain(llm)) throw new VoiceError('还没有接入大脑：请在 desktop-butler-config.json 填 llm.apiKey');

  const recent = Array.isArray(context.recent) ? context.recent : [];
  const messages = [];
  for (const turn of recent.slice(-6)) {
    const content = turn && typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!content) continue;
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: content.slice(0, 500),
    });
  }

  const nudge = [
    '（闲聊模式：没有人在提问，轮到你先开口。）',
    context.timeText ? '现在的时间是 ' + context.timeText + '。' : '',
    context.agoText ? '距离你们上次互动已经 ' + context.agoText + '。' : '',
    context.topic ? '本轮可以聊：' + context.topic + '（可以忽略）。' : '',
    '请直接说一句自然的话。',
  ]
    .filter(Boolean)
    .join('\n');
  messages.push({ role: 'user', content: nudge });

  const system = [persona.system, CHITCHAT_GUIDANCE, style.system, persona.style].filter(Boolean).join('\n\n');
  const cap = Number(style.maxTokens) || 140;
  const maxTokens = Math.min(Number(llm.maxTokens) || cap, cap);
  const reply = await chat(
    messages,
    {
      ...llm,
      maxTokens,
      temperature: Number.isFinite(Number(style.temperature)) ? Number(style.temperature) : 0.95,
    },
    { ...persona, system },
    {},
  );
  const line = cleanLine(reply);
  if (!line) throw new VoiceError('模型没有给出可说的话');
  return line;
}

/**
 * Synthesise speech. Returns null when the renderer should speak locally.
 * @param {string} text
 * @param {object} cfg - the `tts` section.
 * @returns {Promise<{buffer: Buffer, mime: string}|null>}
 */
async function synthesize(text, cfg) {
  if (ttsMode(cfg) !== 'cloud') return null;
  if (!cfg.baseUrl || !cfg.apiKey) throw new VoiceError('tts.mode 是 cloud，但没填 tts.apiKey');
  const body = Buffer.from(
    JSON.stringify({
      model: cfg.model,
      input: text,
      voice: cfg.voiceId,
      response_format: 'mp3',
    }),
    'utf8',
  );
  const res = await request(cfg.baseUrl.replace(/\/+$/, '') + '/audio/speech', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      authorization: 'Bearer ' + cfg.apiKey,
    },
    body,
    timeoutMs: cfg.timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) throw new VoiceError(reasonOf(res));
  return { buffer: res.buffer, mime: 'audio/mpeg' };
}

module.exports = {
  VoiceError,
  transcribe,
  chat,
  chitchat,
  synthesize,
  hasBrain,
  asrMode,
  ttsMode,
};
