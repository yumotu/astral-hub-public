import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Gauge,
  Inbox,
  ListChecks,
  Mail,
  MessageSquareText,
  Pause,
  Play,
  Repeat2,
  RefreshCw,
  Search,
  Sparkles,
  Timer,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';

type TaskStatus = '待确认' | '未开始' | '进行中' | '已完成' | '已逾期' | '失败' | '待核对';
type TaskPriority = '高' | '中' | '低';
type ScheduleTask = {
  id: string;
  title: string;
  type: string;
  sender: string;
  subject: string;
  dueAt: Date;
  status: TaskStatus;
  priority: TaskPriority;
  duration: number;
  confidence: number;
  uncertain?: boolean;
  reply?: boolean;
  tags: string[];
};
type ScheduleMail = {
  id: string;
  sender: string;
  subject: string;
  receivedAt: string;
  snippet: string;
  type: string;
  needsReply?: boolean;
};
type ConversationRun = {
  id: string;
  title: string;
  project: string;
  engine: 'Pi' | 'DPH';
  status: '执行中' | '等待回复' | '已完成' | '失败' | '待核对';
  progress: number;
  round: number;
  tools: number;
  updated: string;
  conversationId: string;
  conversationTitle: string;
};
type LongTask = {
  id: string;
  title: string;
  goal: string;
  status: '执行中' | '已暂停' | '待验收' | '已完成' | '失败';
  progress: number;
  step: string;
  steps: string[];
  nextCheck: string;
  engine: 'Pi' | 'DPH';
  conversationId: string | null;
  conversationTitle: string;
};
type ScheduledTask = {
  id: string;
  title: string;
  target: string;
  cadence: string;
  nextRun: string;
  lastRun: string;
  status: '启用' | '已暂停' | '失败';
  action: string;
  conversationId: string | null;
  conversationTitle: string;
};

function dateAt(dayOffset: number, hour: number, minute = 0) {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() + dayOffset);
  value.setHours(hour, minute, 0, 0);
  return value;
}

