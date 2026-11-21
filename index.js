/**
 * dsh-desktop-butler — Host 半边。
 *
 * 作用：把独立版桌面管家桌宠（E:\deepseek\desktop-butler，纯 Electron 应用）挂进 DSH：
 *   - apply 时拉起 `electron.exe <appDir>/main.js`，插件卸载 / DSH 退出时 taskkill 整棵进程树；
 *   - 在 DSH WebServer 上挂 `/desktop-butler/*` 路由，给设置页（client.js）读状态、启停、改模型密钥；
 *   - 监听 DSH 会话事件，把「思考 / 干活 / 等确认 / 完成 / 出错」写进桌宠的
 *     `data/work-status.json`，桌宠轮询后播放对应动作（金色全息球形象不变）；
 *   - 配置直接写独立版自己的 `desktop-butler-config.json`（独立版仍可单独启动，互不冲突：
 *     它自带 single-instance lock，插件拉起的和手动启动的只会存在一个）。
 *
 * 设计取舍：
 *   - 不在插件里保存密钥：密钥本来就属于独立版配置，写回原文件，独立版下次照旧能读；
 *   - 不做"崩溃自动重启"：用户可能从托盘菜单主动退出，反复拉起会显得像灵异事件；
 *     DSH 下次启动会重新拉起，设置页也有「启动」按钮。
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GOAL_UPDATE_TOOL,
  WorkStatusStore,
  currentTaskFromTodo,
  goalUpdateAction,
  reduceWorkStatus,
} from './work-status.js';
import { EdgeSpeaker } from './voice-bridge.js';

/** 插件包目录（用于兜底找独立版：同级的 ../desktop-butler） */
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
/** 本插件占用的 HTTP 前缀 */
const ROUTE = '/desktop-butler';
/** 默认的独立版目录；install 后可用插件行 config.appDir 覆盖 */
const DEFAULT_APP_DIR = join(PKG_DIR, 'pet');

const state = {
  child: null,
  appDir: '',
  electron: '',
  lastError: '',
  startedAt: 0,
  /** true = 这次退出是我们自己 taskkill 的，不当作"异常退出"记进 lastError */
  stopping: false,
  /** 最近一次写给桌宠的工作状态（/status 里回显，便于排查） */
  work: { state: null, task: null, ts: 0, seq: 0 },
  /** 桌宠回调本插件语音路由用的 DSH 地址 */
  bridgeUrl: 'http://127.0.0.1:62012',
  bridgeToken: '',
};

const log = (...args) => console.error('[desktop-butler]', ...args);

/** Edge 神经语音：连接在插件进程里复用，卸载时关闭 */
const edgeSpeaker = new EdgeSpeaker({ log });
/** 当前 apply 的 Cordis 上下文，路由里用它取 speechToText 服务（可能晚于插件挂载） */
let pluginCtx = null;

/** 字符串化（配置里可能是 undefined / 数字） */
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * 找 electron 可执行文件：显式配置 > DSH 自带运行时 > 常见安装位。
 * @param {string | undefined} explicit - 插件行 config.electronPath
 * @returns {string} 找到的绝对路径；找不到返回空串
 */
function detectElectron(explicit) {
  const candidates = [
    str(explicit),
    str(process.env.DESKTOP_BUTLER_PET_ELECTRON),
    join(homedir(), '.dsh', 'electron', 'electron.exe'),
    join(str(process.env.LOCALAPPDATA), 'Programs', 'dsh', 'electron.exe'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return '';
}

/** 独立版目录：配置 > 同级目录 > 默认值 */
function prepareBundledApp(bundled) {
  const runtime = join(homedir(), '.dsh', 'desktop-butler-app');
  mkdirSync(runtime, { recursive: true });
  const bundledPkg = join(bundled, 'package.json');
  const runtimePkg = join(runtime, 'package.json');
  let bundledVer = '';
  let runtimeVer = '';
  try { bundledVer = JSON.parse(readFileSync(bundledPkg, 'utf8')).version || ''; } catch {}
  try { runtimeVer = JSON.parse(readFileSync(runtimePkg, 'utf8')).version || ''; } catch {}
  if (!existsSync(join(runtime, 'main.js')) || bundledVer !== runtimeVer) {
    cpSync(bundled, runtime, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = src.slice(bundled.length).replace(/^[\\/]+/, '');
        return rel !== 'data' && !rel.startsWith('data\\') && !rel.startsWith('data/') && rel !== 'desktop-butler-config.json';
      },
    });
  }
  const config = join(runtime, 'desktop-butler-config.json');
  if (!existsSync(config)) {
    try { cpSync(join(bundled, 'desktop-butler-config.json'), config); } catch {}
  }
  return resolve(runtime);
}

