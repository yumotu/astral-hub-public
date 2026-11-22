// P0 personal long-horizon workbench projection.
// This module is deliberately read-only. It accepts immutable events and
// produces a display snapshot without starting an agent, calling a tool, or
// changing a user account.

export const agentEventKinds = Object.freeze([
  'conversation.run_started',
  'conversation.attention',
  'goal.created',
  'goal.progress',
  'task.created',
  'task.progress',
  'task.succeeded',
  'task.cancelled',
  'run.started',
  'run.reported',
  'run.unknown_result',
  'attention.created',
  'attention.resolved',
  'schedule.enabled',
  'schedule.paused',
  'mail.attention',
  'finance.observation',
]);

const validKinds = new Set(agentEventKinds);

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value.trim();
}

export function normalizeAgentEvent(value) {
  if (!value || typeof value !== 'object') throw new TypeError('agent event must be an object');
  const result = {
    id: text(value.id, 'event.id'),
    ownerId: text(value.ownerId, 'event.ownerId'),
    type: text(value.type, 'event.type'),
    source: text(value.source, 'event.source'),
    sourceId: text(value.sourceId, 'event.sourceId'),
    occurredAt: text(value.occurredAt, 'event.occurredAt'),
    payload: value.payload && typeof value.payload === 'object' ? structuredClone(value.payload) : {},
  };
  if (!validKinds.has(result.type)) throw new TypeError(`unsupported agent event kind: ${result.type}`);
  if (Number.isNaN(Date.parse(result.occurredAt))) throw new TypeError('event.occurredAt must be an ISO date');
  return Object.freeze(result);
}

function at(base, minutes) {
  return new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
}

/**
 * Synthetic P0 fixture used by the workbench demo. It models the event
 * envelope that real mail, conversation, schedule, learning, investment and
 * Remote adapters will publish later.
 */
export function createSyntheticAgentEvents({ now = new Date().toISOString(), ownerId = 'demo-owner' } = {}) {
  const owner = text(ownerId, 'ownerId');
  return [
    normalizeAgentEvent({
      id: 'synthetic-conversation-run-1', ownerId: owner, type: 'conversation.run_started',
      source: 'conversation', sourceId: 'demo-conversation-1', occurredAt: at(now, -3),
      payload: { conversationId: 'demo-conversation-1', title: '整理本周求职邮件并生成行动清单', project: '求职申请 · 收件箱', engine: 'DPH', status: '执行中', progress: 68, round: 4, tools: 9 },
    }),
    normalizeAgentEvent({
      id: 'synthetic-conversation-attention-2', ownerId: owner, type: 'conversation.attention',
      source: 'conversation', sourceId: 'demo-conversation-2', occurredAt: at(now, -2),
      payload: { conversationId: 'demo-conversation-2', title: '检查投资组合今日相对昨日的变化', project: '投资研究 · 持仓', engine: 'Pi', status: '等待回复', progress: 42, question: '是否按均衡风险口径生成复盘？' },
    }),
    normalizeAgentEvent({
      id: 'synthetic-goal-1', ownerId: owner, type: 'goal.created',
      source: 'planner', sourceId: 'goal-秋招准备', occurredAt: at(now, -8),
      payload: { goalId: 'goal-秋招准备', title: '完成秋招准备计划', status: '执行中', progress: 64, conversationId: 'demo-conversation-1', engine: 'DPH', nextCheck: '今天 20:30' },
    }),
    normalizeAgentEvent({
      id: 'synthetic-goal-progress-1', ownerId: owner, type: 'goal.progress',
      source: 'planner', sourceId: 'goal-秋招准备', occurredAt: at(now, -1),
      payload: { goalId: 'goal-秋招准备', progress: 64, step: '正在合并邮件截止时间与学习安排', report: '已完成来源收集与初步拆分' },
    }),
    normalizeAgentEvent({
      id: 'synthetic-schedule-investment', ownerId: owner, type: 'schedule.enabled',
      source: 'schedule', sourceId: 'schedule-investment-refresh', occurredAt: at(now, -30),
      payload: { scheduleId: 'schedule-investment-refresh', title: '每 30 分钟刷新持仓与相对昨日盈亏', cadence: '每 30 分钟', status: '启用', nextRun: '12 分钟后', conversationId: 'demo-conversation-2', action: '更新行情、计算日内盈亏并生成风险提醒' },
    }),
    normalizeAgentEvent({
      id: 'synthetic-mail-attention', ownerId: owner, type: 'mail.attention',
      source: 'mail', sourceId: 'demo-mail-1', occurredAt: at(now, -12),
      payload: { mailId: 'demo-mail-1', subject: 'AI 面试预约确认｜请选择你的面试时段', title: '确认云川智能 AI 面试时段', status: '待确认', dueAt: at(now, 24 * 60), question: '请回复确认面试时段' },
    }),
    normalizeAgentEvent({
      id: 'synthetic-finance-observation', ownerId: owner, type: 'finance.observation',
      source: 'investment', sourceId: 'demo-portfolio', occurredAt: at(now, -18),
      payload: { portfolioId: 'demo-portfolio', totalCapital: 25600.22, dayGain: 74.34, asOf: now, attention: '检查黄金仓位，不因单日波动频繁调仓' },
    }),
  ].map(normalizeAgentEvent);
}

