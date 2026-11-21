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
import { investmentDemoDashboard } from './investment-demo';
import { createSyntheticWorkbenchSnapshot } from '../../shared/agent-workbench.mjs';
import { createSyntheticAgentEvents } from '../../shared/agent-workbench.mjs';
import { createPersonalAgentStore } from '../../shared/personal-agent-core.mjs';
import { createDphExecutorAdapter } from '../../shared/dph-executor-adapter.mjs';
import { createAgentToolRouter } from '../../shared/agent-tool-router.mjs';

type TaskStatus = '待确认' | '未开始' | '进行中' | '已完成' | '已逾期';
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
  status: '执行中' | '等待回复' | '已完成';
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
  status: '执行中' | '已暂停' | '待验收';
  progress: number;
  step: string;
  steps: string[];
  nextCheck: string;
  engine: 'Pi' | 'DPH';
  conversationId: string;
  conversationTitle: string;
};
type ScheduledTask = {
  id: string;
  title: string;
  target: string;
  cadence: string;
  nextRun: string;
  lastRun: string;
  status: '启用' | '已暂停';
  action: string;
  conversationId: string;
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
};

function demoTasks(): ScheduleTask[] {
  return [
    {
      id: 'demo-task-1',
      title: '确认云川智能 AI 面试时段',
      type: 'AI 面试',
      sender: '云川智能招聘',
      subject: 'AI 面试预约确认｜请选择你的面试时段',
      dueAt: dateAt(1, 18),
      status: '待确认',
      priority: '高',
      duration: 15,
      confidence: 0.95,
      reply: true,
      tags: ['秋招', '待回复'],
    },
    {
      id: 'demo-task-2',
      title: '完成北极星科技在线测评',
      type: '测评',
      sender: '北极星科技招聘组',
      subject: '【北极星科技】在线测评邀请，请于近期完成',
      dueAt: dateAt(2, 23, 59),
      status: '未开始',
      priority: '高',
      duration: 45,
      confidence: 0.98,
      tags: ['秋招', '线上'],
    },
    {
      id: 'demo-task-3',
      title: '准备澜沧银行秋招笔试',
      type: '笔试',
      sender: '澜沧银行校园招聘',
      subject: '笔试通知：综合能力测试开放至本周五',
      dueAt: dateAt(3, 22),
      status: '进行中',
      priority: '高',
      duration: 90,
      confidence: 0.82,
      uncertain: true,
      tags: ['秋招', '考试'],
    },
    {
      id: 'demo-task-4',
      title: '补交东陆大学推荐信扫描件',
      type: '材料补交',
      sender: '东陆大学研究生院',
      subject: '申请材料补交提醒：请上传推荐信扫描件',
      dueAt: dateAt(6, 17),
      status: '未开始',
      priority: '中',
      duration: 30,
      confidence: 0.91,
      tags: ['留学', '材料'],
    },
    {
      id: 'demo-task-5',
      title: '参加 Orbit Labs 线下面试',
      type: '线下面试',
      sender: 'Orbit Labs 人力资源',
      subject: '线下面试邀请｜请回复确认',
      dueAt: dateAt(7, 10),
      status: '待确认',
      priority: '高',
      duration: 60,
      confidence: 0.99,
      reply: true,
      tags: ['秋招', '线下'],
    },
    {
      id: 'demo-task-6',
      title: '回复研究助理面试安排',
      type: '待回复',
      sender: '实验室项目组',
      subject: '请确认下周研究助理沟通时间',
      dueAt: dateAt(0, 20),
      status: '已逾期',
      priority: '中',
      duration: 10,
      confidence: 0.88,
      reply: true,
      tags: ['待回复'],
    },
  ];
}

const demoMails: ScheduleMail[] = [
  {
    id: 'demo-mail-1',
    sender: '云川智能招聘',
    subject: 'AI 面试预约确认｜请选择你的面试时段',
    receivedAt: '今天 10:24',
    snippet: '请在明日 18:00 前回复确认面试时段，系统已为你预留时间。',
    type: 'AI 面试',
    needsReply: true,
  },
  {
    id: 'demo-mail-2',
    sender: '北极星科技招聘组',
    subject: '在线测评邀请，请于近期完成',
    receivedAt: '昨天 18:42',
    snippet: '测评预计用时 45 分钟，完成后系统会自动记录结果。',
    type: '测评',
  },
  {
    id: 'demo-mail-3',
    sender: '东陆大学研究生院',
    subject: '申请材料补交提醒：请上传推荐信扫描件',
    receivedAt: '昨天 16:11',
    snippet: '申请系统将在本周关闭，请确认推荐信扫描件是否已准备。',
    type: '材料补交',
  },
];

