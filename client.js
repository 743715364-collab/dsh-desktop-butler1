/*
 * dsh-desktop-butler — Client 半边（设置 → 桌面管家桌宠）。
 *
 * 只有一个设置分区：显示独立版桌宠的运行状态、启动/停止/重启，以及模型密钥
 * （baseUrl / model / apiKey）。数据全部走 Host 的 `/desktop-butler/*` 路由，客户端不碰文件。
 *
 * 这个文件是 DSH 的「普通副作用脚本」：加载时调 window.__ModuleLoader__.load，
 * 不能有顶层 import / export —— React 由 factory 的 require 取得。
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-butler',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'desktop-butler';

    const zh = {
      dshAuto: 'DSH 自动接入',
      dshUnavailable: 'DSH 模型暂不可用，可填写本地 Key 作为兜底',
      nav: '桌面管家桌宠',
      title: '桌面管家桌宠（独立版）',
      desc: '独立运行的 桌面管家 Electron 桌宠由 DSH 托管：DSH 启动时自动拉起，退出时关闭。',
      running: '运行中',
      stopped: '未运行',
      start: '启动',
      stop: '停止',
      restart: '重启',
      appDir: '应用目录',
      configPath: '语音配置',
      llmTitle: '模型密钥',
      llmDesc: '优先使用 DSH 当前模型和登录凭据；DSH 不可用时才使用下方本地 Key。',
      baseUrl: '接口地址（要带版本段，例如 https://api.deepseek.com/v1）',
      model: '模型名',
      apiKey: 'API Key',
      keySet: '已设置，留空则保持不变',
      keyUnset: 'DSH 自动接入可用；DSH 模型不可用时再填本地 Key',
      save: '保存并重启',
      saved: '已保存，桌宠正在重启…',
      chitchatTitle: '闲聊模式',
      chitchatDesc: '开启后，桌面管家会隔一段时间自己找话题，主动跟您聊两句（用上面那套模型和 Key）。关闭时只在您点击或说话时开口。',
      chitchatOn: '主动搭话',
      chitchatSpeak: '朗读出来（关掉只弹气泡）',
      chitchatMin: '最短间隔（秒）',
      chitchatMax: '最长间隔（秒）',
      chitchatSave: '保存闲聊设置',
      chitchatSaved: '闲聊设置已保存，桌宠正在重启…',
      chitchatNeedsKey: '还没填 API Key：现在开启，重启后也暂时不会开口。',
      voiceTitle: '语音',
      voiceDesc: '识别优先走 DSH 内置 SenseVoice；合成默认用 Edge 神经语音。DSH 不在或依赖缺失时自动回落到本机识别 / 系统发音人。',
      voiceEngine: '语音合成',
      voiceEngineEdge: 'Edge 神经语音（推荐）',
      voiceEngineSystem: 'Windows 系统语音',
      voiceEngineCloud: '自定义云端接口',
      voiceName: 'Edge 音色',
      voiceAsr: '语音识别',
      voiceAsrAuto: 'DSH 优先（自动回退）',
      voiceAsrDsh: '仅 DSH 内置识别',
      voiceAsrCloud: '云端识别接口',
      voiceAsrSystem: 'Windows 离线识别',
      voiceSave: '保存语音设置',
      voiceSaved: '语音设置已保存，桌宠正在重启…',
      voiceAsrDown: 'DSH 识别服务当前不可用，自动模式会回退到本机识别。',
      voiceEdgeDown: '找不到 Edge 语音依赖（msedge-tts），合成会回退到系统发音人。',
      packTitle: '语音包',
      packDesc: '一键套用音色、语速、音高和说话风格；应用后桌宠会重启。',
      packCn: '中文管家',
      packDefault: '恢复默认',
      packCurrentCn: '当前：中文管家',
      packCurrentDefault: '当前：默认（云希）',
      packCurrentCustom: '当前：自定义语音',
      packHint: '「中文管家」= 云健男声 + 语速 -4% + 音高 -3Hz + 沉稳克制的人设提示。',
      packSaved: '语音包已应用，桌宠正在重启…',
      working: '处理中…',
      loadFailed: '读不到桌宠状态：',
    };

    const en = {
      dshAuto: 'DSH auto-connect',
      dshUnavailable: 'DSH model unavailable; a local key can be used as fallback',
      nav: 'Desktop Butler pet',
      title: 'Desktop Butler pet (standalone)',
      desc: 'DSH manages the standalone Desktop Butler Electron pet: it starts with DSH and stops with it.',
      running: 'Running',
      stopped: 'Stopped',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      appDir: 'App directory',
      configPath: 'Voice config',
      llmTitle: 'Model key',
      llmDesc: 'DSH current model and credentials are used first; the local key below is only a fallback.',
      baseUrl: 'Base URL (include the version segment, e.g. https://api.deepseek.com/v1)',
      model: 'Model',
      apiKey: 'API key',
      keySet: 'Already set — leave blank to keep it',
      keyUnset: 'DSH auto-connect is available; add a local key only if the DSH model fails',
      save: 'Save and restart',
      saved: 'Saved. Restarting the pet…',
      chitchatTitle: 'Chitchat mode',
      chitchatDesc: 'When on, Desktop Butler starts a casual topic by itself every so often, using the model and key above. When off, it only speaks when clicked or spoken to.',
      chitchatOn: 'Start topics on its own',
      chitchatSpeak: 'Speak it aloud (off = bubble only)',
      chitchatMin: 'Min interval (s)',
      chitchatMax: 'Max interval (s)',
      chitchatSave: 'Save chitchat settings',
      chitchatSaved: 'Saved. Restarting the pet…',
      chitchatNeedsKey: 'No API key yet: turning this on will not make it talk until a key is set.',
      voiceTitle: 'Voice',
      voiceDesc: 'Recognition goes through DSH SenseVoice first; synthesis uses Edge neural voices by default. Without DSH or the Edge dependency it falls back to local recognition and the system voice.',
      voiceEngine: 'Speech synthesis',
      voiceEngineEdge: 'Edge neural voice (recommended)',
      voiceEngineSystem: 'Windows system voice',
      voiceEngineCloud: 'Custom cloud endpoint',
      voiceName: 'Edge voice',
      voiceAsr: 'Speech recognition',
      voiceAsrAuto: 'DSH first (auto fallback)',
      voiceAsrDsh: 'DSH only',
      voiceAsrCloud: 'Cloud endpoint',
      voiceAsrSystem: 'Windows offline',
      voiceSave: 'Save voice settings',
      voiceSaved: 'Saved. Restarting the pet…',
      voiceAsrDown: 'DSH recognition is unavailable right now; auto mode falls back to local recognition.',
      voiceEdgeDown: 'The Edge voice dependency (msedge-tts) is missing; synthesis falls back to the system voice.',
      packTitle: 'Voice pack',
      packDesc: 'Apply a ready-made voice, rate, pitch and speaking style in one click; the pet restarts afterwards.',
      packCn: 'Chinese butler',
      packDefault: 'Restore default',
      packCurrentCn: 'Current: Chinese butler',
      packCurrentDefault: 'Current: default (Yunxi)',
      packCurrentCustom: 'Current: custom voice',
      packHint: 'Chinese butler = Yunjian male voice + rate -4% + pitch -3Hz + a calm, restrained persona note.',
      packSaved: 'Voice pack applied. Restarting the pet…',
      working: 'Working…',
      loadFailed: 'Cannot read pet status: ',
    };

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 720, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
      card: { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 18px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)' },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 14, fontWeight: 600 },
      desc: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      meta: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      metaValue: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      badge: { flex: 'none', padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px', border: '1px solid currentColor' },
      button: { height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, cursor: 'pointer' },
      buttonPrimary: { height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-state-business-primary)', borderRadius: 8, background: 'var(--dsw-alias-state-business-primary)', color: '#fff', fontSize: 13, cursor: 'pointer' },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' },
      input: { boxSizing: 'border-box', width: '100%', maxWidth: 420, height: 30, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, outline: 'none' },
      error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d34b4b)' },
      note: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
    };

    /** 中文管家语音包的人设补充；写进 persona.style，不改原来的 persona.system。 */
    const CN_DUB_STYLE = [
      '声音形象：成熟、沉稳、克制，吐字清晰，句尾自然下沉，带一点机械感与距离感。',
      '不要播音腔、不要新闻播报腔，不要过度情绪化，也不要堆砌「您」。',
    ].join('\n');

    /** 设置页分区组件（t 由 apply 里的 locale 绑定进来） */
    function makeSection(t) {
      return function DesktopButlerSection() {
        const [status, setStatus] = useState(null);
        const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '' });
        const [chat, setChat] = useState({ enabled: false, speak: true, minIntervalSec: 90, maxIntervalSec: 210 });
        const [voice, setVoice] = useState({ ttsMode: 'edge', edgeVoice: 'zh-CN-YunxiNeural', asrMode: 'auto' });
        const [busy, setBusy] = useState(false);
        const [note, setNote] = useState('');
        const [chatNote, setChatNote] = useState('');
        const [voiceNote, setVoiceNote] = useState('');
        const [packNote, setPackNote] = useState('');
        /** 用户改了还没保存时，轮询不要用服务端值覆盖输入框。 */
        const chatDirty = useRef(false);
        const voiceDirty = useRef(false);

        const load = useCallback(async () => {
          try {
            const response = await fetch('/desktop-butler/status', { cache: 'no-store' });
            const next = await response.json();
            setStatus(next);
            setForm((prev) => ({
              baseUrl: prev.baseUrl || (next.config && next.config.llm ? next.config.llm.baseUrl : '') || '',
              model: prev.model || (next.config && next.config.llm ? next.config.llm.model : '') || '',
              apiKey: '',
            }));
            const remote = next.config && next.config.chitchat;
            if (remote && !chatDirty.current) {
              setChat({
                enabled: remote.enabled === true,
                speak: remote.speak !== false,
                minIntervalSec: Number(remote.minIntervalSec) || 90,
                maxIntervalSec: Number(remote.maxIntervalSec) || 210,
              });
            }
            if (next.config && next.config.tts && !voiceDirty.current) {
              setVoice({
                ttsMode: next.config.tts.mode || 'edge',
                edgeVoice: next.config.tts.edgeVoice || 'zh-CN-YunxiNeural',
                asrMode: (next.config.asr && next.config.asr.mode) || 'auto',
              });
            }
          } catch (error) {
            setStatus({ ok: false, error: String(error) });
          }
        }, []);

        useEffect(() => {
          void load();
          const timer = setInterval(() => {
            void load();
          }, 5000);
          return () => clearInterval(timer);
        }, [load]);

        const post = async (action) => {
          setBusy(true);
          setNote('');
          try {
            await fetch('/desktop-butler/' + action, { method: 'POST' });
            await load();
          } finally {
            setBusy(false);
          }
        };

        const save = async () => {
          setBusy(true);
          setNote('');
          try {
            const llm = { baseUrl: form.baseUrl.trim(), model: form.model.trim() };
            if (form.apiKey.trim()) llm.apiKey = form.apiKey.trim();
            const response = await fetch('/desktop-butler/config', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ llm }),
            });
            const json = await response.json();
            if (!response.ok || json.ok === false) {
              setNote(json.error || 'HTTP ' + response.status);
            } else {
              setNote(t('saved'));
              setForm((prev) => ({ ...prev, apiKey: '' }));
            }
            await load();
          } catch (error) {
            setNote(String(error));
          } finally {
            setBusy(false);
          }
        };

        const saveChitchat = async () => {
          setBusy(true);
          setChatNote('');
          try {
            const min = Math.max(30, Math.round(Number(chat.minIntervalSec) || 90));
            const max = Math.max(min, Math.round(Number(chat.maxIntervalSec) || 210));
            const response = await fetch('/desktop-butler/config', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                chitchat: { enabled: chat.enabled, speak: chat.speak, minIntervalSec: min, maxIntervalSec: max },
              }),
            });
            const json = await response.json();
            if (!response.ok || json.ok === false) {
              setChatNote(json.error || 'HTTP ' + response.status);
            } else {
              chatDirty.current = false;
              setChat((prev) => ({ ...prev, minIntervalSec: min, maxIntervalSec: max }));
              setChatNote(t('chitchatSaved'));
            }
            await load();
          } catch (error) {
            setChatNote(String(error));
          } finally {
            setBusy(false);
          }
        };

        const saveVoice = async () => {
          setBusy(true);
          setVoiceNote('');
          try {
            const response = await fetch('/desktop-butler/config', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                tts: { mode: voice.ttsMode, edgeVoice: voice.edgeVoice },
                asr: { mode: voice.asrMode },
              }),
            });
            const json = await response.json();
            if (!response.ok || json.ok === false) {
              setVoiceNote(json.error || 'HTTP ' + response.status);
            } else {
              voiceDirty.current = false;
              setVoiceNote(t('voiceSaved'));
            }
            await load();
          } catch (error) {
            setVoiceNote(String(error));
          } finally {
            setBusy(false);
          }
        };

        const applyPack = async (kind) => {
          setBusy(true);
          setPackNote('');
          try {
            const tts = kind === 'cn'
              ? {
                  mode: 'edge',
                  edgeVoice: 'zh-CN-YunjianNeural',
                  edgeRate: '-4%',
                  edgePitch: '-3Hz',
                  edgeVolume: '+0%',
                }
              : {
                  mode: 'edge',
                  edgeVoice: 'zh-CN-YunxiNeural',
                  edgeRate: '+2%',
                  edgePitch: '+0Hz',
                  edgeVolume: '+0%',
                };
            const response = await fetch('/desktop-butler/config', {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                tts,
                persona: { style: kind === 'cn' ? CN_DUB_STYLE : '' },
              }),
            });
            const json = await response.json();
            if (!response.ok || json.ok === false) {
              setPackNote(json.error || 'HTTP ' + response.status);
            } else {
              voiceDirty.current = false;
              setPackNote(t('packSaved'));
            }
            await load();
          } catch (error) {
            setPackNote(String(error));
          } finally {
            setBusy(false);
          }
        };

        const running = Boolean(status && status.running);
        const llm = (status && status.config && status.config.llm) || {};
        const dshLlm = (status && status.config && status.config.dshLlm) || {};
        const voiceStatus = (status && status.voice) || {};
        const currentPack = (status && status.config && status.config.voicePack) || 'custom';
        const badgeStyle = { ...S.badge, color: running ? 'var(--dsw-alias-state-success-primary, #2f9e63)' : 'var(--dsw-alias-label-tertiary)' };

        return h(
          'div',
          { style: S.root },
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.head },
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                h('div', { style: S.title }, t('title')),
                h('div', { style: S.desc }, t('desc')),
              ),
              h('span', { style: badgeStyle }, running ? t('running') : t('stopped')),
            ),
            status
              ? h(
                  'div',
                  { style: S.meta },
                  h('span', null, t('appDir')),
                  h('span', { style: S.metaValue }, status.appDir || '-'),
                  h('span', null, t('configPath')),
                  h('span', { style: S.metaValue }, status.configPath || '-'),
                )
              : h('div', { style: S.note }, t('working')),
            status && status.lastError ? h('div', { style: S.error }, status.lastError) : null,
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: S.buttonPrimary, disabled: busy || running, onClick: () => void post('start') },
                t('start'),
              ),
              h('button', { type: 'button', style: S.button, disabled: busy || !running, onClick: () => void post('stop') }, t('stop')),
              h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void post('restart') }, t('restart')),
            ),
            status && status.ok === false ? h('div', { style: S.error }, t('loadFailed') + (status.error || '')) : null,
          ),
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.title }, t('llmTitle')),
              h('div', { style: S.desc }, t('llmDesc')),
              h('div', { style: S.note }, dshLlm.available ? t('dshAuto') + ' · ' + dshLlm.provider + ' / ' + dshLlm.model : t('dshUnavailable')),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, t('baseUrl')),
              h('input', {
                style: S.input,
                value: form.baseUrl,
                placeholder: 'https://api.deepseek.com/v1',
                onChange: (event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value })),
              }),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, t('model')),
              h('input', {
                style: S.input,
                value: form.model,
                placeholder: 'deepseek-chat',
                onChange: (event) => setForm((prev) => ({ ...prev, model: event.target.value })),
              }),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, t('apiKey') + ' — ' + (llm.hasKey ? t('keySet') : t('keyUnset'))),
              h('input', {
                style: S.input,
                type: 'password',
                value: form.apiKey,
                autoComplete: 'off',
                placeholder: llm.hasKey ? '••••••••' : '',
                onChange: (event) => setForm((prev) => ({ ...prev, apiKey: event.target.value })),
              }),
            ),
            h(
              'div',
              { style: S.row },
              h('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => void save() }, t('save')),
              busy ? h('span', { style: S.note }, t('working')) : note ? h('span', { style: S.note }, note) : null,
            ),
          ),
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.title }, t('chitchatTitle')),
              h('div', { style: S.desc }, t('chitchatDesc')),
            ),
            h(
              'label',
              { style: S.check },
              h('input', {
                type: 'checkbox',
                checked: chat.enabled,
                onChange: (event) => {
                  chatDirty.current = true;
                  setChat((prev) => ({ ...prev, enabled: event.target.checked }));
                },
              }),
              h('span', null, t('chitchatOn')),
            ),
            h(
              'label',
              { style: S.check },
              h('input', {
                type: 'checkbox',
                checked: chat.speak,
                onChange: (event) => {
                  chatDirty.current = true;
                  setChat((prev) => ({ ...prev, speak: event.target.checked }));
                },
              }),
              h('span', null, t('chitchatSpeak')),
            ),
            h(
              'div',
              { style: S.row },
              h(
                'label',
                { style: { ...S.field, maxWidth: 160 } },
                h('span', { style: S.label }, t('chitchatMin')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 30,
                  max: 3600,
                  step: 10,
                  value: chat.minIntervalSec,
                  onChange: (event) => {
                    chatDirty.current = true;
                    setChat((prev) => ({ ...prev, minIntervalSec: event.target.value }));
                  },
                }),
              ),
              h(
                'label',
                { style: { ...S.field, maxWidth: 160 } },
                h('span', { style: S.label }, t('chitchatMax')),
                h('input', {
                  style: S.input,
                  type: 'number',
                  min: 30,
                  max: 3600,
                  step: 10,
                  value: chat.maxIntervalSec,
                  onChange: (event) => {
                    chatDirty.current = true;
                    setChat((prev) => ({ ...prev, maxIntervalSec: event.target.value }));
                  },
                }),
              ),
            ),
            chat.enabled && !llm.hasKey ? h('div', { style: S.note }, t('chitchatNeedsKey')) : null,
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => void saveChitchat() },
                t('chitchatSave'),
              ),
              busy ? h('span', { style: S.note }, t('working')) : chatNote ? h('span', { style: S.note }, chatNote) : null,
            ),
          ),
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.title }, t('packTitle')),
              h('div', { style: S.desc }, t('packDesc')),
            ),
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => void applyPack('cn') },
                t('packCn'),
              ),
              h(
                'button',
                { type: 'button', style: S.button, disabled: busy, onClick: () => void applyPack('default') },
                t('packDefault'),
              ),
            ),
            h(
              'div',
              { style: S.note },
              currentPack === 'cn-dub'
                ? t('packCurrentCn')
                : currentPack === 'default'
                  ? t('packCurrentDefault')
                  : t('packCurrentCustom'),
            ),
            h('div', { style: S.note }, t('packHint')),
            busy ? h('div', { style: S.note }, t('working')) : packNote ? h('div', { style: S.note }, packNote) : null,
          ),
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: S.title }, t('voiceTitle')),
              h('div', { style: S.desc }, t('voiceDesc')),
            ),
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, t('voiceEngine')),
              h(
                'select',
                {
                  style: S.input,
                  value: voice.ttsMode,
                  onChange: (event) => {
                    voiceDirty.current = true;
                    setVoice((prev) => ({ ...prev, ttsMode: event.target.value }));
                  },
                },
                h('option', { value: 'edge' }, t('voiceEngineEdge')),
                h('option', { value: 'system' }, t('voiceEngineSystem')),
                h('option', { value: 'cloud' }, t('voiceEngineCloud')),
              ),
            ),
            voice.ttsMode === 'edge'
              ? h(
                  'label',
                  { style: S.field },
                  h('span', { style: S.label }, t('voiceName')),
                  h(
                    'select',
                    {
                      style: S.input,
                      value: voice.edgeVoice,
                      onChange: (event) => {
                        voiceDirty.current = true;
                        setVoice((prev) => ({ ...prev, edgeVoice: event.target.value }));
                      },
                    },
                    ...[
                      ['zh-CN-YunxiNeural', 'Yunxi · 年轻男声'],
                      ['zh-CN-YunjianNeural', 'Yunjian · 成熟男声'],
                      ['zh-CN-YunyangNeural', 'Yunyang · 播音男声'],
                      ['zh-CN-XiaoxiaoNeural', 'Xiaoxiao · 自然女声'],
                      ['zh-CN-XiaoyiNeural', 'Xiaoyi · 元气少女'],
                      ['zh-CN-liaoning-XiaobeiNeural', 'Xiaobei · 东北甜妹'],
                      ['zh-TW-HsiaoChenNeural', 'HsiaoChen · 台湾甜音'],
                    ].map(([id, label]) => h('option', { key: id, value: id }, label)),
                  ),
                )
              : null,
            h(
              'label',
              { style: S.field },
              h('span', { style: S.label }, t('voiceAsr')),
              h(
                'select',
                {
                  style: S.input,
                  value: voice.asrMode,
                  onChange: (event) => {
                    voiceDirty.current = true;
                    setVoice((prev) => ({ ...prev, asrMode: event.target.value }));
                  },
                },
                h('option', { value: 'auto' }, t('voiceAsrAuto')),
                h('option', { value: 'dsh' }, t('voiceAsrDsh')),
                h('option', { value: 'cloud' }, t('voiceAsrCloud')),
                h('option', { value: 'system' }, t('voiceAsrSystem')),
              ),
            ),
            voiceStatus.asr === false && (voice.asrMode === 'auto' || voice.asrMode === 'dsh')
              ? h('div', { style: S.note }, t('voiceAsrDown'))
              : null,
            voiceStatus.edge === false && voice.ttsMode === 'edge'
              ? h('div', { style: S.note }, t('voiceEdgeDown'))
              : null,
            h(
              'div',
              { style: S.row },
              h(
                'button',
                { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: () => void saveVoice() },
                t('voiceSave'),
              ),
              busy ? h('span', { style: S.note }, t('working')) : voiceNote ? h('span', { style: S.note }, voiceNote) : null,
            ),
          ),
        );
      };
    }

    return {
      name: 'desktop-butler',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-butler: dictionaries');
        const t = ctx.locale.bind(NS);
        const Section = makeSection(t);
        ctx.slots.inject('settings.section', function* () {
          yield ctx.slots.register(
            { name: 'settings.section', id: 'desktop-butler', order: 31, label: () => t('nav'), inject: () => ({ t }) },
            Section,
          );
        });
      },
    };
  },
});
