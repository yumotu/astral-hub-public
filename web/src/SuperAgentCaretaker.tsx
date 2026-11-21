import { useEffect, useRef, useState } from 'react';
import { api } from './data';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleDot,
  CheckCircle2,
  Clock3,
  ListChecks,
  Paperclip,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import type { Page, Settings } from './types';

type SuperAgentCaretakerProps = {
  connected: boolean;
  scope: string;
  settings: Settings;
  onNavigate: (page: Page) => void;
  onNotice: (message: string) => void;
};

type CaretakerMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  mode?: 'delegate';
};

type CaretakerActivity = {
  id: string;
  title: string;
  status: '进行中' | '待决定' | '已完成';
  updatedAt: string;
};

const seedMessage: CaretakerMessage = {
  id: 'superagent-welcome',
  role: 'assistant',
  text: '我是你的 SuperAgent 管家。告诉我想达成的结果，我会先抓住重点，再决定是直接回答还是委派执行。',
};

const seedActivities: CaretakerActivity[] = [
  { id: 'superagent-activity-mail', title: '整理本周邮件并生成待办', status: '进行中', updatedAt: '刚刚' },
  { id: 'superagent-activity-investment', title: '刷新持仓并核对相对昨日盈亏', status: '待决定', updatedAt: '12 分钟前' },
  { id: 'superagent-activity-learning', title: '整理 RAG 复习错题', status: '已完成', updatedAt: '今天 09:30' },
];

function storageKey(scope: string) {
  return `astral.superagent.caretaker:${scope}`;
}

function activityStorageKey(scope: string) {
  return `astral.superagent.activity:${scope}`;
}

function loadMessages(scope: string): CaretakerMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(scope) || '') || 'null');
    if (!Array.isArray(value)) return [seedMessage];
    const messages = value
      .filter((item): item is CaretakerMessage => item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
      .slice(-24);
    return messages.length ? messages : [seedMessage];
  } catch {
    return [seedMessage];
  }
}

function loadActivities(scope: string): CaretakerActivity[] {
  try {
    const value = JSON.parse(localStorage.getItem(activityStorageKey(scope)) || 'null');
    if (!Array.isArray(value)) return seedActivities;
    const activities = value.filter((item): item is CaretakerActivity => item && typeof item.id === 'string' && typeof item.title === 'string' && ['进行中', '待决定', '已完成'].includes(item.status));
    return activities.length ? activities.slice(-12) : seedActivities;
  } catch {
    return seedActivities;
  }
}

function responseFor(input: string) {
  const focus = input.replace(/\s+/g, ' ').trim().slice(0, 48);
  return `已抓住重点：「${focus}」。我会把它交给 subagent 执行，完成后由我整理结果并回复你，进展会回收到工作台。当前是演示模式，执行前仍会检查权限。`;
}

function serverActivity(task: { id: string; title: string; status: string; updatedAt?: string; updated_at?: string }): CaretakerActivity {
  return {
    id: task.id,
    title: task.title,
    status: task.status === 'waiting_user' ? '待决定' : ['queued', 'running'].includes(task.status) ? '进行中' : '已完成',
    updatedAt: task.updatedAt || task.updated_at || '刚刚',
  };
}