const demoConversationRuns: ConversationRun[] = [
  {
    id: 'conversation-run-1',
    title: '整理本周求职邮件并生成行动清单',
    project: '求职申请 · 收件箱',
    engine: 'DPH',
    conversationId: 'demo-conversation-1',
    conversationTitle: '整理本周求职邮件并生成行动清单',
    status: '执行中',
    progress: 68,
    round: 4,
    tools: 9,
    updated: '刚刚更新',
  },
  {
    id: 'conversation-run-2',
    title: '检查投资组合今日相对昨日的变化',
    project: '投资研究 · 持仓',
    engine: 'Pi',
    conversationId: 'demo-conversation-2',
    conversationTitle: '检查投资组合今日相对昨日的变化',
    status: '等待回复',
    progress: 42,
    round: 2,
    tools: 4,
    updated: '3 分钟前',
  },
  {
    id: 'conversation-run-3',
    title: '生成 RAG 面试复习资料',
    project: '学习 · AI 搜索',
    engine: 'DPH',
    status: '已完成',
    progress: 100,
    round: 7,
    tools: 12,
    updated: '今天 09:40',
    conversationId: 'demo-conversation-3',
    conversationTitle: '生成 RAG 面试复习资料',
  },
];

const demoLongTasks: LongTask[] = [
  {
    id: 'long-task-1',
    title: '完成秋招准备计划',
    goal: '从邮件事项、简历和练习记录中形成可执行的两周计划。',
    status: '执行中',
    progress: 64,
    step: '正在合并邮件截止时间与学习安排',
    steps: ['收集来源', '拆分任务', '安排时间轴', '检查冲突', '等待验收'],
    nextCheck: '今天 20:30',
    engine: 'DPH',
    conversationId: 'demo-conversation-1',
    conversationTitle: '整理本周求职邮件并生成行动清单',
  },
  {
    id: 'long-task-2',
    title: '投资组合月度复盘',
    goal: '比较资产配置、风险预算和本月操作记录，生成复盘草稿。',
    status: '待验收',
    progress: 92,
    step: '等待你确认复盘口径',
    steps: ['读取持仓', '计算收益', '分析风险', '生成建议', '等待验收'],
    nextCheck: '等待你的确认',
    engine: 'Pi',
    conversationId: 'demo-conversation-2',
    conversationTitle: '检查投资组合今日相对昨日的变化',
  },
];

const demoScheduledTasks: ScheduledTask[] = [
  {
    id: 'schedule-1',
    title: '每 30 分钟刷新持仓与相对昨日盈亏',
    target: '投资研究 · 演示持仓',
    cadence: '每 30 分钟',
    nextRun: '12 分钟后',
    lastRun: '18 分钟前 · 成功',
    status: '启用',
    action: '更新行情、计算日内盈亏并生成风险提醒',
    conversationId: 'demo-conversation-2',
    conversationTitle: '检查投资组合今日相对昨日的变化',
  },
  {
    id: 'schedule-2',
    title: '每天 09:00 扫描重要邮件',
    target: '邮件事项 · 演示收件箱',
    cadence: '每天 09:00',
    nextRun: '明天 09:00',
    lastRun: '今天 09:00 · 发现 3 项',
    status: '启用',
    action: '识别截止事项、待回复和不确定时间',
    conversationId: 'demo-conversation-1',
    conversationTitle: '整理本周求职邮件并生成行动清单',
  },
  {
    id: 'schedule-3',
    title: '每周日生成学习复盘',
    target: '学习 · RAG 与 Agent',
    cadence: '每周日 20:00',
    nextRun: '周日 20:00',
    lastRun: '上周日 · 成功',
    status: '已暂停',
    action: '汇总错题本、完成率和下周练习建议',
    conversationId: 'demo-conversation-3',
    conversationTitle: '生成 RAG 面试复习资料',
  },
];

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
          <button key={run.id} className="workbench-conversation-row" onClick={() => onOpenConversation(run.conversationId, run.conversationTitle)}>
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

