# 桌面管家桌宠（独立版）

把 `插件包内的 pet/ 目录` 那个独立版 桌面管家 Electron 桌宠，做成 DSH 里的一个插件（bundle）：

- DSH 启动 → 自动拉起桌宠；
- DSH 退出 / 插件停用 → `taskkill /T` 关掉桌宠；
- 设置 →「桌面管家桌宠」里：看运行状态、启动 / 停止 / 重启、配置模型密钥；
- 独立版仍然是独立应用：直接双击 `启动桌面管家.cmd` 也能用，它自带 single-instance lock，不会重复开两个。

## 设置页

- **模型密钥**：独立版自己调 OpenAI 兼容接口，所以 Key 写回它自己的
  `插件包内的 pet/ 目录\desktop-butler-config.json` 的 `llm.apiKey`，**不走 DSH 的模型配置**。
  保存后插件会自动重启桌宠让新配置生效（独立版只在启动时读配置）。
- **闲聊模式**：默认关闭；打开后它会隔一段时间主动找话题（用上面的模型和 Key 生成，
  不调用工具）。可以调是否朗读、最短/最长搭话间隔。写的是同一个配置文件的 `chitchat` 段；
  和桌宠右键菜单里的开关是同一份状态，保存后同样会重启桌宠。桌宠正在说话、菜单打开
  或人不在时会自动让路。
- **语音**：TTS 引擎（Edge 神经语音 / Windows 系统语音 / 云端）、Edge 音色、识别来源
  （DSH 优先 / 仅 DSH / 云端 / Windows 离线）。写 `tts.mode`、`tts.edgeVoice`、`asr.mode`。
- **语音包**：一键「中文管家」= 云健男声 + 语速 -4% + 音高 -3Hz + `persona.style` 的沉稳风格提示；
  「恢复默认」= 云希 + 正常语速/音高 + 清空 style。应用后重启桌宠。
- **运行状态**：应用目录、配置路径、最近一次错误（找不到 electron / 进程退出原因）都会显示。

## 工作状态联动

插件监听 DSH 的 `session/event`（以及 `agent/error`），把「思考 / 调用工具 / 整理结果 / 等确认 / 完成 / 出错」
压缩成 6 个档位，写进桌宠的 `插件包内的 pet/ 目录\data\work-status.json`。桌宠每 600ms 轮询一次，
用金色全息球自己的动作回应：

| DSH 事件 | 档位 | 桌宠动作 / 状态牌 |
| --- | --- | --- |
| `turn/start` | thinking | `think` / `DSH · THINKING` |
| `tool/call`（普通工具） | working | `busy` / `DSH · WORKING` |
| `tool/result` | result | `sparkle` / `DSH · RESULT` |
| `approval/asked`、`ask_user_question` | waiting | `turn` / `DSH · WAITING` |
| `turn/end completed` | success | `success` / `DSH · DONE`（只播一次） |
| `turn/end error`、`max-tokens`、`agent/error` | error | `error` / `DSH · ERROR`（只播一次） |

- 多会话按优先级 `waiting > error > working > thinking > result > success` 取一个展示；同档取最近事件。
- 完成 / 出错保留 20 秒后自动清理回空闲；`aborted` 等没有终态含义的回合直接清掉，不会卡在「进行中」。
- 状态持续时每 15 秒写一次心跳；桌宠超过 45 秒没见到新心跳就当插件已不在，回到待机。
- 语音 / 闲聊 / 拖拽优先，结束后自动回到当前工作状态。
- 插件行 config 的 `workStatus: false` 可以整体关闭这个联动（不再监听、不再写文件）。

## 语音桥

桌宠的收音在它自己的渲染进程里（16kHz、VAD、静音裁剪），插件只把「识别」和「朗读」两件事
接到 DSH 的强项上：

| 路由 | 作用 |
| --- | --- |
| `POST /desktop-butler/transcribe` | 收 16kHz mono PCM16 WAV，调用 `ctx.speechToText`（DSH 内置 SenseVoice），返回文字 |
| `POST /desktop-butler/speak` | 收文字 + Edge 音色参数，调用 `msedge-tts`（子进程 worker），返回 WebM/Opus 音频 |
| `POST /desktop-butler/music` | 把 `{action, query, source}` 交给 DSH `music_control` 工具的队列；DSH 音乐面板打开后取走播放 |
| `GET /desktop-butler/voice-status` | 返回 `asr` / `edge` 是否可用、当前桥地址，设置页用 |

- 桌宠用插件 spawn 时注入的 `DESKTOP_BUTLER_DSH_URL` 回调这些路由；手动启动时用
  `desktop-butler-config.json` 的 `bridge.baseUrl`，留空默认 `http://127.0.0.1:62012`。
- 识别失败 / DSH 没开：桌宠回落到自己的云端或 Windows 离线识别；Edge 不可用：回落到系统发音人。
- `msedge-tts` 从当前 profile 的 `node_modules` 找；DSH 宿主对 profile 外部 CJS 包的 require
  不兼容，所以合成由 `edge-tts-worker.cjs` 在干净的 `ELECTRON_RUN_AS_NODE` 子进程里跑。
- 设置页「语音」卡片可以切 TTS 引擎 / Edge 音色 / 识别来源；保存同样会重启桌宠。
- 「语音常开」是桌宠渲染进程自己的持续聆听（按钮 / 右键菜单，状态写 `desktop-butler-state.json`），
  每句话识别和朗读仍走上面的插件路由；插件不参与麦克风开关。

## 限制

- 从桌宠托盘菜单点「退出」后，插件不会自动把它拉回来（DSH 下次启动才重启）；按「启动」即可。
- 闲聊模式会用同一个模型 Key 持续产生小请求；不想花 token 就关掉，或把间隔调大。
- Edge 语音需要联网，并依赖 profile 里的 `msedge-tts`（已随 dsh-chatting-pet 安装）；离线或依赖缺失时回落到系统发音人。DSH 内置识别首次使用需要准备 SenseVoice 模型。
- 独立版的对话历史只在内存里，重启插件/桌宠会清空（这是独立版自己的行为）。
- 语音识别默认走 Windows 自带离线识别；云端 ASR / 云端 TTS 需要自己改 `desktop-butler-config.json` 的
  `asr` / `tts` 段，本设置页只暴露 LLM 三项和闲聊开关/间隔；`chitchat` 的话题种子、
  `maxPerHour`、`awayAfterMin` 等进阶项也直接改配置文件。

## 实现

- `index.js`（Host）：`spawn` electron、`taskkill /T` 收尾、`/desktop-butler/status|start|stop|restart|config` 路由；
  配置读写覆盖 `llm` / `tts` / `asr` / `chitchat` 等段；监听 DSH 会话事件并写 `data/work-status.json`；
- `work-status.js`（Host）：工作状态归并的纯逻辑（事件 → 6 档、多会话优先级、终态清理），可脱离 DSH 单测；
- `voice-bridge.js` + `edge-tts-worker.cjs`（Host）：Edge 神经语音；worker 在干净子进程里加载
  `msedge-tts`，插件路由 `/speak` 用；
- `client.js`（Client）：`settings.section` 里的一个 React 分区，纯 `fetch` 调用上面这些路由
  （模型密钥、闲聊模式、语音三张卡片）；
- `cordis.patch.yml`：插入插件行 `desktop-butler`（`appDir` 指向独立版目录，`autoStart: true`，`workStatus: true`）。
