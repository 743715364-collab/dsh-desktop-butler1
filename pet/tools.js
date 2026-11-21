/*
 * 桌面管家 — the hands.
 *
 * Seven narrow, parameterised tools instead of a pile of fixed macros: the model
 * names an intent, this module turns a loose human word ("网易云", "浏览器",
 * "声音小一点") into a concrete target, and only then touches the machine.
 *
 * The interesting work is the resolver, not the call: an app name has to be
 * matched against ~300 Start-menu entries, and a mismatch has to come back as a
 * question rather than as a wrong window opening.
 *
 * Nothing here runs arbitrary commands: every PowerShell argument is a constant
 * or a value taken from our own index / process list.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPTS = {
  apps: path.join(__dirname, 'tools', 'apps.ps1'),
  media: path.join(__dirname, 'tools', 'media.ps1'),
  volume: path.join(__dirname, 'tools', 'volume.ps1'),
};

/** Process names that must never be asked to close. */
const DENY = new Set([
  'explorer',
  'dwm',
  'csrss',
  'winlogon',
  'services',
  'lsass',
  'smss',
  'svchost',
  'runtimebroker',
  'textinputhost',
  'conhost',
  'shellexperiencehost',
  'searchhost',
  'startmenuexperiencehost',
  'sihost',
  'fontdrvhost',
  'system',
  'registry',
  'electron',
]);

/**
 * Colloquial names people actually say, mapped to a distinctive fragment of the
 * real Start-menu name. Without this "打开浏览器" matches nothing.
 */
const ALIASES = new Map([
  ['浏览器', ['Edge', 'Chrome', 'Firefox', '浏览器']],
  ['上网', ['Edge', 'Chrome', 'Firefox']],
  ['编辑器', ['Visual Studio Code', 'Code', 'Sublime', 'Notepad++']],
  ['写代码', ['Visual Studio Code', 'Code']],
  ['播放器', ['网易云音乐', 'QQ音乐', 'Spotify', 'PotPlayer', 'foobar2000']],
  ['音乐', ['网易云音乐', 'QQ音乐', 'Spotify']],
  ['听歌', ['网易云音乐', 'QQ音乐', 'Spotify']],
  ['终端', ['Windows Terminal', 'PowerShell', '命令提示符', 'cmd']],
  ['命令行', ['Windows Terminal', 'PowerShell', '命令提示符']],
  ['记事本', ['记事本', 'Notepad']],
  ['计算器', ['计算器', 'Calculator']],
  ['资源管理器', ['文件资源管理器', 'Explorer']],
  ['任务管理器', ['任务管理器', 'Task Manager']],
  ['截图', ['截图工具', 'Snipping Tool']],
  ['微信', ['微信', 'WeChat']],
  ['qq', ['QQ']],
  ['钉钉', ['钉钉', 'DingTalk']],
  ['网盘', ['百度网盘', '阿里云盘', 'OneDrive']],
  ['邮箱', ['邮件', 'Mail', 'Outlook']],
  ['日历', ['日历', 'Calendar']],
  ['商店', ['Microsoft Store', '应用商店']],
  // League of Legends is installed as "英雄联盟WeGame版" here; accept the
  // English name, the acronym and the client process names in both directions.
  ['leagueoflegends', ['英雄联盟', 'League of Legends', 'LeagueClient']],
  ['leagueoflegend', ['英雄联盟', 'League of Legends', 'LeagueClient']],
  ['league', ['英雄联盟', 'League of Legends', 'LeagueClient']],
  ['lol', ['英雄联盟', 'League of Legends', 'LeagueClient']],
  ['英雄联盟', ['英雄联盟', 'League of Legends', 'LeagueClient']],
  ['撸啊撸', ['英雄联盟', 'League of Legends']],
]);

/** Run one of the bundled PowerShell helpers and parse its JSON line. */
function runPs(script, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      resolve(null);
      return;
    }
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
      resolve(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8');
      resolve(parseJson(text) ?? (err ? { ok: false, error: err.trim().slice(0, 200) } : null));
    });
  });
}

/** PowerShell likes to prepend noise; take the trailing JSON document that parses. */
function parseJson(text) {
  const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to line scanning */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Lower-case, strip punctuation and spaces so "Visual Studio Code" ≈ "vscode". */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_·.,，。:：()（）[\]【】"'“”]+/g, '');
}