function resolveAppDir(configured) {
  const configuredDir = str(configured);
  if (configuredDir && existsSync(join(configuredDir, 'main.js'))) return resolve(configuredDir);
  const bundled = join(PKG_DIR, 'pet');
  if (existsSync(join(bundled, 'main.js'))) return prepareBundledApp(bundled);
  const sibling = resolve(PKG_DIR, '..', 'desktop-butler');
  if (existsSync(join(sibling, 'main.js'))) return sibling;
  return resolve(configuredDir || DEFAULT_APP_DIR);
}

const configFile = () => join(state.appDir, 'desktop-butler-config.json');

/** 读 JSON（容忍 BOM 与坏文件） */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

/** 暴露给设置页的配置（绝不回传 apiKey 原文，只回传是否已设置） */
function dshLlmInfo(ctx = pluginCtx) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null;
  let provider = '';
  let model = '';
  let error = '';
  if (!llm) {
    error = 'DSH LLM 服务不可用';
  } else {
    try {
      const def = ctx.get('agentDefaultModel');
      const sel = def && typeof def.currentSelection === 'function' ? def.currentSelection() : null;
      if (sel && sel.provider && sel.model) { provider = sel.provider; model = sel.model; }
    } catch {}
    if (!provider) {
      try {
        const agents = ctx.get('agents');
        const list = agents && typeof agents.list === 'function' ? agents.list() : [];
        for (const agent of list) {
          const sel = agent && agent.model && typeof agent.model.current === 'function' ? agent.model.current() : null;
          if (sel && sel.provider && sel.model) { provider = sel.provider; model = sel.model; break; }
        }
      } catch {}
    }
    if (!provider) error = 'DSH 还没有可用的默认模型';
  }
  return { available: Boolean(llm && provider && model), provider, model, error };
}

function publicConfig() {
  const raw = readJson(configFile());
  const llm = raw.llm && typeof raw.llm === 'object' ? raw.llm : {};
  const tts = raw.tts && typeof raw.tts === 'object' ? raw.tts : {};
  const asr = raw.asr && typeof raw.asr === 'object' ? raw.asr : {};
  const chitchat = raw.chitchat && typeof raw.chitchat === 'object' ? raw.chitchat : {};
  const persona = raw.persona && typeof raw.persona === 'object' ? raw.persona : {};
  const ttsMode = str(tts.mode) || 'edge';
  const edgeVoice = str(tts.edgeVoice) || 'zh-CN-YunxiNeural';
  const edgeRate = str(tts.edgeRate) || '+2%';
  const edgePitch = str(tts.edgePitch) || '+0Hz';
  const voicePack = ttsMode !== 'edge'
    ? 'custom'
    : edgeVoice === 'zh-CN-YunjianNeural' && edgeRate === '-4%' && edgePitch === '-3Hz'
      ? 'cn-dub'
      : edgeVoice === 'zh-CN-YunxiNeural' && edgeRate === '+2%' && edgePitch === '+0Hz'
        ? 'default'
        : 'custom';
  return {
    dshLlm: dshLlmInfo(),
    llm: {
      baseUrl: str(llm.baseUrl),
      model: str(llm.model),
      hasKey: str(llm.apiKey).trim() !== '',
    },
    tts: {
      mode: ttsMode,
      edgeVoice,
      edgeRate,
      edgePitch,
    },
    persona: { style: str(persona.style) },
    asr: { mode: str(asr.mode) || 'auto' },
    chitchat: {
      enabled: chitchat.enabled === true,
      minIntervalSec: Number(chitchat.minIntervalSec) || 90,
      maxIntervalSec: Number(chitchat.maxIntervalSec) || 210,
      maxPerHour: Number(chitchat.maxPerHour) || 20,
      speak: chitchat.speak !== false,
    },
    voicePack,
  };
}