function sortedUniqueEvents(events, ownerId) {
  const seen = new Set();
  return events
    .map((value, index) => ({ item: normalizeAgentEvent(value), index }))
    .filter(({ item }) => item.ownerId === ownerId)
    .filter(({ item }) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => Date.parse(a.item.occurredAt) - Date.parse(b.item.occurredAt) || a.index - b.index)
    .map(({ item }) => item);
}

function upsert(map, id, value) {
  const previous = map.get(id) || {};
  map.set(id, { ...previous, ...value });
}

/**
 * Projects immutable events into a read-only workbench snapshot. Replaying the
 * same event list is deterministic, and duplicate event IDs are ignored.
 */
export function projectWorkbenchSnapshot(events, { ownerId = 'demo-owner' } = {}) {
  const owner = text(ownerId, 'ownerId');
  const ordered = sortedUniqueEvents(events, owner);
  const conversations = new Map();
  const goals = new Map();
  const schedules = new Map();
  const attentions = new Map();
  const finance = new Map();
  const tasks = new Map();
  const runs = new Map();
  for (const item of ordered) {
    const p = item.payload;
    if (item.type === 'conversation.run_started' || item.type === 'conversation.attention') {
      upsert(conversations, p.conversationId, { id: p.conversationId, title: p.title, project: p.project, engine: p.engine, status: p.status, progress: p.progress ?? 0, ...(item.type === 'conversation.attention' ? { question: p.question } : {}) });
    } else if (item.type === 'goal.created' || item.type === 'goal.progress') {
      upsert(goals, p.goalId, { id: p.goalId, title: p.title, status: p.status, progress: p.progress, conversationId: p.conversationId, engine: p.engine, nextCheck: p.nextCheck, ...(p.step ? { step: p.step } : {}), ...(p.report ? { report: p.report } : {}) });
    } else if (item.type === 'task.created' || item.type === 'task.progress' || item.type === 'task.succeeded' || item.type === 'task.cancelled') {
      upsert(tasks, p.taskId, { id: p.taskId, title: p.title, status: item.type === 'task.succeeded' ? 'succeeded' : item.type === 'task.cancelled' ? 'cancelled' : p.status, progress: p.progress ?? 0, goalId: p.goalId, conversationId: p.conversationId, engine: p.engine, ...(p.step ? { step: p.step } : {}) });
    } else if (item.type === 'run.started' || item.type === 'run.reported' || item.type === 'run.unknown_result') {
      upsert(runs, p.runId, { id: p.runId, ...(p.taskId ? { taskId: p.taskId } : {}), ...(p.conversationId ? { conversationId: p.conversationId } : {}), ...(p.engine ? { engine: p.engine } : {}), status: item.type === 'run.unknown_result' ? 'unknown_result' : p.status, ...(typeof p.progress === 'number' ? { progress: p.progress } : {}), ...(p.report ? { report: p.report } : {}) });
    } else if (item.type === 'schedule.enabled' || item.type === 'schedule.paused') {
      upsert(schedules, p.scheduleId, { id: p.scheduleId, title: p.title, cadence: p.cadence, status: item.type === 'schedule.paused' ? '已暂停' : p.status, nextRun: p.nextRun, conversationId: p.conversationId, action: p.action });
    } else if (item.type === 'mail.attention' || item.type === 'attention.created' || item.type === 'attention.resolved') {
      if (item.type === 'attention.resolved') {
        upsert(attentions, p.attentionId, { id: p.attentionId, status: 'resolved', answer: p.answer });
        continue;
      }
      const attentionId = p.attentionId || p.mailId;
      upsert(attentions, attentionId, { id: attentionId, kind: p.kind || 'mail', title: p.title, subject: p.subject, status: p.status, dueAt: p.dueAt, question: p.question });
    } else if (item.type === 'finance.observation') {
      upsert(finance, p.portfolioId, { id: p.portfolioId, totalCapital: p.totalCapital, dayGain: p.dayGain, asOf: p.asOf, attention: p.attention });
    }
  }
  const latest = ordered.at(-1);
  return Object.freeze({
    version: 2,
    mode: 'synthetic',
    readOnly: true,
    ownerId: owner,
    asOf: latest?.occurredAt || null,
    eventCount: ordered.length,
    eventIds: ordered.map((item) => item.id),
    conversations: [...conversations.values()],
    goals: [...goals.values()],
    tasks: [...tasks.values()],
    runs: [...runs.values()],
    schedules: [...schedules.values()],
    attentions: [...attentions.values()],
    finance: [...finance.values()],
  });
}

export function createSyntheticWorkbenchSnapshot(options = {}) {
  const events = createSyntheticAgentEvents(options);
  return projectWorkbenchSnapshot(events, options);
}