export function SuperAgentCaretaker({ connected, scope, settings, onNavigate, onNotice }: SuperAgentCaretakerProps) {
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<'chat' | 'activity'>('chat');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<CaretakerMessage[]>(() => loadMessages(scope));
  const [activities, setActivities] = useState<CaretakerActivity[]>(() => loadActivities(scope));
  const [thinking, setThinking] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setMessages(loadMessages(scope));
    setActivities(loadActivities(scope));
    setDraft('');
    setView('chat');
    setThinking(false);
  }, [scope]);

  useEffect(() => {
    if (!(settings.sessionToken || settings.token)) return;
    let active = true;
    void api<{ tasks: { id: string; title: string; status: string; updatedAt?: string }[] }>(settings, '/superagent/tasks')
      .then((snapshot) => {
        if (!active || !snapshot.tasks.length) return;
        setActivities(snapshot.tasks.map(serverActivity));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [settings, scope]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(scope), JSON.stringify(messages.slice(-24)));
    } catch {
      onNotice('SuperAgent 对话暂时无法写入设备存储。');
    }
  }, [messages, onNotice, scope]);

  useEffect(() => {
    try {
      localStorage.setItem(activityStorageKey(scope), JSON.stringify(activities.slice(-12)));
    } catch {
      onNotice('SuperAgent 活动记录暂时无法写入设备存储。');
    }
  }, [activities, onNotice, scope]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function submit(value = draft) {
    const text = value.trim();
    if (!text || thinking) return;
    const userMessage: CaretakerMessage = { id: crypto.randomUUID(), role: 'user', text, mode: 'delegate' };
    setMessages((current) => [...current, userMessage].slice(-24));
    const activity: CaretakerActivity = { id: crypto.randomUUID(), title: text.slice(0, 52), status: '进行中', updatedAt: '刚刚' };
    setActivities((current) => [activity, ...current].slice(0, 12));
    if (settings.sessionToken || settings.token) {
      void api<{ task: { id: string; title: string; status: string; updatedAt?: string } }>(settings, '/superagent/tasks', {
        id: activity.id,
        title: activity.title,
        input: text,
        runtime: 'DPH',
      })
        .then(({ task }) => setActivities((current) => [serverActivity(task), ...current.filter((item) => item.id !== activity.id)].slice(0, 12)))
        .catch(() => {});
    }
    setDraft('');
    setThinking(true);
    timer.current = window.setTimeout(() => {
      const reply: CaretakerMessage = { id: crypto.randomUUID(), role: 'assistant', text: responseFor(text), mode: 'delegate' };
      setMessages((current) => [...current, reply].slice(-24));
      setThinking(false);
    }, 420);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <section className={`superagent-caretaker ${expanded ? 'is-expanded' : ''}`} aria-label="SuperAgent 智能体助手管家">
      <button
        className="superagent-caretaker-trigger"
        aria-expanded={expanded}
        aria-controls="superagent-caretaker-panel"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="superagent-caretaker-orb"><Bot size={18} /></span>
        <span className="superagent-caretaker-title"><strong>SuperAgent</strong><small>长期智能体管家</small></span>
        <span className={`superagent-caretaker-status ${connected ? 'is-connected' : ''}`}><CircleDot size={10} />{connected ? '在线' : '演示'}</span>
        {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>

      {expanded && (
        <div className="superagent-caretaker-panel" id="superagent-caretaker-panel">
          <div className="superagent-caretaker-panel-heading">
            <div><span className="superagent-caretaker-kicker"><Sparkles size={11} />LEADER · PERSONAL AGENT</span><strong>告诉我目标，我来委派</strong></div>
            <div className="superagent-caretaker-window-actions"><span className="superagent-caretaker-runtime">短思考 · 委派执行</span><button className="icon-btn" aria-label="关闭 SuperAgent 对话窗口" onClick={() => setExpanded(false)}><X size={15} /></button></div>
          </div>
          <div className="superagent-caretaker-tabs" role="tablist" aria-label="SuperAgent 内容">
            <button role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>对话</button>
            <button role="tab" aria-selected={view === 'activity'} className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>Activity <span>{activities.filter((item) => item.status !== '已完成').length}</span></button>
          </div>
          {view === 'chat' ? <div className="superagent-caretaker-messages" aria-live="polite">
            {messages.slice(-6).map((message) => <div className={`superagent-caretaker-message ${message.role}`} key={message.id}>{message.mode === 'delegate' && <span className="superagent-caretaker-message-mode"><Zap size={10} />委派给 subagent</span>}<p>{message.text}</p></div>)}
            {thinking && <div className="superagent-caretaker-thinking"><span /><span /><span />正在抓住重点…</div>}
          </div> : <div className="superagent-caretaker-activities" aria-label="委派活动">
            {activities.map((activity) => <button className="superagent-caretaker-activity" key={activity.id} onClick={() => onNavigate('workspace')}><span className={`superagent-caretaker-activity-icon ${activity.status === '进行中' ? 'running' : activity.status === '待决定' ? 'waiting' : 'done'}`}>{activity.status === '进行中' ? <Clock3 size={13} /> : activity.status === '待决定' ? <ListChecks size={13} /> : <CheckCircle2 size={13} />}</span><span><strong>{activity.title}</strong><small>subagent · {activity.updatedAt}</small></span><span className="superagent-caretaker-activity-status">{activity.status}</span></button>)}
          </div>}
          <div className="superagent-caretaker-mode" role="status"><Zap size={13} />仅委派执行 · subagent 执行后由 Leader 汇报</div>
          <div className="superagent-caretaker-compose">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} rows={2} placeholder="描述目标，我会抓住重点并委派给 subagent…" aria-label="和 SuperAgent 对话" />
            <div><button className="superagent-caretaker-attach" aria-label="添加上下文" onClick={() => onNotice('上下文附件入口已保留，当前 Demo 不上传真实文件。')}><Paperclip size={14} /></button><button className="superagent-caretaker-send" aria-label="发送给 SuperAgent" disabled={!draft.trim() || thinking} onClick={() => submit()}><ArrowUp size={15} /></button></div>
          </div>
          <div className="superagent-caretaker-quick"><button onClick={() => submit('安排今天最重要的三件事')}>安排今天</button><button onClick={() => submit('整理邮件和长期任务')}>整理任务</button><button onClick={() => setDraft('帮我持续推进这个目标')}>持续推进</button><button className="superagent-caretaker-open-workbench" onClick={() => onNavigate('workspace')}>查看工作台</button></div>
          <p className="superagent-caretaker-retention">对话按当前账号保存在本机，跨页面继续。Leader 不直接执行任务，subagent 完成后再回传结果。</p>
        </div>
      )}
    </section>
  );
}