/**
 * 把设置页提交的字段合并回 desktop-butler-config.json（保留文件里其它字段与注释性 _help 数组）。
 * 传空字符串的 apiKey 视为"清除"（独立版对空 key 的语义就是没有大脑）。
 * @param {Record<string, unknown>} body - { llm?: {...}, tts?: {...}, asr?: {...} }
 */
function saveConfig(body) {
  const current = readJson(configFile());
  const next = { ...current };
  for (const key of ['llm', 'asr', 'tts', 'voice', 'persona', 'chitchat']) {
    const patch = body && typeof body[key] === 'object' && body[key] !== null ? body[key] : null;
    if (!patch) continue;
    const base = current[key] && typeof current[key] === 'object' ? current[key] : {};
    next[key] = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      next[key][k] = v;
    }
  }
  writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return publicConfig();
}

const isRunning = () => Boolean(state.child && state.child.exitCode === null && !state.child.killed);

/** 拉起独立版。已在运行则原样返回（幂等，设置页重复点「启动」不会起两个）。 */
function start() {
  if (isRunning()) return { ok: true, running: true, pid: state.child.pid, already: true };
  if (!existsSync(join(state.appDir, 'main.js'))) {
    state.lastError = '找不到独立版应用：' + state.appDir;
    return { ok: false, error: state.lastError };
  }
  if (!state.electron) {
    state.lastError = '找不到 electron.exe（可用插件行 config.electronPath 指定）';
    return { ok: false, error: state.lastError };
  }
  const env = { ...process.env };
  // DSH 环境可能导出 ELECTRON_RUN_AS_NODE=1，那会让 Electron 以 Node 模式启动、不开窗。
  delete env.ELECTRON_RUN_AS_NODE;
  // 桌宠用这个地址回调 /desktop-butler/transcribe|speak；手动启动时用 desktop-butler-config.json 里的 bridge.baseUrl。
  env.DESKTOP_BUTLER_DSH_URL = state.bridgeUrl;
  env.DESKTOP_BUTLER_BRIDGE_TOKEN = state.bridgeToken;
  const child = spawn(state.electron, [join(state.appDir, 'main.js')], {
    cwd: state.appDir,
    env,
    stdio: 'ignore',
    windowsHide: false,
  });
  state.child = child;
  state.startedAt = Date.now();
  state.lastError = '';
  child.on('error', (e) => {
    state.lastError = e instanceof Error ? e.message : String(e);
    log('spawn failed:', state.lastError);
  });
  child.on('exit', (code, signal) => {
    if (state.child === child) state.child = null;
    if (state.stopping) {
      state.stopping = false;
    } else if (code !== 0) {
      state.lastError = '桌宠进程退出：' + String(code ?? signal);
    }
    log('pet exited:', code, signal);
  });
  log('pet started pid=' + child.pid);
  return { ok: true, running: true, pid: child.pid };
}

/** 关掉独立版：taskkill /T 连渲染进程一起收，避免留下孤儿托盘图标。 */
function stop() {
  const child = state.child;
  state.child = null;
  if (!child || !child.pid || child.exitCode !== null) return { ok: true, running: false };
  state.stopping = true;
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e);
    log('taskkill failed:', state.lastError);
  }
  return { ok: true, running: false };
}

function restart() {
  stop();
  return start();
}