function formatTime(value: Date) {
  return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(value: Date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(value);
  target.setHours(0, 0, 0, 0);
  const days = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  return target.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

const statusClass: Record<TaskStatus, string> = {
  待确认: 'pending',
  未开始: 'todo',
  进行中: 'progress',
  已完成: 'done',
  已逾期: 'overdue',
  失败: 'overdue',
  待核对: 'pending',
};

function money(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ConversationPanel({ runs: allRuns, detailed, onNotice, onOpenConversation }: { runs: ConversationRun[]; detailed?: boolean; onNotice: (value: string) => void; onOpenConversation: (id: string, title: string) => void }) {
  const runs = detailed ? allRuns : allRuns.filter((run) => run.status !== '已完成');
  return (
    <section className="mail-schedule-panel workbench-execution-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">LIVE CONVERSATIONS</div>
          <h2>对话中的任务</h2>
        </div>
        <Bot size={19} />
      </div>
      <div className="workbench-conversation-list">
        {runs.map((run) => (
          <button key={run.id} className="workbench-conversation-row" onClick={() => run.conversationId && onOpenConversation(run.conversationId, run.conversationTitle)}>
            <span className={`workbench-engine-mark ${run.engine.toLowerCase()}`}>{run.engine}</span>
            <span className="workbench-conversation-main">
              <strong>{run.title}</strong>
              <small>{run.project} · {run.updated}</small>
              <span className="workbench-progress-track"><i style={{ width: `${run.progress}%` }} /></span>
              <small>{run.status} · 第 {run.round} 轮 · {run.tools} 次工具调用</small>
            </span>
            <span className={`workbench-run-status ${run.status === '已完成' ? 'done' : run.status === '等待回复' ? 'waiting' : 'running'}`}>{run.status}</span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
      {!detailed && <button className="text-link workbench-panel-link" onClick={() => onNotice('请从工作台视图切换到“对话任务”查看全部。')}><ListChecks size={14} />查看全部对话任务</button>}
    </section>
  );
}

function LongTasksPanel({ tasks: allTasks, detailed }: { tasks: LongTask[]; detailed?: boolean }) {
  const tasks = detailed ? allTasks : allTasks.slice(0, 2);
  return (
    <section className="mail-schedule-panel workbench-long-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">LONG HORIZON</div>
          <h2>长期任务</h2>
        </div>
        <Gauge size={19} />
      </div>
      <div className="workbench-long-list">
        {tasks.map((task) => (
          <article className="workbench-long-card" key={task.id}>
            <div className="workbench-long-card-heading">
              <span className={`workbench-engine-mark ${task.engine.toLowerCase()}`}>{task.engine}</span>
              <div><strong>{task.title}</strong><small>{task.goal}</small></div>
              <span className={`workbench-run-status ${task.status === '执行中' ? 'running' : task.status === '待验收' ? 'waiting' : 'paused'}`}>{task.status}</span>
            </div>
            <div className="workbench-long-progress"><span><i style={{ width: `${task.progress}%` }} /></span><b>{task.progress}%</b></div>
            <div className="workbench-long-meta"><span><ListChecks size={14} />{task.step}</span><span><Clock3 size={14} />下次检查 {task.nextCheck}</span></div>
            <div className="workbench-long-steps" aria-label="长期任务步骤">
              {task.steps.map((step, index) => <span className={index < Math.round(task.progress / 20) ? 'done' : index === Math.round(task.progress / 20) ? 'current' : ''} key={step}>{index + 1}. {step}</span>)}
            </div>
            <div className="workbench-card-actions"><span className="workbench-panel-description">目标数据来自当前账号</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SchedulesPanel({ schedules, detailed }: { schedules: ScheduledTask[]; detailed?: boolean }) {
  const items = detailed ? schedules : schedules.slice(0, 2);
  return (
    <section className="mail-schedule-panel workbench-schedule-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">AUTOMATIONS</div>
          <h2>定时任务</h2>
        </div>
        <Repeat2 size={15} />
      </div>
      <p className="workbench-panel-description">每个计划都绑定目标、执行引擎、项目和权限。运行失败只记录结果，不会自动重复执行已完成的操作。</p>
      <div className="workbench-schedule-list">
        {items.map((schedule) => (
          <article className="workbench-schedule-row" key={schedule.id}>
            <span className={`workbench-schedule-icon ${schedule.status === '启用' ? 'active' : ''}`}><Repeat2 size={16} /></span>
            <div className="workbench-schedule-main"><strong>{schedule.title}</strong><small>{schedule.target} · {schedule.action}</small><span><b>{schedule.cadence}</b> · 下次 {schedule.nextRun} · 上次 {schedule.lastRun}</span></div>
            <span className={`workbench-schedule-toggle ${schedule.status === '启用' ? 'on' : ''}`}>{schedule.status}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

function FinancePanel({ detailed, holdings, summary, marketAreas, onNotice }: { detailed?: boolean; holdings: any[]; summary: Record<string, unknown>; marketAreas: any[]; onNotice: (value: string) => void }) {
  const dayGain = holdings.reduce((total, holding) => total + (holding.day_gain || 0), 0);
  const total = Number(summary.total_capital || holdings.reduce((sum, holding) => sum + (holding.value || 0), 0));
  return (
    <section className="mail-schedule-panel workbench-finance-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">PORTFOLIO SNAPSHOT</div>
          <h2>资产提醒</h2>
        </div>
        <Wallet size={19} />
      </div>
      <div className="workbench-finance-summary"><div><span>当前总资产</span><strong>¥ {money(total)}</strong></div><div><span>相对昨日</span><strong className={dayGain >= 0 ? 'positive' : 'negative'}>{dayGain >= 0 ? '+' : ''}¥ {money(dayGain)}</strong></div></div>
      <div className="workbench-allocation-bar" aria-label="资产配置比例">
        {Object.entries((summary.buckets || {}) as Record<string, unknown>).map(([type, value]) => <span key={type} style={{ width: `${total ? (Number(value) / total) * 100 : 0}%` }} className={`allocation-${type}`} />)}
      </div>
      <div className="workbench-finance-holdings">
        {holdings.slice(0, detailed ? holdings.length : 3).map((holding) => <button key={holding.id} onClick={() => onNotice(`已打开「${holding.name}」的持仓详情。`)}><span><strong>{holding.name}</strong><small>{holding.symbol || '现金'} · {money(holding.value)} 元</small></span><b className={(holding.day_gain || 0) >= 0 ? 'positive' : 'negative'}>{(holding.day_gain || 0) >= 0 ? '+' : ''}{money(holding.day_gain || 0)}</b><ChevronRight size={14} /></button>)}
        {!holdings.length && <div className="mail-schedule-empty"><strong>暂无持仓数据</strong><small>在投资研究页录入或同步持仓后，这里会显示真实账户数据。</small></div>}
      </div>
      <div className="workbench-market-areas">{marketAreas.slice(0, detailed ? 5 : 3).map((area) => <span key={area.id}><i className={area.market?.regime || ''} />{area.title} <b>{typeof area.quote?.change_1d === 'number' ? `${area.quote.change_1d >= 0 ? '+' : ''}${area.quote.change_1d}%` : '—'}</b></span>)}</div>
      <button className="secondary workbench-small-action" onClick={() => onNotice('请从投资研究页查看完整持仓和行情。')}><TrendingUp size={14} />打开投资研究</button>
    </section>
  );
}

function realText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function realDate(value: unknown) {
  const date = value ? new Date(String(value)) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function realStatus(value: unknown): TaskStatus {
  if (value === 'done' || value === 'succeeded' || value === 'completed') return '已完成';
  if (value === 'error' || value === 'failed') return '失败';
  if (value === 'interrupted' || value === 'unknown') return '待核对';
  if (value === 'queued') return '未开始';
  if (value === 'waiting_user') return '待确认';
  if (value === 'running' || value === 'delivering' || value === 'accepted' || value === 'stopping') return '进行中';
  return '未开始';
}

function realProgress(value: unknown, status: TaskStatus) {
  if (typeof value === 'number') return Math.max(0, Math.min(100, value));
  return status === '已完成' ? 100 : status === '进行中' ? 50 : 0;
}

function realWorkbenchData(payload: {
  pi: { tasks?: any[]; conversations?: any[] };
  superagent: { tasks?: any[] };
  goals: { goals?: any[] };
  investment: { holdings?: any[]; summary?: Record<string, unknown>; dashboard?: any; schedules?: any[] };
  mail: { messages?: any[] };
}) {
  const piTasks = payload.pi.tasks || [];
  const superTasks = payload.superagent.tasks || [];
  const conversations = payload.pi.conversations || [];
  const conversationById = new Map(conversations.map((conversation) => [String(conversation.id), conversation]));
  const latestByConversation = new Map<string, any>();
  for (const task of [...piTasks, ...superTasks]) {
    const conversationId = typeof task.conversationId === 'string' ? task.conversationId : '';
    if (!conversationId) continue;
    const previous = latestByConversation.get(conversationId);
    if (!previous || String(previous.updatedAt || previous.createdAt || '') < String(task.updatedAt || task.createdAt || '')) latestByConversation.set(conversationId, task);
  }
  const conversationRuns: ConversationRun[] = [...latestByConversation.entries()].map(([conversationId, task]) => {
    const status = realStatus(task.status);
    const conversation = conversationById.get(conversationId);
    return {
      id: String(task.id),
      title: realText(task.input || task.title, '未命名任务'),
      project: realText(conversation?.projectName || conversation?.projectId, '默认项目'),
      engine: 'Pi',
      status: status === '待确认' ? '等待回复' : status === '失败' ? '失败' : status === '待核对' ? '待核对' : status === '已完成' ? '已完成' : '执行中',
      progress: realProgress(task.progress, status),
      round: Number(task.metrics?.modelTurns || 0),
      tools: Number(task.metrics?.toolCalls || 0),
      updated: realText(task.updatedAt || task.createdAt, '刚刚'),
      conversationId,
      conversationTitle: realText(conversation?.title || task.input, '未命名对话'),
    };
  });
  const delegatedRuns: ConversationRun[] = superTasks.map((task) => {
    const status = realStatus(task.status);
    const runtime = task.runtime === 'DPH' || task.runtime === 'Remote' ? task.runtime : 'Pi';
    return {
      id: 'superagent-' + String(task.id),
      title: realText(task.title || task.input, '未命名委派'),
      project: realText(task.projectId, 'SuperAgent'),
      engine: runtime,
      status: status === '待确认' ? '等待回复' : status === '失败' ? '失败' : status === '待核对' ? '待核对' : status === '已完成' ? '已完成' : '执行中',
      progress: realProgress(task.progress, status),
      round: 0,
      tools: 0,
      updated: realText(task.updatedAt || task.createdAt, '刚刚'),
      conversationId: typeof task.conversationId === 'string' ? task.conversationId : '',
      conversationTitle: realText(task.title || task.input, '委派任务'),
    };
  });
  const tasks: ScheduleTask[] = piTasks.map((task) => {
    const status = realStatus(task.status);
    return {
      id: String(task.id),
      title: realText(task.input, '未命名任务'),
      type: '对话任务',
      sender: 'Pi',
      subject: realText(task.input, '对话任务'),
      dueAt: realDate(task.finishedAt || task.createdAt),
      status,
      priority: status === '进行中' ? '高' : '中',
      duration: Math.max(1, Math.round(Number(task.metrics?.responseMs || 0) / 60000)),
      confidence: 1,
      reply: status === '待确认',
      tags: ['对话', realText(task.projectId, '默认项目')],
    };
  });
  const longTasks: LongTask[] = (payload.goals.goals || []).map((goal) => {
    const steps = Array.isArray(goal.steps) ? goal.steps : [];
    const done = steps.filter((step: any) => step.status === 'done').length;
    const progress = steps.length ? Math.round((done / steps.length) * 100) : goal.status === 'completed' ? 100 : 0;
    const status = goal.status === 'completed' || goal.status === 'archived' ? '已完成' : goal.status === 'paused' ? '已暂停' : '执行中';
    return {
      id: String(goal.id),
      title: realText(goal.title, '未命名目标'),
      goal: realText(goal.description, '未填写目标说明'),
      status,
      progress,
      step: realText(steps.find((step: any) => step.status === 'active')?.title, status === '已完成' ? '已完成' : '等待下一步'),
      steps: steps.map((step: any) => realText(step.title, '步骤')),
      nextCheck: status === '已完成' ? '无需检查' : '由目标执行器安排',
      engine: 'Pi',
      conversationId: null,
      conversationTitle: '目标详情',
    };
  });
  const schedules: ScheduledTask[] = (payload.investment.schedules || []).map((schedule) => {
    const interval = Number(schedule.interval_minutes || 0);
    const cadence = interval >= 1440 ? '每 ' + Math.round(interval / 1440) + ' 天' : interval >= 60 ? '每 ' + Math.round(interval / 60) + ' 小时' : '每 ' + (interval || 30) + ' 分钟';
    return {
      id: String(schedule.id),
      title: schedule.kind === 'investment_refresh' ? '刷新持仓与相对昨日盈亏' : realText(schedule.kind, '定时计划'),
      target: '投资研究',
      cadence,
      nextRun: realText(schedule.next_run_at, '待安排'),
      lastRun: realText(schedule.last_run_at, '尚未运行'),
      status: schedule.enabled ? '启用' : '已暂停',
      action: '读取当前账号持仓并生成研究提醒',
      conversationId: null,
      conversationTitle: '投资研究',
    };
  });
  const mails: ScheduleMail[] = (payload.mail.messages || []).map((message) => ({
    id: String(message.uid),
    sender: realText(message.from, '未知发件人'),
    subject: realText(message.subject, '(无主题)'),
    receivedAt: realText(message.date, '—'),
    snippet: realText(message.subject, '(无主题)'),
    type: message.seen ? '已读邮件' : '未读邮件',
    needsReply: !message.seen,
  }));
  return {
    tasks,
    mails,
    conversationRuns: [...conversationRuns, ...delegatedRuns].sort((a, b) => b.updated.localeCompare(a.updated)),
    longTasks,
    schedules,
    holdings: payload.investment.holdings || [],
    summary: payload.investment.summary || {},
    marketAreas: Array.isArray(payload.investment.dashboard?.market_areas) ? payload.investment.dashboard.market_areas : [],
  };
}

export function MailSchedulePage({ settings, openMail, openConversation }: { settings: Settings; openMail: () => void; openConversation?: (id: string, title: string) => void }) {
  const [view, setView] = useState<'overview' | 'tasks' | 'inbox' | 'conversations' | 'long' | 'schedules' | 'finance'>('overview');
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [conversationRuns, setConversationRuns] = useState<ConversationRun[]>([]);
  const [longTasks, setLongTasks] = useState<LongTask[]>([]);
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [mails, setMails] = useState<ScheduleMail[]>([]);
  const [holdings, setHoldings] = useState<any[]>([]);
  const [investmentSummary, setInvestmentSummary] = useState<Record<string, unknown>>({});
  const [marketAreas, setMarketAreas] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [selectedTask, setSelectedTask] = useState<ScheduleTask | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!(settings.sessionToken || settings.token)) {
      setDataError('请先登录账号，工作台才会读取真实数据。');
      return;
    }
    let active = true;
    setLoading(true);
    setDataError('');
    const get = <T,>(path: string) => api<T>(settings, path, undefined, undefined, false, { fresh: true });
    void Promise.allSettled([
      get<{ tasks?: any[] }>('/pi/tasks'),
      get<{ conversations?: any[] }>('/pi/conversations'),
      get<{ tasks?: any[] }>('/superagent/tasks'),
      get<{ goals?: any[] }>('/goals'),
      get<{ holdings?: any[]; summary?: Record<string, unknown> }>('/investment/holdings'),
      get<any>('/investment/dashboard?risk_profile=balanced'),
      get<{ schedules?: any[] }>('/investment/schedules'),
      get<{ account?: unknown }>('/mail/account'),
    ]).then(async (results) => {
      if (!active) return;
      const [pi, conversations, superagent, goals, investment, dashboard, scheduleResult, account] = results;
      let mailResult: { messages?: any[] } = {};
      if (account.status === 'fulfilled' && account.value.account) {
        const mail = await Promise.allSettled([get<{ messages?: any[] }>('/mail/messages?mailbox=INBOX&limit=8')]);
        if (mail[0].status === 'fulfilled') mailResult = mail[0].value;
      }
      const mapped = realWorkbenchData({
        pi: { tasks: pi.status === 'fulfilled' ? pi.value.tasks : [], conversations: conversations.status === 'fulfilled' ? conversations.value.conversations : [] },
        superagent: superagent.status === 'fulfilled' ? superagent.value : {},
        goals: goals.status === 'fulfilled' ? goals.value : {},
        investment: { holdings: investment.status === 'fulfilled' ? investment.value.holdings : [], summary: investment.status === 'fulfilled' ? investment.value.summary : {}, dashboard: dashboard.status === 'fulfilled' ? dashboard.value : {}, schedules: scheduleResult.status === 'fulfilled' ? scheduleResult.value.schedules : [] },
        mail: mailResult,
      });
      setTasks(mapped.tasks);
      setMails(mapped.mails);
      setConversationRuns(mapped.conversationRuns);
      setLongTasks(mapped.longTasks);
      setSchedules(mapped.schedules);
      setHoldings(mapped.holdings);
      setInvestmentSummary(mapped.summary);
      setMarketAreas(mapped.marketAreas);
      const failures = results.filter((result) => result.status === 'rejected').length;
      if (failures && !mapped.conversationRuns.length && !mapped.holdings.length) setDataError('部分真实数据暂时不可用，请检查对应插件连接。');
    }).catch((error) => {
      if (active) setDataError(error instanceof Error ? error.message : '工作台读取失败。');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [settings]);

  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) =>
        `${task.title}${task.type}${task.sender}${task.tags.join('')}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [query, tasks],
  );
  const todayTasks = tasks.filter((task) => task.dueAt.toDateString() === new Date().toDateString());
  const pendingCount = tasks.filter((task) => !['已完成'].includes(task.status)).length;
  const replyCount = tasks.filter((task) => task.reply && task.status !== '已完成').length;
  const overdueCount = tasks.filter((task) => task.status === '已逾期').length;
  const activeConversationCount = conversationRuns.filter((run) => run.status !== '已完成').length;
  const activeLongTaskCount = longTasks.filter((task) => task.status === '执行中').length;
  const enabledScheduleCount = schedules.filter((schedule) => schedule.status === '启用').length;

  function completeTask(id: string) {
    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, status: '已完成' as const } : task)),
    );
    setSelectedTask((current) => (current?.id === id ? { ...current, status: '已完成' } : current));
    setNotice('已在当前工作台标记完成；原始任务状态仍由对应插件管理。');
  }

  function openTargetConversation(id: string, title: string) {
    if (openConversation) openConversation(id, title);
    else setNotice(`已选择「${title}」作为目标对话。`);
  }

  return (
    <div className="mail-schedule-page">
      <header className="mail-schedule-heading">
        <div>
          <div className="mail-schedule-eyebrow">邮日程 · WORKSPACE</div>
          <h1>今天，先处理最重要的事。</h1>
          <p>统一汇总当前账号的对话、任务、目标、计划、邮件和持仓。</p>
        </div>
        <div className="mail-schedule-heading-actions">
          <button className="secondary" onClick={() => window.location.reload()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin' : ''} />
            {loading ? '读取中…' : '刷新真实数据'}
          </button>
          <button className="primary" onClick={() => setView('conversations')}>
            <CheckCircle2 size={16} />
            查看运行中的任务
          </button>
        </div>
      </header>

      <div className="mail-schedule-live-banner" role="status">
        <span className="mail-schedule-live-dot" />
        <strong>当前账号数据</strong>
        <span>{loading ? '正在读取已授权的数据源…' : '工作台不会生成合成任务；未连接的数据源会显示为空。'}</span>
        <button className="text-link" onClick={openMail}>
          打开邮件插件 <ArrowRight size={14} />
        </button>
      </div>
      {dataError && <div className="mail-schedule-inline-notice" role="alert">{dataError}</div>}

      <nav className="mail-schedule-tabs" aria-label="工作台视图">
        {[
          ['overview', '今日概览', '概览'],
          ['conversations', '对话任务', '对话'],
          ['long', '长期任务', '长期'],
          ['schedules', '定时任务', '定时'],
          ['finance', '资产提醒', '资产'],
          ['tasks', '所有任务', '任务'],
          ['inbox', '邮件事项', '邮件'],
        ].map(([id, label, mobileLabel]) => (
          <button
            key={id}
            className={view === id ? 'active' : ''}
            onClick={() => setView(id as typeof view)}
            aria-pressed={view === id}
          >
            <span className="mail-schedule-tab-desktop">{label}</span>
            <span className="mail-schedule-tab-mobile">{mobileLabel}</span>
          </button>
        ))}
      </nav>

      {view === 'overview' ? (
        <>
          <section className="mail-schedule-metrics workbench-metrics" aria-label="工作台摘要">
            <article>
              <span>今天待处理</span>
              <strong>{todayTasks.length + 1}</strong>
              <small>按截止时间排序</small>
            </article>
            <article>
              <span>对话执行中</span>
              <strong>{activeConversationCount}</strong>
              <small>Pi / DPH 统一管理</small>
            </article>
            <article>
              <span>长期目标</span>
              <strong>{activeLongTaskCount}</strong>
              <small>另有 1 项待验收</small>
            </article>
            <article>
              <span>定时计划</span>
              <strong>{enabledScheduleCount}</strong>
              <small>1 项已暂停</small>
            </article>
            <article>
              <span>未来 7 天</span>
              <strong>{pendingCount}</strong>
              <small>邮件与对话合并</small>
            </article>
            <article className={overdueCount ? 'is-danger' : ''}>
              <span>需要回复</span>
              <strong>{replyCount}</strong>
              <small>{overdueCount ? `${overdueCount} 项逾期` : '暂无逾期'}</small>
            </article>
          </section>

          <div className="mail-schedule-dashboard-grid">
            <section className="mail-schedule-panel mail-schedule-timeline-panel">
              <div className="mail-schedule-panel-heading">
                <div>
                  <div className="mail-schedule-section-kicker">TODAY</div>
                  <h2>今日时间轴</h2>
                </div>
                <span className="mail-schedule-date-label">
                  {new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}
                </span>
              </div>
              <div className="mail-schedule-timeline">
                {[
                  { time: '09:30', label: '整理收件箱', type: '系统建议', done: true },
                  ...todayTasks.map((task) => ({
                    time: formatTime(task.dueAt),
                    label: task.title,
                    type: task.type,
                    task,
                  })),
                  { time: '21:00', label: '预留检查时间', type: '建议安排', done: false },
                ].map((item, index) => (
                  <div className="mail-schedule-timeline-row" key={`${item.time}-${item.label}`}>
                    <time>{item.time}</time>
                    <span className={`mail-schedule-timeline-marker ${'done' in item && item.done ? 'done' : ''}`}>
                      {'done' in item && item.done ? <Check size={12} /> : <span />}
                    </span>
                    <button
                      className="mail-schedule-timeline-event"
                      onClick={() => 'task' in item && setSelectedTask(item.task)}
                      disabled={!('task' in item)}
                    >
                      <strong>{item.label}</strong>
                      <small>{item.type}</small>
                    </button>
                    {index === 2 && <span className="mail-schedule-current-line" />}
                  </div>
                ))}
              </div>
            </section>

            <section className="mail-schedule-panel mail-schedule-risk-panel">
              <div className="mail-schedule-panel-heading">
                <div>
                  <div className="mail-schedule-section-kicker">ATTENTION</div>
                  <h2>需要留意</h2>
                </div>
                <AlertTriangle size={19} />
              </div>
              <div className="mail-schedule-risk-list">
                {tasks
                  .filter((task) => task.status === '待确认' || task.uncertain || task.status === '已逾期')
                  .slice(0, 4)
                  .map((task) => (
                    <button key={task.id} onClick={() => setSelectedTask(task)}>
                      <span className={`mail-schedule-risk-dot ${statusClass[task.status]}`} />
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {task.status === '已逾期' ? '已逾期 · 需要处理' : task.uncertain ? '时间不明确 · 请确认' : '待回复确认'}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
              </div>
              <div className="mail-schedule-confidence">
                <Sparkles size={16} />
                <span>AI 已从最近 30 天邮件中识别 8 项事项</span>
              </div>
            </section>
          </div>

          <section className="mail-schedule-panel mail-schedule-upcoming-panel">
            <div className="mail-schedule-panel-heading">
              <div>
                <div className="mail-schedule-section-kicker">NEXT 7 DAYS</div>
                <h2>未来 7 天</h2>
              </div>
              <button className="text-link" onClick={() => setView('tasks')}>
                查看全部 <ArrowRight size={14} />
              </button>
            </div>
            <div className="mail-schedule-upcoming-list">
              {tasks
                .filter((task) => task.status !== '已完成')
                .slice(0, 5)
                .map((task) => (
                  <button key={task.id} className="mail-schedule-upcoming-row" onClick={() => setSelectedTask(task)}>
                    <span className="mail-schedule-upcoming-date">
                      <b>{formatDay(task.dueAt)}</b>
                      <small>{formatTime(task.dueAt)}</small>
                    </span>
                    <span className="mail-schedule-upcoming-main">
                      <strong>{task.title}</strong>
                      <small>{task.sender} · {task.duration} 分钟</small>
                    </span>
                    <span className={`status-badge ${statusClass[task.status]}`}>{task.status}</span>
                    <ChevronRight size={16} />
                  </button>
                ))}
            </div>
          </section>

          <section className="mail-schedule-panel mail-schedule-mail-panel">
            <div className="mail-schedule-panel-heading">
              <div>
                <div className="mail-schedule-section-kicker">IMPORTANT MAIL</div>
                <h2>最近的重要邮件</h2>
              </div>
              <button className="text-link" onClick={() => setView('inbox')}>
                查看收件箱 <ArrowRight size={14} />
              </button>
            </div>
            <div className="mail-schedule-mail-list">
              {mails.map((mail) => (
                <button key={mail.id} className="mail-schedule-mail-row" onClick={() => setView('inbox')}>
                  <span className="mail-schedule-mail-icon"><Mail size={17} /></span>
                  <span className="mail-schedule-mail-main">
                    <strong>{mail.subject}</strong>
                    <small>{mail.sender} · {mail.receivedAt}</small>
                    <span>{mail.snippet}</span>
                  </span>
                  {mail.needsReply && <span className="mail-schedule-reply-badge">待回复</span>}
                </button>
              ))}
              {!mails.length && <div className="mail-schedule-empty"><strong>没有可展示的邮件事项</strong><small>配置邮箱后，工作台会读取当前账号的收件箱摘要。</small></div>}
            </div>
          </section>

          <div className="workbench-overview-grid">
            <ConversationPanel runs={conversationRuns} onNotice={setNotice} onOpenConversation={openTargetConversation} />
            <LongTasksPanel tasks={longTasks} />
          </div>
          <div className="workbench-overview-grid">
            <SchedulesPanel schedules={schedules} />
            <FinancePanel holdings={holdings} summary={investmentSummary} marketAreas={marketAreas} onNotice={setNotice} />
          </div>
        </>
      ) : view === 'conversations' ? (
        <ConversationPanel runs={conversationRuns} detailed onNotice={setNotice} onOpenConversation={openTargetConversation} />
      ) : view === 'long' ? (
        <LongTasksPanel tasks={longTasks} detailed />
      ) : view === 'schedules' ? (
        <SchedulesPanel schedules={schedules} detailed />
      ) : view === 'finance' ? (
        <FinancePanel detailed holdings={holdings} summary={investmentSummary} marketAreas={marketAreas} onNotice={setNotice} />
      ) : view === 'tasks' ? (
        <section className="mail-schedule-panel mail-schedule-all-tasks">
          <div className="mail-schedule-panel-heading">
            <div>
              <div className="mail-schedule-section-kicker">TASKS</div>
              <h2>所有任务</h2>
            </div>
            <label className="mail-schedule-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、类型或来源" />
            </label>
          </div>
          <div className="mail-schedule-task-list">
            {filteredTasks.map((task) => (
              <div className="mail-schedule-task-row" key={task.id}>
                <button
                  className={`mail-schedule-task-check ${task.status === '已完成' ? 'checked' : ''}`}
                  aria-label={task.status === '已完成' ? `恢复任务 ${task.title}` : `完成任务 ${task.title}`}
                  onClick={() => completeTask(task.id)}
                >
                  {task.status === '已完成' && <Check size={14} />}
                </button>
                <button className="mail-schedule-task-main" onClick={() => setSelectedTask(task)}>
                  <strong>{task.title}</strong>
                  <small>{task.type} · {task.sender} · {task.duration} 分钟</small>
                </button>
                <span className="mail-schedule-task-due"><b>{formatDay(task.dueAt)}</b><small>{formatTime(task.dueAt)}</small></span>
                <span className={`status-badge ${statusClass[task.status]}`}>{task.status}</span>
                <ChevronRight size={16} />
              </div>
            ))}
            {!filteredTasks.length && <div className="mail-schedule-empty">没有匹配的当前账号任务。</div>}
          </div>
        </section>
      ) : (
        <section className="mail-schedule-panel mail-schedule-inbox">
          <div className="mail-schedule-panel-heading">
            <div>
              <div className="mail-schedule-section-kicker">INBOX</div>
              <h2>邮件事项</h2>
            </div>
            <span className="mail-schedule-inbox-count"><Inbox size={15} /> {mails.length} 封邮件事项</span>
          </div>
          <div className="mail-schedule-mail-list expanded">
            {mails.map((mail) => (
              <button key={mail.id} className="mail-schedule-mail-row" onClick={openMail}>
                <span className="mail-schedule-mail-icon"><Mail size={17} /></span>
                <span className="mail-schedule-mail-main">
                  <strong>{mail.subject}</strong>
                  <small>{mail.sender} · {mail.receivedAt} · {mail.type}</small>
                  <span>{mail.snippet}</span>
                </span>
                {mail.needsReply ? <span className="mail-schedule-reply-badge">待回复</span> : <span className="mail-schedule-mail-open">查看</span>}
              </button>
            ))}
          </div>
          <div className="mail-schedule-inbox-note"><MessageSquareText size={16} /> 这里显示当前账号邮箱摘要；打开邮件插件可查看正文和执行操作。</div>
        </section>
      )}

      {notice && <div className="mail-schedule-inline-notice" role="status">{notice}</div>}
      {selectedTask && (
        <div className="mail-schedule-drawer-backdrop" role="presentation" onClick={() => setSelectedTask(null)}>
          <aside className="mail-schedule-task-drawer" role="dialog" aria-modal="true" aria-label="任务详情" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <div className="mail-schedule-section-kicker">TASK DETAIL</div>
                <h2>{selectedTask.title}</h2>
              </div>
              <button className="icon-btn" aria-label="关闭任务详情" onClick={() => setSelectedTask(null)}><X size={18} /></button>
            </header>
            <div className="mail-schedule-task-drawer-meta">
              <span className={`status-badge ${statusClass[selectedTask.status]}`}>{selectedTask.status}</span>
              <span>{selectedTask.type}</span>
              <span>{selectedTask.priority}优先级</span>
            </div>
            <dl>
              <div><dt><CalendarDays size={15} />截止时间</dt><dd>{selectedTask.uncertain ? '时间不明确，等待确认' : `${formatDay(selectedTask.dueAt)} ${formatTime(selectedTask.dueAt)}`}</dd></div>
              <div><dt><Timer size={15} />预计耗时</dt><dd>{selectedTask.duration} 分钟</dd></div>
              <div><dt><Sparkles size={15} />AI 置信度</dt><dd>{Math.round(selectedTask.confidence * 100)}%</dd></div>
              <div><dt><Mail size={15} />来源邮件</dt><dd>{selectedTask.subject}</dd></div>
            </dl>
            <div className="mail-schedule-task-drawer-source"><strong>下一步</strong><p>{selectedTask.uncertain ? '原邮件只有“本周内”这类模糊时间，先打开邮件确认后再排入时间轴。' : '建议预留准备和检查时间，完成后回到此处标记任务。'}</p></div>
            <div className="mail-schedule-task-drawer-actions">
              <button className="secondary" onClick={openMail}><Mail size={15} />打开来源邮件</button>
              <button className="primary" onClick={() => completeTask(selectedTask.id)} disabled={selectedTask.status === '已完成'}><CheckCircle2 size={15} />标记完成</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