/** Strip a spoken command wrapper so "关闭英雄联盟" also matches "英雄联盟". */
function stripCommand(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(请|麻烦|帮我|给我|把|将|关闭|关掉|关一下|退出|打开|开一下|启动)\s*/g, '');
  s = s.replace(/(?:关掉|关闭|退出|打开|一下|吧|了|关|掉)+$/g, '').trim();
  return s || String(text || '').trim();
}

function scoreName(name, query) {
  const n = normalize(name);
  const q = normalize(query);
  if (!n || !q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 86;
  if (n.includes(q)) return 72;
  // "打开网易云音乐播放器" contains "网易云音乐"; short names like "qq" must not
  // swallow a longer, different query ("qq音乐" is not QQ).
  if (q.includes(n) && n.length >= 3) return 58;
  const words = String(name)
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  if (words.length > 1) {
    const acronym = words.map((word) => word[0]).join('').toLowerCase();
    if (acronym && acronym === q) return 64;
    if (acronym.length >= 2 && acronym.startsWith(q) && q.length >= 2) return 50;
  }
  return 0;
}

/** Drop uninstallers and control-panel stubs nobody means by "打开". */
function isNoise(name) {
  return /^卸载|^uninstall|^remove |^删除/i.test(String(name).trim());
}

const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Installed-app index: Start-menu entries plus packaged apps, cached on disk. */
async function appIndex(appRoot, options = {}) {
  const file = path.join(appRoot, 'data', 'app-index.json');
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    cached = null;
  }
  const fresh =
    cached && Array.isArray(cached.entries) && Date.now() - Number(cached.at || 0) < INDEX_TTL_MS;
  if (!options.refresh && fresh && cached.entries.length) return cached.entries;

  const raw = await runPs(SCRIPTS.apps, ['-Mode', 'list'], 45000);
  const entries = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || !item.name || !item.id) continue;
    const name = String(item.name).trim();
    if (!name || isNoise(name)) continue;
    const id = String(item.id);
    const key = normalize(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = /^[a-z]:\\.*\.exe$/i.test(id) ? 'exe' : /\.lnk$/i.test(id) ? 'lnk' : 'aumid';
    entries.push({ name, id, kind });
  }

  if (entries.length) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), entries }), 'utf8');
    } catch {
      /* cache is an optimisation only */
    }
    return entries;
  }
  return cached && Array.isArray(cached.entries) ? cached.entries : [];
}

/** Rank the index against a looser human phrase, alias table included. */
function matchApps(entries, query) {
  const q = stripCommand(query);
  if (!q) return [];
  const scored = new Map();
  for (const entry of entries) {
    const score = scoreName(entry.name, q);
    if (score > 0) scored.set(entry, score);
  }
  const hints = ALIASES.get(q) || ALIASES.get(normalize(q));
  if (hints) {
    for (const hint of hints) {
      const target = normalize(hint);
      for (const entry of entries) {
        if (normalize(entry.name).includes(target)) {
          scored.set(entry, Math.max(scored.get(entry) || 0, 88));
        }
      }
    }
  }
  return [...scored.entries()]
    .map(([entry, score]) => ({ entry, score }))
    .sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
}

async function openApp(query, ctx) {
  const entries = await appIndex(ctx.appRoot);
  if (!entries.length) return { ok: false, error: '读不到已安装软件清单' };
  const ranked = matchApps(entries, query);
  if (!ranked.length) return { ok: false, error: '没有找到叫「' + query + '」的软件' };

  const best = ranked[0];
  // A close call between two different apps is a question, not a guess.
  const rivals = ranked.filter((item) => item.score >= best.score - 6).slice(0, 4);
  if (rivals.length > 1 && rivals[1].score >= best.score - 6 && best.score < 100) {
    return {
      ok: false,
      ambiguous: rivals.map((item) => item.entry.name),
      message: '有多个候选：' + rivals.map((item) => item.entry.name).join('、'),
    };
  }

  const result = await runPs(SCRIPTS.apps, [
    '-Mode',
    'launch',
    '-Target',
    best.entry.id,
    '-Kind',
    best.entry.kind,
  ]);
  if (!result || result.ok !== true) {
    return { ok: false, error: (result && result.error) || '启动失败' };
  }
  return { ok: true, message: '已打开 ' + best.entry.name };
}