/** 状态快照 */
function statusPayload() {
  const running = isRunning();
  return {
    ok: true,
    running,
    pid: running ? state.child.pid : 0,
    appDir: state.appDir,
    electron: state.electron,
    configPath: configFile(),
    lastError: state.lastError,
    startedAt: state.startedAt,
    config: publicConfig(),
    workStatus: state.work,
    bridgeUrl: state.bridgeUrl,
    voice: {
      asr: Boolean(pluginCtx && pluginCtx.get('speechToText')),
      edge: edgeSpeaker.available(),
      edgeError: edgeSpeaker.available() ? '' : edgeSpeaker.lastError(),
    },
  };
}

// ------------------------------------------------- DSH 工作状态 → 桌宠动作 --

/** 桌宠每 600ms 轮询这个文件；插件只在状态变化时重写，外加 15s 心跳 */
const WORK_FILE = 'work-status.json';
/** 状态持续时多久刷新一次 ts（桌宠超过 45s 没见到新 ts 就当空闲） */
const WORK_HEARTBEAT_MS = 15000;
/** 完成 / 出错这类终态保留多久，之后自动回空闲 */
const WORK_TERMINAL_MS = 20000;

const workStatusFile = () => join(state.appDir, 'data', WORK_FILE);

/**
 * 把 DSH 的 `session/event` 压缩成 6 个档位，写到桌宠的 `data/work-status.json`。
 *
 * 桌宠是独立 Electron 进程，最省事、也不引入监听端口的桥就是文件：
 * 插件写（原子替换），桌宠 poll；两边都没有新增网络面。
 *
 * @param ctx - Cordis 上下文（用 ctx.on 监听宿主事件）
 * @returns {() => void} dispose
 */