function LongTasksPanel({ tasks: allTasks, detailed, onNotice, onCreate, onEdit, onOpenConversation }: { tasks: LongTask[]; detailed?: boolean; onNotice: (value: string) => void; onCreate: () => void; onEdit: (task: LongTask) => void; onOpenConversation: (id: string, title: string) => void }) {
  const tasks = detailed ? allTasks : allTasks.slice(0, 2);
  return (
    <section className="mail-schedule-panel workbench-long-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">LONG HORIZON</div>
          <h2>长期任务</h2>
        </div>
        <div className="workbench-panel-heading-actions"><Gauge size={19} /><button className="text-link" onClick={onCreate}><ListChecks size={14} />新建</button></div>
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
            <div className="workbench-card-actions"><button className="secondary workbench-small-action" onClick={() => onNotice(task.status === '待验收' ? '演示模式：已打开验收清单。' : '演示模式：已打开长期任务的完整进度.')}>{task.status === '待验收' ? '查看验收' : '查看进度'} <ArrowRight size={14} /></button><button className="text-link workbench-small-action" onClick={() => onOpenConversation(task.conversationId, task.conversationTitle)}><Bot size={14} />进入对话</button><button className="text-link workbench-small-action" onClick={() => onEdit(task)}>编辑</button></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SchedulesPanel({ schedules, detailed, onToggle, onNotice, onCreate, onEdit, onOpenConversation }: { schedules: ScheduledTask[]; detailed?: boolean; onToggle: (id: string) => void; onNotice: (value: string) => void; onCreate: () => void; onEdit: (schedule: ScheduledTask) => void; onOpenConversation: (id: string, title: string) => void }) {
  const items = detailed ? schedules : schedules.slice(0, 2);
  return (
    <section className="mail-schedule-panel workbench-schedule-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">AUTOMATIONS</div>
          <h2>定时任务</h2>
        </div>
        <button className="text-link" onClick={onCreate}><Repeat2 size={15} />新建</button>
      </div>
      <p className="workbench-panel-description">每个计划都绑定目标、执行引擎、项目和权限。运行失败只记录结果，不会自动重复执行已完成的操作。</p>
      <div className="workbench-schedule-list">
        {items.map((schedule) => (
          <article className="workbench-schedule-row" key={schedule.id}>
            <span className={`workbench-schedule-icon ${schedule.status === '启用' ? 'active' : ''}`}><Repeat2 size={16} /></span>
            <div className="workbench-schedule-main"><strong>{schedule.title}</strong><small>{schedule.target} · {schedule.action}</small><span><b>{schedule.cadence}</b> · 下次 {schedule.nextRun} · 上次 {schedule.lastRun}</span><button className="text-link workbench-schedule-conversation" onClick={() => onOpenConversation(schedule.conversationId, schedule.conversationTitle)}><Bot size={12} />{schedule.conversationTitle}</button></div>
            <button className={`workbench-schedule-toggle ${schedule.status === '启用' ? 'on' : ''}`} aria-pressed={schedule.status === '启用'} onClick={() => onToggle(schedule.id)}>{schedule.status === '启用' ? <Pause size={14} /> : <Play size={14} />}{schedule.status}</button>
            <span className="workbench-schedule-actions"><button className="icon-btn" aria-label={`编辑${schedule.title}`} onClick={() => onEdit(schedule)}><ListChecks size={14} /></button><button className="icon-btn" aria-label={`立即运行${schedule.title}`} onClick={() => onNotice(`演示模式：已记录立即运行「${schedule.title}」，不会执行真实操作。`)}><Play size={14} /></button></span>
          </article>
        ))}
      </div>
    </section>
  );
}

function FinancePanel({ detailed, onNotice }: { detailed?: boolean; onNotice: (value: string) => void }) {
  const holdings = investmentDemoDashboard.portfolio.holdings;
  const summary = investmentDemoDashboard.portfolio.summary;
  const dayGain = holdings.reduce((total, holding) => total + (holding.day_gain || 0), 0);
  const marketAreas = investmentDemoDashboard.market_areas.slice(0, detailed ? 5 : 3);
  return (
    <section className="mail-schedule-panel workbench-finance-panel">
      <div className="mail-schedule-panel-heading">
        <div>
          <div className="mail-schedule-section-kicker">PORTFOLIO SNAPSHOT</div>
          <h2>资产提醒</h2>
        </div>
        <Wallet size={19} />
      </div>
      <div className="workbench-finance-summary"><div><span>演示总资产</span><strong>¥ {money(summary.total_capital)}</strong></div><div><span>今日相对昨日</span><strong className={dayGain >= 0 ? 'positive' : 'negative'}>{dayGain >= 0 ? '+' : ''}¥ {money(dayGain)}</strong></div></div>
      <div className="workbench-allocation-bar" aria-label="资产配置比例">
        {Object.entries(summary.buckets).map(([type, value]) => <span key={type} style={{ width: `${(Number(value) / summary.total_capital) * 100}%` }} className={`allocation-${type}`} />)}
      </div>
      <div className="workbench-finance-holdings">
        {holdings.slice(0, detailed ? holdings.length : 3).map((holding) => <button key={holding.id} onClick={() => onNotice(`演示模式：已打开「${holding.name}」的持仓详情。`)}><span><strong>{holding.name}</strong><small>{holding.symbol || '现金'} · {holding.value.toLocaleString('zh-CN')} 元</small></span><b className={(holding.day_gain || 0) >= 0 ? 'positive' : 'negative'}>{(holding.day_gain || 0) >= 0 ? '+' : ''}{money(holding.day_gain || 0)}</b><ChevronRight size={14} /></button>)}
      </div>
      <div className="workbench-market-areas">{marketAreas.map((area) => <span key={area.id}><i className={area.market.regime} />{area.title} <b>{area.quote.change_1d >= 0 ? '+' : ''}{area.quote.change_1d}%</b></span>)}</div>
      <button className="secondary workbench-small-action" onClick={() => onNotice('演示模式：已打开投资研究详情。')}><TrendingUp size={14} />打开投资研究</button>
    </section>
  );
}

function SyntheticSnapshotPanel({ snapshot }: { snapshot: ReturnType<typeof createSyntheticWorkbenchSnapshot> }) {
  return (
    <section className="workbench-snapshot-panel" aria-label="合成事件只读快照">
      <div className="workbench-snapshot-heading">
        <div><span className="workbench-snapshot-kicker">P0 EVENT SNAPSHOT</span><strong>工作台只读快照</strong></div>
        <span className="workbench-snapshot-badge">合成数据 · 只读</span>
      </div>
      <div className="workbench-snapshot-metrics"><span><b>{snapshot.eventCount}</b><small>事件</small></span><span><b>{snapshot.conversations.length}</b><small>对话运行</small></span><span><b>{snapshot.goals.length}</b><small>长期目标</small></span><span><b>{snapshot.schedules.length}</b><small>定时计划</small></span><span><b>{snapshot.attentions.length}</b><small>待决定</small></span></div>
      <div className="workbench-snapshot-events"><span>最近事件</span>{snapshot.eventIds.slice(-3).reverse().map((id: string) => <code key={id}>{id}</code>)}</div>
    </section>
  );
}

function SyntheticDphSyncPanel({ snapshot, onProgress, onAttention, onFinish }: { snapshot: ReturnType<typeof createSyntheticWorkbenchSnapshot>; onProgress: () => void; onAttention: () => void; onFinish: () => void }) {
  const run = snapshot.runs.find((item: { engine?: string }) => item.engine === 'DPH');
  const task = run ? snapshot.tasks.find((item: { id: string }) => item.id === run.taskId) : undefined;
  const attention = snapshot.attentions.find((item: { kind?: string; status?: string }) => item.kind === 'dph' && item.status !== 'resolved');
  return (
    <section className="workbench-dph-sync-panel" aria-label="DPH 仿真执行器">
      <div className="workbench-dph-sync-heading"><div><span className="workbench-snapshot-kicker">P2 DPH ADAPTER</span><strong>DPH 仿真执行器</strong></div><span className="workbench-snapshot-badge">状态同步 · 演示</span></div>
      <div className="workbench-dph-sync-body"><div><span className="workbench-engine-mark dph">DPH</span><span><strong>{task?.title || '合成任务尚未启动'}</strong><small>{run?.status || '未启动'} · {run?.progress || 0}% · {run?.report || '等待执行'}</small></span></div><span className={`workbench-run-status ${run?.status === 'finished' ? 'done' : run?.status === 'unknown_result' ? 'waiting' : 'running'}`}>{attention ? '等待用户' : run?.status || '未启动'}</span></div>
      <div className="workbench-dph-sync-actions"><button className="secondary" onClick={onProgress} disabled={run?.status === 'finished'}>模拟进度</button><button className="secondary" onClick={onAttention} disabled={!!attention || run?.status === 'finished'}>模拟等待用户</button><button className="primary" onClick={onFinish} disabled={run?.status === 'finished'}>模拟完成</button></div>
      <p>这些按钮只向本地 P2 事件存储写入合成事件，工作台从同一只读快照更新，不会调用真实 DPH。</p>
    </section>
  );
}

type SyntheticToolRouter = ReturnType<typeof createAgentToolRouter>;
type SyntheticToolCallResult = ReturnType<SyntheticToolRouter['call']>;

const syntheticToolGroups = [
  { domain: 'mail', label: '邮件', tools: ['mail.read', 'mail.draft_reply'] },
  { domain: 'learning', label: '学习', tools: ['learning.list_lessons', 'learning.generate_lesson'] },
  { domain: 'investment', label: '投资', tools: ['investment.read_holdings', 'investment.recommendations'] },
  { domain: 'remote', label: 'Remote', tools: ['remote.list_projects', 'remote.run_preview'] },
] as const;

function SyntheticToolRouterPanel({ router, onNotice }: { router: SyntheticToolRouter; onNotice: (value: string) => void }) {
  const [results, setResults] = useState<SyntheticToolCallResult[]>([]);
  const [selectedTool, setSelectedTool] = useState('mail.read');
  const inspection = router.inspect();

  function callTool(tool: string) {
    setSelectedTool(tool);
    const result = router.call({ tool, operationId: `p3:${tool}:${results.length + 1}` });
    setResults((current) => [result, ...current].slice(0, 4));
    onNotice(result.status === 'completed' ? `演示工具已完成：${tool}` : `权限验证：${tool} → ${result.status}`);
  }

  function verifyHighRisk() {
    const check = router.canCall('remote.execute');
    onNotice(check.allowed ? 'Remote 高风险权限已授予，但仍需二次确认。' : `Remote 高风险权限已拦截：${check.reason}`);
  }

  return (
    <section className="workbench-tool-router-panel" aria-label="P3 工作台工具路由与权限验证">
      <div className="workbench-tool-router-heading">
        <div><span className="workbench-snapshot-kicker">P3 TOOL ROUTER</span><strong>邮件 · 学习 · 投资 · Remote 工具</strong></div>
        <span className="workbench-snapshot-badge">合成数据 · 只读</span>
      </div>
      <div className="workbench-tool-router-meta"><span><b>{inspection.tools.length}</b> 个工具</span><span>当前权限 <b>{inspection.grant.level}</b></span><span>运行时 <b>{inspection.grant.runtime}</b></span><span>路由只返回演示结果</span></div>
      <div className="workbench-tool-router-grid">
        {syntheticToolGroups.map((group) => (
          <article className="workbench-tool-router-card" key={group.domain}>
            <header><strong>{group.label}</strong><small>{group.domain}</small></header>
            <div>{group.tools.map((tool) => <button key={tool} className={selectedTool === tool ? 'active' : ''} onClick={() => callTool(tool)}><span>{tool.split('.')[1]}</span><small>{inspection.tools.find((item: { name: string }) => item.name === tool)?.permission}</small></button>)}</div>
          </article>
        ))}
      </div>
      <div className="workbench-tool-router-actions"><button className="secondary" onClick={verifyHighRisk}>验证 Remote 高风险权限</button><span>高风险执行和发送始终停在确认态，不会执行真实操作。</span></div>
      {results.length > 0 && <div className="workbench-tool-router-results" aria-label="工具路由结果"><span>最近验证</span>{results.map((result, index) => <code key={`${result.tool}-${index}`}>{result.tool} · {result.status}{result.reason ? ` · ${result.reason}` : ''}</code>)}</div>}
    </section>
  );
}

type CreationMode = 'long' | 'schedule';
type CreationDraft = {
  mode: CreationMode;
  id?: string;
  title?: string;
  goal?: string;
  action?: string;
  cadence?: string;
  targetId?: string;
  engine?: 'Pi' | 'DPH';
};

function WorkbenchCreationDialog({ draft, conversations, close, submit }: { draft: CreationDraft; conversations: ConversationRun[]; close: () => void; submit: (value: { mode: CreationMode; id?: string; title: string; goal: string; action: string; cadence: string; targetId: string; engine: 'Pi' | 'DPH' }) => void }) {
  const [title, setTitle] = useState(draft.title || '');
  const [goal, setGoal] = useState(draft.goal || '');
  const [action, setAction] = useState(draft.action || '完成后回到对话汇报结果');
  const [cadence, setCadence] = useState(draft.cadence || '每 30 分钟');
  const [targetId, setTargetId] = useState(draft.targetId || 'new');
  const [engine, setEngine] = useState<'Pi' | 'DPH'>(draft.engine || 'DPH');
  const selected = conversations.find((conversation) => conversation.id === targetId);
  const editing = !!draft.id;
  return (
    <div className="workbench-create-backdrop" role="presentation" onClick={close}>
      <form className="workbench-create-dialog" role="dialog" aria-modal="true" aria-label={editing ? '编辑工作台任务' : '新建工作台任务'} onSubmit={(event) => { event.preventDefault(); if (!title.trim() || !targetId) return; submit({ mode: draft.mode, id: draft.id, title: title.trim(), goal: goal.trim(), action: action.trim(), cadence, targetId, engine }); }} onClick={(event) => event.stopPropagation()}>
        <header><div><div className="mail-schedule-section-kicker">{draft.mode === 'long' ? 'LONG HORIZON' : 'AUTOMATION'}</div><h2>{editing ? '修改绑定任务' : draft.mode === 'long' ? '新建长期任务' : '新建定时任务'}</h2></div><button type="button" className="icon-btn" aria-label="关闭" onClick={close}><X size={18} /></button></header>
        <p className="workbench-create-help">任务必须绑定一个对话。绑定后，执行结果、补充问题和历史记录都会回到同一条对话中。</p>
        <label className="workbench-create-field"><span>名称</span><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder={draft.mode === 'long' ? '例如：完成本周求职准备计划' : '例如：每 30 分钟刷新持仓'} /></label>
        {draft.mode === 'long' ? <label className="workbench-create-field"><span>目标说明</span><textarea required rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="写清楚完成标准和验收方式" /></label> : <label className="workbench-create-field"><span>每次执行内容</span><textarea required rows={3} value={action} onChange={(event) => setAction(event.target.value)} placeholder="描述每次触发时要交给 Agent 的任务" /></label>}
        <div className="workbench-create-field"><span>绑定对话</span><div className="workbench-target-options"><button type="button" className={targetId === 'new' ? 'active' : ''} onClick={() => setTargetId('new')}><Bot size={15} /><span><strong>新建对话并绑定</strong><small>首次运行时创建独立对话</small></span></button>{conversations.filter((conversation) => conversation.status !== '已完成' || conversation.id === draft.targetId).map((conversation) => <button type="button" key={conversation.id} className={targetId === conversation.id ? 'active' : ''} onClick={() => { setTargetId(conversation.id); setEngine(conversation.engine); }}><span className={`workbench-engine-mark ${conversation.engine.toLowerCase()}`}>{conversation.engine}</span><span><strong>{conversation.title}</strong><small>{conversation.project} · {conversation.status}</small></span></button>)}</div></div>
        {selected && <p className="workbench-selected-target">当前绑定：{selected.title} · {selected.engine}</p>}
        {draft.mode === 'long' ? <label className="workbench-create-field"><span>执行引擎</span><div className="workbench-choice-row">{(['DPH', 'Pi'] as const).map((value) => <button type="button" key={value} className={engine === value ? 'active' : ''} onClick={() => setEngine(value)}>{value}<small>{value === 'DPH' ? '适合拆解与长程编排' : '适合轻量连续执行'}</small></button>)}</div></label> : <label className="workbench-create-field"><span>运行频率</span><div className="workbench-choice-row">{['每 30 分钟', '每天 09:00', '每周日 20:00'].map((value) => <button type="button" key={value} className={cadence === value ? 'active' : ''} onClick={() => setCadence(value)}><Repeat2 size={14} />{value}</button>)}</div></label>}
        <footer><button type="button" className="secondary" onClick={close}>取消</button><button type="submit" className="primary" disabled={!title.trim() || !targetId}>{editing ? '保存修改' : '创建并绑定对话'}</button></footer>
      </form>
    </div>
  );
}

export function MailSchedulePage({ openMail, openConversation, scope = 'guest' }: { openMail: () => void; openConversation?: (id: string, title: string) => void; scope?: string }) {
  const [view, setView] = useState<'overview' | 'tasks' | 'inbox' | 'conversations' | 'long' | 'schedules' | 'finance'>('overview');
  const [tasks, setTasks] = useState(demoTasks);
  const [conversationRuns, setConversationRuns] = useState(demoConversationRuns);
  const [longTasks, setLongTasks] = useState(demoLongTasks);
  const [schedules, setSchedules] = useState(demoScheduledTasks);
  const [selectedTask, setSelectedTask] = useState<ScheduleTask | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [scanning, setScanning] = useState(false);
  const [creation, setCreation] = useState<CreationDraft | null>(null);
  const dphDemo = useMemo(() => {
    const ownerId = `demo:${scope}`;
    const store = createPersonalAgentStore({ ownerId });
    for (const item of createSyntheticAgentEvents({ ownerId })) store.append(item);
    store.createTask({ taskId: 'p2-demo-task', title: 'DPH 合成状态同步任务', conversationId: 'demo-conversation-1', engine: 'DPH' }, 'p2-demo-task');
    const adapter = createDphExecutorAdapter({ store });
    adapter.start({ runId: 'p2-demo-run', taskId: 'p2-demo-task', conversationId: 'demo-conversation-1' }, 'p2-demo-run');
    return { store, adapter };
  }, [scope]);
  const toolDemo = useMemo(() => createAgentToolRouter({
    grant: {
      accountId: `demo-account:${scope}`,
      conversationId: 'demo-conversation-1',
      projectId: 'demo-project',
      runtime: 'DPH',
      level: 'L1',
      allowedDomains: ['mail', 'learning', 'investment', 'remote'],
    },
  }), [scope]);
  const [dphSnapshot, setDphSnapshot] = useState(() => dphDemo.store.snapshot());
  useEffect(() => {
    setDphSnapshot(dphDemo.store.snapshot());
  }, [dphDemo]);

  function refreshDphSnapshot() {
    setDphSnapshot(dphDemo.store.snapshot());
  }

  function simulateDphProgress() {
    dphDemo.adapter.progress({ runId: 'p2-demo-run', taskId: 'p2-demo-task', progress: Math.min(90, (dphSnapshot.runs.find((run: { id: string }) => run.id === 'p2-demo-run')?.progress || 0) + 20), step: '仿真 DPH 正在整理工作台上下文', report: '仿真状态已同步' }, `p2-progress-${Date.now()}`);
    refreshDphSnapshot();
  }

  function simulateDphAttention() {
    dphDemo.adapter.waitForUser({ attentionId: 'p2-demo-attention', title: 'DPH 需要确认', question: '是否继续执行下一步？' }, 'p2-attention');
    refreshDphSnapshot();
  }

  function simulateDphFinish() {
    dphDemo.adapter.finish({ runId: 'p2-demo-run', taskId: 'p2-demo-task', report: '仿真 DPH 已完成，等待验收' }, `p2-finish-${Date.now()}`);
    refreshDphSnapshot();
  }

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
    setNotice('已标记完成，演示数据只保存在当前页面。');
  }

  function scanDemo() {
    if (scanning) return;
    setScanning(true);
    window.setTimeout(() => {
      setScanning(false);
      setNotice('演示扫描完成，发现 3 封重要邮件。未连接真实邮箱。');
    }, 650);
  }

  function toggleSchedule(id: string) {
    setSchedules((current) => current.map((schedule) => schedule.id === id ? { ...schedule, status: schedule.status === '启用' ? '已暂停' : '启用' } : schedule));
    setNotice('演示模式：已更新定时任务开关，不会执行真实计划。');
  }

  function openTargetConversation(id: string, title: string) {
    if (openConversation) openConversation(id, title);
    else setNotice(`已选择「${title}」作为目标对话。`);
  }

  function submitCreation(value: { mode: CreationMode; id?: string; title: string; goal: string; action: string; cadence: string; targetId: string; engine: 'Pi' | 'DPH' }) {
    let conversationId = value.targetId;
    let conversationTitle = conversationRuns.find((conversation) => conversation.id === conversationId)?.title || '';
    if (value.targetId === 'new') {
      conversationId = `demo-conversation-${Date.now()}`;
      conversationTitle = value.title;
      setConversationRuns((current) => [{ id: conversationId, title: conversationTitle, project: '工作台 · 新建对话', engine: value.engine, status: '等待回复', progress: 0, round: 0, tools: 0, updated: '刚刚创建', conversationId, conversationTitle }, ...current]);
    }
    if (value.mode === 'long') {
      const existing = longTasks.find((task) => task.id === value.id);
      const next: LongTask = { id: value.id || `long-task-${Date.now()}`, title: value.title, goal: value.goal, status: existing?.status || '执行中', progress: existing?.progress || 0, step: existing?.step || '等待对话首次执行', steps: existing?.steps || ['收集来源', '拆分任务', '执行计划', '检查冲突', '等待验收'], nextCheck: existing?.nextCheck || '首次运行后', engine: value.engine, conversationId, conversationTitle };
      setLongTasks((current) => value.id ? current.map((task) => task.id === value.id ? next : task) : [next, ...current]);
    } else {
      const existing = schedules.find((schedule) => schedule.id === value.id);
      const next: ScheduledTask = { id: value.id || `schedule-${Date.now()}`, title: value.title, target: conversationTitle, cadence: value.cadence, nextRun: existing?.nextRun || '等待首次运行', lastRun: existing?.lastRun || '尚未运行', status: existing?.status || '启用', action: value.action, conversationId, conversationTitle };
      setSchedules((current) => value.id ? current.map((schedule) => schedule.id === value.id ? next : schedule) : [next, ...current]);
    }
    setCreation(null);
    setNotice(value.id ? '绑定任务已修改。' : '已创建任务并绑定目标对话。');
  }

  return (
    <div className="mail-schedule-page">
      <header className="mail-schedule-heading">
        <div>
          <div className="mail-schedule-eyebrow">邮日程 · MAIL SCHEDULE</div>
          <h1>今天，先处理最重要的事。</h1>
          <p>把重要邮件变成可执行、可编辑、可提醒的任务。</p>
        </div>
        <div className="mail-schedule-heading-actions">
          <button className="secondary" onClick={scanDemo} disabled={scanning}>
            <RefreshCw size={16} className={scanning ? 'spin' : ''} />
            {scanning ? '扫描中…' : '扫描演示邮件'}
          </button>
          <button className="primary" onClick={() => setView('conversations')}>
            <CheckCircle2 size={16} />
            查看运行中的任务
          </button>
        </div>
      </header>

      <div className="mail-schedule-demo-banner" role="status">
        <span className="mail-schedule-demo-dot" />
        <strong>演示数据</strong>
        <span>当前使用本地合成的邮件和任务，不会读取或写入真实邮箱。</span>
        <button className="text-link" onClick={openMail}>
          打开邮件插件 <ArrowRight size={14} />
        </button>
      </div>
      <SyntheticSnapshotPanel snapshot={dphSnapshot} />
      <SyntheticDphSyncPanel snapshot={dphSnapshot} onProgress={simulateDphProgress} onAttention={simulateDphAttention} onFinish={simulateDphFinish} />
      <SyntheticToolRouterPanel router={toolDemo} onNotice={setNotice} />

      <nav className="mail-schedule-tabs" aria-label="工作台视图">
        {[
          ['overview', '今日概览'],
          ['conversations', '对话任务'],
          ['long', '长期任务'],
          ['schedules', '定时任务'],
          ['finance', '资产提醒'],
          ['tasks', '所有任务'],
          ['inbox', '邮件事项'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={view === id ? 'active' : ''}
            onClick={() => setView(id as typeof view)}
            aria-pressed={view === id}
          >
            {label}
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
              {demoMails.map((mail) => (
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
            </div>
          </section>

          <div className="workbench-overview-grid">
            <ConversationPanel runs={conversationRuns} onNotice={setNotice} onOpenConversation={openTargetConversation} />
            <LongTasksPanel tasks={longTasks} onNotice={setNotice} onCreate={() => setCreation({ mode: 'long' })} onEdit={(task) => setCreation({ mode: 'long', id: task.id, title: task.title, goal: task.goal, targetId: task.conversationId, engine: task.engine })} onOpenConversation={openTargetConversation} />
          </div>
          <div className="workbench-overview-grid">
            <SchedulesPanel schedules={schedules} onToggle={toggleSchedule} onNotice={setNotice} onCreate={() => setCreation({ mode: 'schedule' })} onEdit={(schedule) => setCreation({ mode: 'schedule', id: schedule.id, title: schedule.title, action: schedule.action, cadence: schedule.cadence, targetId: schedule.conversationId })} onOpenConversation={openTargetConversation} />
            <FinancePanel onNotice={setNotice} />
          </div>
        </>
      ) : view === 'conversations' ? (
        <ConversationPanel runs={conversationRuns} detailed onNotice={setNotice} onOpenConversation={openTargetConversation} />
      ) : view === 'long' ? (
        <LongTasksPanel tasks={longTasks} detailed onNotice={setNotice} onCreate={() => setCreation({ mode: 'long' })} onEdit={(task) => setCreation({ mode: 'long', id: task.id, title: task.title, goal: task.goal, targetId: task.conversationId, engine: task.engine })} onOpenConversation={openTargetConversation} />
      ) : view === 'schedules' ? (
        <SchedulesPanel schedules={schedules} detailed onToggle={toggleSchedule} onNotice={setNotice} onCreate={() => setCreation({ mode: 'schedule' })} onEdit={(schedule) => setCreation({ mode: 'schedule', id: schedule.id, title: schedule.title, action: schedule.action, cadence: schedule.cadence, targetId: schedule.conversationId })} onOpenConversation={openTargetConversation} />
      ) : view === 'finance' ? (
        <FinancePanel detailed onNotice={setNotice} />
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
            {!filteredTasks.length && <div className="mail-schedule-empty">没有匹配的演示任务。</div>}
          </div>
        </section>
      ) : (
        <section className="mail-schedule-panel mail-schedule-inbox">
          <div className="mail-schedule-panel-heading">
            <div>
              <div className="mail-schedule-section-kicker">INBOX</div>
              <h2>邮件事项</h2>
            </div>
            <span className="mail-schedule-inbox-count"><Inbox size={15} /> {demoMails.length} 封重要邮件</span>
          </div>
          <div className="mail-schedule-mail-list expanded">
            {demoMails.map((mail) => (
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
          <div className="mail-schedule-inbox-note"><MessageSquareText size={16} /> Demo 只展示邮件事项，接入 QQ 邮箱后会在这里显示真实扫描结果。</div>
        </section>
      )}

      {notice && <div className="mail-schedule-inline-notice" role="status">{notice}</div>}
      {creation && <WorkbenchCreationDialog draft={creation} conversations={conversationRuns} close={() => setCreation(null)} submit={submitCreation} />}
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