async function listWindows() {
  const raw = await runPs(SCRIPTS.apps, ['-Mode', 'windows']);
  return Array.isArray(raw) ? raw : [];
}

/** Alias fragments for a query, in either the raw or normalized spelling. */
function aliasHints(query) {
  return ALIASES.get(String(query || '').trim()) || ALIASES.get(normalize(query)) || [];
}

/** True when a name/process/title refers to the League of Legends client. */
function isLeagueName(text) {
  const n = normalize(text);
  return (
    n.includes('leagueoflegends') ||
    n.includes('leagueclient') ||
    n === 'lol' ||
    n.includes('英雄联盟') ||
    n.includes('撸啊撸')
  );
}

/**
 * Rank running windows for a voice close command.
 * The query and every alias fragment are tried against process name and title.
 * @param {Array<{pid: number, process: string, title: string}>} windows
 * @param {string} query
 * @returns {Array<{win: object, score: number}>}
 */
function matchWindows(windows, query) {
  const cleaned = stripCommand(query);
  const q = normalize(cleaned);
  if (!q) return [];
  const needles = [...new Set([q, ...aliasHints(cleaned).map(normalize).filter(Boolean)])];
  const ranked = [];
  for (const win of windows) {
    const process = String(win.process || '');
    const title = String(win.title || '');
    if (DENY.has(process.toLowerCase())) continue;
    const p = normalize(process);
    const t = normalize(title);
    let score = 0;
    for (const needle of needles) {
      if (p === needle) score = Math.max(score, 100);
      else if (p.includes(needle)) score = Math.max(score, 76);
      else if (t.includes(needle)) score = Math.max(score, 68);
    }
    if (score > 0) ranked.push({ win, score });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.win.title || '').length - String(b.win.title || '').length);
  return ranked;
}

async function closeApp(query) {
  const windows = await listWindows();
  if (!windows.length) return { ok: false, error: '没有找到可关闭的窗口' };
  const ranked = matchWindows(windows, query);
  if (!ranked.length) return { ok: false, error: '没有正在运行的「' + query + '」' };
  const target = ranked[0].win;
  const league = isLeagueName(query) || isLeagueName(target.process) || isLeagueName(target.title);

  if (league) {
    // The League client is anti-cheat protected: it ignores WM_CLOSE/Alt+F4 and
    // synthetic clicks, and its backend denies TerminateProcess. The supported
    // route is its own exit panel; bring it forward and let the user confirm.
    const shown = await runPs(SCRIPTS.apps, ['-Mode', 'league-exit', '-ProcId', String(target.pid)], 15000);
    if (shown && shown.alive === false) return { ok: true, message: '已关闭 英雄联盟' };
    if (shown && shown.ok === true) {
      return {
        ok: false,
        needsConfirm: true,
        message: '英雄联盟的退出确认已经打开，请在客户端点「是」',
      };
    }
    return { ok: false, error: '没能唤起英雄联盟的退出确认' };
  }

  // Graceful close only: the app keeps its chance to ask about unsaved work.
  const result = await runPs(SCRIPTS.apps, ['-Mode', 'close', '-ProcId', String(target.pid)]);
  if (!result || result.ok !== true) {
    return { ok: false, error: (result && result.error) || '关闭失败，可能它正在忙' };
  }
  return { ok: true, message: '已关闭 ' + (target.title || target.process) };
}

async function mediaTool(action) {
  const allowed = ['status', 'play_pause', 'next', 'previous'];
  if (!allowed.includes(action)) return { ok: false, error: '不支持的播放操作：' + action };
  const raw = await runPs(SCRIPTS.media, ['-Action', action]);
  if (!raw) return { ok: false, error: '媒体控制没有响应' };
  if (action === 'status') {
    if (!raw.app) return { ok: false, error: '现在没有正在播放的媒体' };
    return {
      ok: true,
      playing: raw.status === 'Playing',
      status: raw.status,
      title: raw.title || '',
      artist: raw.artist || '',
      app: raw.app,
    };
  }
  if (raw.ok !== true) return { ok: false, error: '播放器没有接受这次操作' };
  return { ok: true, message: '已执行', status: raw.status, title: raw.title || '', via: raw.via };
}