function setupWorkStatus(ctx) {
  const store = new WorkStatusStore();
  const flags = new Map();
  const timers = new Map();
  let sequence = 0;
  let heartbeat = null;
  let disposed = false;

  function write(snapshot) {
    try {
      const file = workStatusFile();
      mkdirSync(dirname(file), { recursive: true });
      const now = Date.now();
      sequence += 1;
      const body = JSON.stringify({
        seq: sequence,
        ts: now,
        state: snapshot && snapshot.state ? snapshot.state : null,
        task: snapshot && snapshot.task ? snapshot.task : null,
      });
      const tmp = file + '.tmp';
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, file);
      state.work = {
        state: snapshot && snapshot.state ? snapshot.state : null,
        task: snapshot && snapshot.task ? snapshot.task : null,
        ts: now,
        seq: sequence,
      };
    } catch (err) {
      log('work-status write failed:', err instanceof Error ? err.message : String(err));
    }
  }

  function armHeartbeat() {
    const active = Boolean(store.snapshot().state);
    if (active && !heartbeat) {
      heartbeat = setInterval(() => {
        if (!disposed) write(store.snapshot());
      }, WORK_HEARTBEAT_MS);
      if (heartbeat.unref) heartbeat.unref();
    } else if (!active && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function publish() {
    if (disposed) return;
    write(store.snapshot());
    armHeartbeat();
  }

  function cancelCleanup(id) {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  function scheduleCleanup(id) {
    if (timers.has(id)) return;
    const timer = setTimeout(() => {
      timers.delete(id);
      if (disposed) return;
      if (store.clear(id)) publish();
      else armHeartbeat();
    }, WORK_TERMINAL_MS);
    if (timer.unref) timer.unref();
    timers.set(id, timer);
  }

  function sessionIdOf(session) {
    return String(
      (session && session.header && session.header.id) || (session && session.id) || 'unknown',
    );
  }

  function onSessionEvent(session, event) {
    if (disposed) return;
    const type = event && event.type;
    if (!type) return;
    const id = sessionIdOf(session);

    if (type === 'todo/write') {
      // 任务文案只更新已有活动条目的会话：没在展示的会话写进去只会变成幽灵文案。
      if (store.has(id) && store.setTask(id, currentTaskFromTodo(event))) publish();
      return;
    }

    if (type === 'user/message') {
      // goal 自动续跑轮：它的 turn/end completed 只是本轮完成，不等于整个目标完成。
      const source = event.data && event.data.source;
      if (source && source.kind === 'goal') {
        const flag = flags.get(id) || { goalRound: false, closing: null };
        flag.goalRound = true;
        flags.set(id, flag);
      }
      return;
    }

    if (type === 'turn/start') {
      flags.set(id, { goalRound: false, closing: null });
      if (store.setTask(id, null)) publish();
    }

    if (
      type === 'tool/call' &&
      String((event.data && event.data.name) || '') === GOAL_UPDATE_TOOL
    ) {
      const action = goalUpdateAction(String((event.data && event.data.arguments) || ''));
      if (action) {
        const flag = flags.get(id) || { goalRound: false, closing: null };
        flag.closing = action;
        flags.set(id, flag);
      }
    }

    const next = reduceWorkStatus(event, flags.get(id));
    if (!next) {
      // turn/end 的 null（aborted 等）= 这一轮结束了：清掉会话，回到空闲或让位给其他会话。
      if (type === 'turn/end') {
        flags.delete(id);
        cancelCleanup(id);
        if (store.clear(id)) publish();
      }
      return;
    }

    const seq = Number(event.seq) || 0;
    if (!store.setState(id, next, seq)) return;
    publish();
    if (next === 'success' || next === 'error') scheduleCleanup(id);
    else cancelCleanup(id);
  }

  function onAgentError() {
    if (disposed) return;
    // 无会话位置的生成失败：单独一条合成会话，跟普通回合一样保留 20 秒。
    const id = '__agent__';
    if (!store.setState(id, 'error', Date.now())) return;
    publish();
    scheduleCleanup(id);
  }

  const offSession = ctx.on('session/event', onSessionEvent);
  let offError = null;
  try {
    offError = ctx.on('agent/error', onAgentError);
  } catch {
    // 旧版 DSH 没有 agent/error：turn/end error 已经覆盖大部分失败。
  }
  publish(); // 启动先写空闲，清掉上次可能残留的状态

  return () => {
    disposed = true;
    offSession();
    if (offError) offError();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    write({ state: null, task: null });
  };
}

/** 读请求体（限 64 KiB） */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 取 DSH 语音识别服务；插件可能早于/晚于它挂载，所以每次请求现取 */
function dshSpeech(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null;
  try {
    return ctx.get('speechToText') || null;
  } catch {
    return null;
  }
}

/**
 * 用 DSH 内置识别（SenseVoice）转写 16kHz mono PCM16 WAV。
 * @param ctx - Cordis 上下文
 * @param {Buffer} audio - 完整 WAV
 * @param {string} [language]
 * @returns {Promise<{text: string, audioSeconds?: number}>}
 */
async function transcribeWithDsh(ctx, audio, language) {
  const service = dshSpeech(ctx);
  if (!service) throw new Error('DSH 语音识别未启用（speechToText 服务不可用）');
  if (!audio || audio.length < 1200) throw new Error('录音太短');
  const request = { audio: new Uint8Array(audio) };
  if (language) request.language = String(language);
  const spec = service.resolve(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const result = await service.transcribe(spec, controller.signal);
    return {
      text: String((result && result.text) || ''),
      audioSeconds: result && result.audioSeconds,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `/desktop-butler/*` 的小路由器 */
export async function dshChat(body, ctx = pluginCtx) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : null;
  if (!llm) throw new Error('DSH LLM 服务不可用');
  const info = dshLlmInfo(ctx);
  if (!info.available) throw new Error(info.error || 'DSH 还没有可用的默认模型');
  let text = '';
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of rawMessages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? '助手' : message.role === 'user' ? '用户' : message.role === 'tool' ? '工具结果' : '';
    const content = typeof message.content === 'string' ? message.content : '';
    if (!role) continue;
    if (content.trim()) text += role + '：' + content.trim() + '\n\n';
    if (role === '助手' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const fn = call && call.function ? call.function : {};
        text += '调用工具：' + String(fn.name || '') + '(' + String(fn.arguments || '') + ')\n\n';
      }
    }
  }
  if (!text.trim()) throw new Error('没有可发送的对话内容');
  const rawTools = Array.isArray(body.tools) ? body.tools : [];
  const tools = [];
  for (const item of rawTools) {
    const fn = item && item.function ? item.function : null;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    tools.push({
      name: fn.name.trim(),
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  const system = String(body.system || '').slice(0, 16000);
  const maxTokens = Math.max(32, Math.min(2048, Number(body.maxTokens) || 260));
  const temperature = Math.max(0, Math.min(2, Number(body.temperature) || 0.7));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Math.min(120000, Number(body.timeoutMs) || 30000)));
  let reply = '';
  const calls = new Map();
  try {
    const options = {
      provider: info.provider,
      model: info.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: text.trim() }] }],
      maxTokens,
      temperature,
      signal: controller.signal,
    };
    if (tools.length) options.tools = tools;
    for await (const chunk of llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') reply += chunk.text;
      else if (chunk.type === 'tool-call-delta') {
        const index = Number.isInteger(chunk.index) ? chunk.index : 0;
        const call = calls.get(index) || { id: '', name: '', arguments: '' };
        if (chunk.id) call.id = String(chunk.id);
        if (chunk.name) call.name = String(chunk.name);
        if (chunk.argumentsDelta) call.arguments += String(chunk.argumentsDelta);
        calls.set(index, call);
      } else if (chunk.type === 'finish') {
        const reason = chunk.reason || {};
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          throw new Error((reason.failure && reason.failure.message) || '模型调用失败');
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  reply = reply.trim();
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], index) => ({
      id: call.id || 'call_' + index,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' },
    }))
    .filter((call) => call.function.name);
  if (!reply && !toolCalls.length) throw new Error('模型没有返回内容');
  return { reply, tool_calls: toolCalls, provider: info.provider, model: info.model };
}

