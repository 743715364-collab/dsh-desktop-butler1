/**
 * DSH 工作状态 → 桌宠动作的纯决策层。
 *
 * 移植自 `dsh-chatting-pet` 的 `src/host/work-status.ts`，只保留与桌宠动作相关的部分：
 * 会话事件 → 6 个档位（thinking / working / result / waiting / success / error），
 * 多会话按优先级取一个展示状态，终态短暂保留后自动清空。
 *
 * 这里不碰文件、不碰网络、不依赖 DSH 上下文，方便单测；写文件和计时器都在 index.js。
 */

/** 工作状态档位（顺序与桌宠动作映射一致，勿在中间插入） */
export const WORK_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'];

/**
 * 展示优先级：等待确认 > 出错 > 干活 > 思考 > 整理 > 完成。
 * result 高于 success：别的会话还在进行时，不要被另一边的「完成」压过去。
 */
export const WORK_PRIORITY = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};

/** ask_user_question 工具：模型在等用户选答案 → 归为 waiting，而不是普通工作 */
const USER_QUESTION_TOOL = 'ask_user_question';

/** update_goal 工具：complete / blocked 表示本轮是该目标任务的收尾轮 */
export const GOAL_UPDATE_TOOL = 'update_goal';

/**
 * turn/end reason.kind → 状态。
 * completed → success；错误系 → error；blocked → waiting；其余（aborted 等）→ null（清回空闲）。
 * @param {string} kind
 * @returns {'success' | 'error' | 'waiting' | null}
 */
function turnEndState(kind) {
  if (kind === 'completed') return 'success';
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  if (kind === 'blocked') return 'waiting';
  return null;
}

/**
 * turn/end completed 的终局判定：
 *   - 普通回合 → success；
 *   - goal 自动续跑轮的中间轮（未收尾）→ result，不提前庆祝；
 *   - 收尾轮 complete → success；blocked → error。
 * @param {{goalRound?: boolean, closing?: 'complete' | 'blocked' | null}} [turn]
 * @returns {'success' | 'error' | 'result'}
 */
export function completedState(turn) {
  if (!turn || !turn.goalRound) return 'success';
  if (turn.closing === 'blocked') return 'error';
  if (turn.closing === 'complete') return 'success';
  return 'result';
}

/**
 * 解析 update_goal 的参数（原始 JSON 字符串）。
 * @param {string} raw
 * @returns {'complete' | 'blocked' | null}
 */
export function goalUpdateAction(raw) {
  try {
    const value = JSON.parse(String(raw));
    const action = String(value && value.action ? value.action : '');
    if (action === 'complete' || action === 'blocked') return action;
  } catch {
    /* 非法 JSON：按未收尾处理 */
  }
  return null;
}

/**
 * 从一条 DSH `session/event` 压缩出工作状态；无变化 / 不关心返回 null。
 * @param {{type?: string, data?: Record<string, unknown> & {reason?: {kind?: string}}}} event
 * @param {{goalRound?: boolean, closing?: 'complete' | 'blocked' | null}} [turn]
 * @returns {'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error' | null}
 */
export function reduceWorkStatus(event, turn) {
  switch (event && event.type) {
    case 'turn/start':
      return 'thinking';
    case 'tool/call': {
      const name = String((event.data && event.data.name) || '');
      // 问用户问题的工具 = 在等用户答复，不是普通干活
      return name === USER_QUESTION_TOOL ? 'waiting' : 'working';
    }
    case 'tool/result':
      return 'result';
    case 'approval/asked':
      return 'waiting';
    case 'turn/end': {
      const reason = turnEndState(String((event.data && event.data.reason && event.data.reason.kind) || ''));
      if (reason === 'success') return completedState(turn);
      return reason;
    }
    default:
      return null;
  }
}

/** 任务详情文案上限（按码点截断，避免把 emoji 切成半个） */
export const TASK_TEXT_MAX = 40;

/**
 * todo/write → 当前任务文案：最后一个 in_progress，没有就第一个 pending；
 * 全部完成返回 null。
 * @param {{data?: {todos?: Array<{status?: string, content?: string}>}}} event
 * @returns {string | null}
 */
export function currentTaskFromTodo(event) {
  const todos = Array.isArray(event && event.data && event.data.todos) ? event.data.todos : [];
  let current = null;
  for (const item of todos) {
    if (item && item.status === 'in_progress') current = item;
  }
  if (!current) current = todos.find((item) => item && item.status === 'pending');
  const content = String((current && current.content) || '').trim();
  if (!content) return null;
  const points = Array.from(content);
  return points.length > TASK_TEXT_MAX ? points.slice(0, TASK_TEXT_MAX).join('') + '…' : content;
}

/**
 * 多会话聚合：每个会话一份 state/task，对外只暴露优先级最高的那一份。
 * 状态无变化时 snapshot 的 ts 不变，调用方可以据此决定要不要写文件。
 */
export class WorkStatusStore {
  constructor() {
    /** @type {Map<string, {state: string, seq: number, task: string | null}>} */
    this.sessions = new Map();
    this.snap = { state: null, task: null, ts: 0 };
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  stateOf(sessionId) {
    const entry = this.sessions.get(sessionId);
    return entry ? entry.state : undefined;
  }

  taskOf(sessionId) {
    const entry = this.sessions.get(sessionId);
    return entry ? entry.task : null;
  }

  /** 写会话状态，保留已有 task；展示快照没变 → 返回 false */
  setState(sessionId, state, seq = 0) {
    const prev = this.sessions.get(sessionId);
    if (prev && prev.state === state && prev.seq >= seq) return false;
    this.sessions.set(sessionId, { state, seq, task: prev ? prev.task : null });
    return this.refresh();
  }

  /** 写会话任务文案；会话没有活动条目 / 展示没变 → 返回 false */
  setTask(sessionId, task) {
    const prev = this.sessions.get(sessionId);
    if (!prev || prev.task === task) return false;
    this.sessions.set(sessionId, { state: prev.state, seq: prev.seq, task });
    return this.refresh();
  }

  /** 清掉一个会话（回合结束 / 终态过期）；展示没变 → 返回 false */
  clear(sessionId) {
    if (!this.sessions.delete(sessionId)) return false;
    return this.refresh();
  }

  /** 全部清空（插件卸载 / 重启时用） */
  reset() {
    this.sessions.clear();
    this.snap = { state: null, task: null, ts: 0 };
  }

  /** 当前展示快照（对象引用稳定） */
  snapshot() {
    return this.snap;
  }

  /** 重算展示；state 或 task 任一变才更新 ts，并返回是否变化 */
  refresh() {
    let best = null;
    for (const entry of this.sessions.values()) {
      if (!best) {
        best = entry;
        continue;
      }
      const a = WORK_PRIORITY[entry.state] || 0;
      const b = WORK_PRIORITY[best.state] || 0;
      if (a > b || (a === b && entry.seq > best.seq)) best = entry;
    }
    const nextState = best ? best.state : null;
    const nextTask = best ? best.task : null;
    if (nextState === this.snap.state && nextTask === this.snap.task) return false;
    this.snap.state = nextState;
    this.snap.task = nextTask;
    this.snap.ts = Date.now();
    return true;
  }
}