/** The desktop client's own "daily recommendation" deep link starts playback. */
function playDailyRecommend() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "Start-Process -FilePath 'orpheus://songrcmd?autoplay=1'",
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {
      resolve({ ok: false, error: '拉不起网易云音乐' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve({ ok: true, message: '已打开网易云音乐并开始播放每日推荐' });
    }, 3500);
    if (timer.unref) timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: '拉不起网易云音乐' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true, message: '已打开网易云音乐并开始播放每日推荐' }
          : { ok: false, error: '网易云没有接受每日推荐链接' },
      );
    });
  });
}

/** Ask the DSH music panel (dsh-music-panel) to play; the panel drains the queue. */
async function playDshMusic(args, ctx) {
  const base = String((ctx && ctx.bridgeUrl) || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'DSH 地址不可用' };
  const action = String((args && args.action) || 'play').trim();
  const query = String((args && args.query) || '').trim();
  const source = String((args && args.source) || 'netease').trim();
  try {
    const response = await fetch(base + '/desktop-butler/music', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, query, source }),
      signal: AbortSignal.timeout(15000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      return { ok: false, error: json.error || 'DSH 音乐面板没有响应（HTTP ' + response.status + '）' };
    }
    if (!json.queued) return { ok: false, error: 'DSH 音乐面板没有接受这次操作' };
    const what = action === 'play' && query ? '「' + query + '」' : action;
    return {
      ok: true,
      message: '已让 DSH 音乐面板播放 ' + what + '；如果没响，请先把音乐面板打开',
      source: json.source || source,
    };
  } catch (e) {
    return { ok: false, error: '连不上 DSH 音乐面板：' + (e && e.message ? e.message : String(e)) };
  }
}

/** Bilibili pages opened in the user's default browser. */
const BILIBILI_PAGES = {
  home: { url: 'https://www.bilibili.com/', label: 'B 站首页' },
  dynamic: { url: 'https://t.bilibili.com/', label: 'B 站动态' },
  classic: {
    url: 'https://www.bilibili.com/video/BV1BDk2YCEHF/?spm_id_from=333.337.search-card.all.click&vd_source=b5f11290c00282b966446c93a1d0b2ac',
    label: '经典老歌',
  },
};

/** @param {string} page @returns {{url: string, label: string}} */
function bilibiliPage(page) {
  return BILIBILI_PAGES[String(page || '').toLowerCase()] || BILIBILI_PAGES.home;
}

/** Launch a hard-coded https URL through the shell (no user-controlled URLs). */
function openExternalPage(url, label) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "Start-Process -FilePath '" + url + "'",
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {
      resolve({ ok: false, error: '拉不起浏览器' });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already exited */
      }
      resolve({ ok: true, message: '已打开 ' + label });
    }, 3500);
    if (timer.unref) timer.unref();
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: '拉不起浏览器' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? { ok: true, message: '已打开 ' + label }
          : { ok: false, error: '浏览器没有接受这个地址' },
      );
    });
  });
}

async function openBilibili(page) {
  const target = bilibiliPage(page);
  return openExternalPage(target.url, target.label);
}

async function volumeTool(action, level) {
  const allowed = ['get', 'set', 'mute', 'unmute', 'toggle', 'up', 'down'];
  if (!allowed.includes(action)) return { ok: false, error: '不支持的音量操作：' + action };
  const args = ['-Action', action];
  if (action === 'set') {
    const value = Number(level);
    if (!Number.isFinite(value)) return { ok: false, error: '没有给出音量数值' };
    args.push('-Level', String(Math.round(Math.max(0, Math.min(100, value)))));
  }
  const raw = await runPs(SCRIPTS.volume, args);
  if (!raw || raw.ok !== true) return { ok: false, error: (raw && raw.error) || '调不了音量' };
  return { ok: true, volume: raw.volume, muted: raw.muted };
}