async function handleRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (path === ROUTE + '/chat' && method === 'POST') {
      const auth = String(req.headers && req.headers.authorization || '');
      if (!state.bridgeToken || auth !== 'Bearer ' + state.bridgeToken) {
        return sendJson(res, 401, { ok: false, error: '未授权的桌宠请求' });
      }
      const raw = await readBody(req, 256 * 1024);
      let body = {};
      try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      try {
        const result = await dshChat(body);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        log('dsh chat failed:', e instanceof Error ? e.message : String(e));
        return sendJson(res, 503, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === ROUTE + '/status' && method === 'GET') return sendJson(res, 200, statusPayload());
    if (path === ROUTE + '/start' && method === 'POST') return sendJson(res, 200, start());
    if (path === ROUTE + '/stop' && method === 'POST') return sendJson(res, 200, stop());
    if (path === ROUTE + '/restart' && method === 'POST') return sendJson(res, 200, restart());
    if (path === ROUTE + '/voice-status' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        asr: Boolean(dshSpeech(pluginCtx)),
        edge: edgeSpeaker.available(),
        bridgeUrl: state.bridgeUrl,
      });
    }
    if (path === ROUTE + '/transcribe' && method === 'POST') {
      const text = await readBody(req, 8 * 1024 * 1024);
      let body = {};
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
      }
      const audio = Buffer.from(str(body.audioBase64) || str(body.audio), 'base64');
      if (audio.length < 1200) return sendJson(res, 400, { ok: false, error: '录音太短' });
      try {
        const result = await transcribeWithDsh(pluginCtx, audio, body.language);
        return sendJson(res, 200, { ok: true, engine: 'dsh', text: result.text, audioSeconds: result.audioSeconds });
      } catch (e) {
        log('transcribe failed:', e instanceof Error ? e.message : String(e));
        return sendJson(res, 503, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === ROUTE + '/speak' && method === 'POST') {
      const text = await readBody(req, 256 * 1024);
      let body = {};
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
      }
      try {
        const spoken = await edgeSpeaker.synthesize(String(body.text || ''), {
          voice: body.voice,
          rate: body.rate,
          pitch: body.pitch,
          volume: body.volume,
        });
        return sendJson(res, 200, {
          ok: true,
          engine: 'edge',
          mime: spoken.mime,
          audio: spoken.buffer.toString('base64'),
        });
      } catch (e) {
        log('edge speak failed:', e instanceof Error ? e.message : String(e));
        return sendJson(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === ROUTE + '/music' && method === 'POST') {
      const text = await readBody(req, 32 * 1024);
      let body = {};
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'JSON 瑙ｆ瀽澶辫触' });
      }
      const action = String(body.action || 'play').trim();
      const query = String(body.query || '').trim();
      const source = String(body.source || '').trim();
      const tools = pluginCtx && typeof pluginCtx.get === 'function' ? pluginCtx.get('tools') : undefined;
      const definition = tools && typeof tools.get === 'function' ? tools.get('music_control') : undefined;
      if (!definition || typeof definition.execute !== 'function') {
        return sendJson(res, 503, { ok: false, error: 'DSH 音乐面板插件没有启用' });
      }
      try {
        const queued = await definition.execute(
          { action, query, source },
          { signal: new AbortController().signal },
        );
        return sendJson(res, 200, {
          ok: true,
          queued: Boolean(queued && queued.queued),
          action,
          query,
          source: (queued && queued.source) || source || 'local',
        });
      } catch (e) {
        log('music control failed:', e instanceof Error ? e.message : String(e));
        return sendJson(res, 502, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (path === ROUTE + '/config' && method === 'GET') return sendJson(res, 200, { ok: true, config: publicConfig() });
    if (path === ROUTE + '/config' && (method === 'PUT' || method === 'POST')) {
      const text = await readBody(req);
      let body = {};
      try {
        body = text.trim() ? JSON.parse(text) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
      }
      const config = saveConfig(body);
      // 独立版只在启动时读配置：保存后重启一次，用户不必再去找托盘里的「重新载入」。
      if (isRunning()) restart();
      return sendJson(res, 200, { ok: true, config, restarted: true });
    }
    return sendJson(res, 404, { ok: false, error: '没有这条路由：' + path });
  } catch (e) {
    log('route failed:', e);
    return sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export const name = 'desktop-butler';
export const inject = ['webServer'];

/**
 * Cordis 插件入口。
 * @param ctx - DSH 注入的上下文（webServer）
 * @param config - 插件行 config：{ appDir?, electronPath?, autoStart?, workStatus?, bridgeUrl? }
 */
export function apply(ctx, config = {}) {
  state.appDir = resolveAppDir(config.appDir);
  state.electron = detectElectron(config.electronPath);
  // 用 WebServer 的真实监听地址：DSH 的端口会变，环境变量里的 DSH_WEB_URL 可能是旧值。
  let origin = '';
  try {
    origin = ctx.webServer.getOrigin();
  } catch {
    /* 还没 bind 完就回落到配置/环境变量 */
  }
  state.bridgeUrl = (origin || str(config.bridgeUrl) || str(process.env.DSH_WEB_URL) || 'http://127.0.0.1:62012').replace(/\/+$/, '');
  pluginCtx = ctx;
  state.bridgeToken = randomUUID();
  log('appDir=' + state.appDir + ' electron=' + (state.electron || '(未找到)') + ' bridge=' + state.bridgeUrl);

  ctx.effect(
    () => () => {
      if (pluginCtx === ctx) pluginCtx = null;
      edgeSpeaker.dispose();
    },
    'desktop-butler: voice bridge cleanup',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: (req, res) => {
          void handleRoute(req, res);
        },
      }),
    'desktop-butler: http routes',
  );

  // 工作状态联动：DSH 在思考 / 干活 / 等人确认 / 完成 / 出错时，桌宠做对应动作。
  // 插件行 config.workStatus = false 可关掉（关掉后不再监听，也不再写状态文件）。
  if (config.workStatus !== false) {
    ctx.effect(() => setupWorkStatus(ctx), 'desktop-butler: DSH work status bridge');
  }

  ctx.effect(() => {
    if (config.autoStart !== false) {
      const result = start();
      if (result.ok === false) log('autoStart failed:', result.error);
    }
    return () => {
      stop();
    };
  }, 'desktop-butler: desktop pet lifecycle');
}