/** Function schemas handed to the model. */
function schemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'open_app',
        description:
          '在这台电脑上打开一个已安装的软件。用户说「打开XX」「帮我开一下XX」时调用。name 传用户说出的名字，可以是简称或口语，例如「网易云」「浏览器」「微信」。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '软件名或简称' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'close_app',
        description:
          '关闭一个正在运行的软件窗口，等同于点它的关闭按钮（软件仍可弹出保存提示）。用户明确说「关闭X」「把X关了」时直接调用；只有意图含糊时才先确认。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '软件名或窗口标题里的关键词' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_bilibili',
        description:
          '在默认浏览器打开 B 站页面。page=home 首页；page=dynamic 动态；page=classic 打开用户指定的「经典老歌」视频。用户说「打开B站」用 home，「打开B站动态」用 dynamic，「打开经典老歌」用 classic。',
        parameters: {
          type: 'object',
          properties: {
            page: {
              type: 'string',
              enum: ['home', 'dynamic', 'classic'],
              description: 'home=首页，dynamic=动态，classic=经典老歌视频；省略时默认首页。',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'media',
        description:
          '控制正在播放的音乐或视频。action=status 查询当前放的是什么；play_pause 播放或暂停；next 下一首；previous 上一首。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'play_pause', 'next', 'previous'] },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'play_daily_recommend',
        description:
          '打开网易云音乐桌面客户端并自动播放「每日推荐」。用户说「播放每日推荐」「放今天的推荐」「打开网易云放每日推荐」时调用；不需要用户提供歌单 ID。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'play_dsh_music',
        description:
          '用 DSH 的音乐面板播放音乐：按歌名/歌手在线搜索（默认网易云），也可以暂停、下一首、上一首。用户说「播放音乐」「放首歌」「在 DSH 里点歌」时用。需要 DSH 音乐面板已经打开，动作会排队并在约两秒内生效。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['play', 'pause', 'next', 'previous'],
              description: 'play 搜索并播放；pause/next/previous 控制当前音乐。',
            },
            query: {
              type: 'string',
              description: '歌名或歌手，action=play 时使用。',
            },
            source: {
              type: 'string',
              enum: ['local', 'netease', 'qq', 'kugouLite', 'bodian', 'qishui', 'navidrome'],
              description: '从哪个来源搜索；默认 netease。',
            },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'volume',
        description:
          '调节系统音量。action=set 需要同时给 level（0-100）；up/down 微调；mute 静音；unmute 取消静音；toggle 切换静音；get 查询当前音量。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['get', 'set', 'mute', 'unmute', 'toggle', 'up', 'down'],
            },
            level: { type: 'number', description: '0-100，仅 action=set 时使用' },
          },
          required: ['action'],
        },
      },
    },
  ];
}

/** Short line for the speech bubble while a tool is running. */
function describe(name, args) {
  const who = args && typeof args.name === 'string' ? args.name : '';
  switch (name) {
    case 'open_app':
      return '正在打开 ' + who;
    case 'close_app':
      return '正在关闭 ' + who;
    case 'open_bilibili':
      return args && args.page === 'dynamic'
        ? '正在打开 B 站动态'
        : args && args.page === 'classic'
          ? '正在打开经典老歌'
          : '正在打开 B 站首页';
    case 'media':
      return args && args.action === 'status' ? '正在查看播放状态' : '正在控制播放';
    case 'play_daily_recommend':
      return '正在打开每日推荐';
    case 'play_dsh_music':
      return '正在让 DSH 音乐面板播放';
    case 'volume':
      return '正在调节音量';
    default:
      return '';
  }
}

/**
 * Run a tool call.
 * @param {string} name
 * @param {object} args
 * @param {{appRoot: string}} ctx
 * @returns {Promise<object>} JSON-serialisable result fed back to the model.
 */
async function run(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'open_app':
      return typeof a.name === 'string' && a.name.trim()
        ? openApp(a.name.trim(), ctx)
        : { ok: false, error: '没有给出软件名' };
    case 'close_app':
      return typeof a.name === 'string' && a.name.trim()
        ? closeApp(a.name.trim())
        : { ok: false, error: '没有给出软件名' };
    case 'open_bilibili':
      return openBilibili(String(a.page || 'home'));
    case 'media':
      return mediaTool(String(a.action || 'status'));
    case 'play_daily_recommend':
      return playDailyRecommend();
    case 'play_dsh_music':
      return playDshMusic(a, ctx);
    case 'volume':
      return volumeTool(String(a.action || 'get'), a.level);
    default:
      return { ok: false, error: '没有这个能力：' + name };
  }
}

module.exports = { schemas, describe, run, appIndex, matchApps, matchWindows, bilibiliPage, schemasForTest: schemas };
