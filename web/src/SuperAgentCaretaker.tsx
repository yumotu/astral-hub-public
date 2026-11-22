import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Bot, CheckCircle2, CircleDot, Clock3, Paperclip, Sparkles, X } from 'lucide-react';
import { api } from './data';
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
  createdAt: string;
  taskId?: string;
  state?: 'thinking' | 'delegated' | 'report';
};

type DelegatedTask = {
  id: string;
  title: string;
  status: string;
  progress?: number;
  report?: string;
  attention?: string;
  revision?: number;
  updatedAt?: string;
  createdAt?: string;
};

const welcome: CaretakerMessage = {
  id: 'superagent-welcome',
  role: 'assistant',
  text: '你好，我是你的 SuperAgent 管家。你可以像发微信一样告诉我想完成什么，我会先抓住重点，再交给 subagent 执行，完成后把结果带回这条对话。',
  createdAt: new Date(0).toISOString(),
};

function messagesKey(scope: string) {
  return 'astral.superagent.chat:' + scope;
}

function readMessages(scope: string): CaretakerMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(messagesKey(scope)) || 'null');
    if (!Array.isArray(value)) return [welcome];
    const result = value.filter((item): item is CaretakerMessage =>
      item && (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string',
    );
    return result.length ? result.slice(-60) : [welcome];
  } catch {
    return [welcome];
  }
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return '';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function taskLabel(task: DelegatedTask) {
  if (task.status === 'waiting_user') return '等待你的回复';
  if (task.status === 'succeeded') return '已完成';
  if (task.status === 'failed') return '执行失败';
  if (task.status === 'unknown') return '待核对';
  if (task.status === 'cancelled') return '已停止';
  if (task.status === 'running') return '执行中';
  return '排队中';
}

function taskMessage(task: DelegatedTask) {
  const status = taskLabel(task);
  const detail = task.report || task.attention;
  return detail ? 'subagent · ' + status + '（' + detail + '）' : 'subagent · ' + status + (typeof task.progress === 'number' ? ' · ' + task.progress + '%' : '');
}

export function SuperAgentCaretaker({ connected, scope, settings, onNavigate, onNotice }: SuperAgentCaretakerProps) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<CaretakerMessage[]>(() => readMessages(scope));
  const [tasks, setTasks] = useState<DelegatedTask[]>([]);
  const [thinking, setThinking] = useState(false);
  const seenReports = useRef(new Map<string, number>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setMessages(readMessages(scope));
    setTasks([]);
    seenReports.current.clear();
  }, [scope]);

  useEffect(() => {
    try {
      localStorage.setItem(messagesKey(scope), JSON.stringify(messages.slice(-60)));
    } catch {
      onNotice('SuperAgent 对话暂时无法写入设备存储。');
    }
  }, [messages, onNotice, scope]);

  useEffect(() => {
    if (!(settings.sessionToken || settings.token)) return;
    let active = true;
    const poll = () => {
      void api<{ tasks: DelegatedTask[] }>(settings, '/superagent/tasks', undefined, undefined, false, { fresh: true })
        .then((snapshot) => {
          if (!active) return;
          setTasks(snapshot.tasks || []);
          for (const task of snapshot.tasks || []) {
            const revision = task.revision || 0;
            const key = task.id + ':' + revision;
            if (!task.report && !task.attention) continue;
            if (seenReports.current.has(task.id) && seenReports.current.get(task.id) === revision) continue;
            seenReports.current.set(task.id, revision);
            const message: CaretakerMessage = {
              id: 'task-report-' + key,
              role: 'assistant',
              text: taskMessage(task),
              createdAt: task.updatedAt || new Date().toISOString(),
              taskId: task.id,
              state: 'report',
            };
            setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message].slice(-60));
          }
        })
        .catch(() => {});
    };
    poll();
    const interval = window.setInterval(poll, expanded ? 2500 : 7000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [expanded, settings]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function appendAssistant(text: string, state: CaretakerMessage['state'] = 'delegated') {
    setMessages((current) => [...current, {
      id: crypto.randomUUID(),
      role: 'assistant' as const,
      text,
      createdAt: new Date().toISOString(),
      state,
    }].slice(-60));
  }

  function submit(value = draft) {
    const text = value.trim();
    if (!text || thinking) return;
    const id = crypto.randomUUID();
    setMessages((current) => [...current, {
      id,
      role: 'user' as const,
      text,
      createdAt: new Date().toISOString(),
    }].slice(-60));
    setDraft('');
    setThinking(true);
    timer.current = window.setTimeout(() => {
      appendAssistant('收到。我先确认目标和边界，再把执行交给 subagent。你可以继续补充要求，我会把补充内容接到同一个任务上。');
      setThinking(false);
    }, 320);
    if (!(settings.sessionToken || settings.token)) {
      appendAssistant('当前还没有登录账号，我可以继续和你整理目标，但暂时不能创建真实委派任务。');
      return;
    }
    void api<{ task: DelegatedTask }>(settings, '/superagent/tasks', {
      id,
      title: text.slice(0, 120),
      input: text,
      runtime: 'DPH',
      conversationId: null,
      projectId: null,
    }).then(({ task }) => {
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      appendAssistant('已委派给 subagent，任务状态会在这里持续更新。', 'delegated');
    }).catch((error) => {
      appendAssistant('委派没有成功：' + (error instanceof Error ? error.message : '服务器暂时不可用') + '。我保留了你的原始消息。', 'report');
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const activeCount = tasks.filter((task) => !['succeeded', 'failed', 'cancelled'].includes(task.status)).length;

  return (
    <section className={'superagent-caretaker ' + (expanded ? 'is-expanded' : '')} aria-label="SuperAgent 智能体助手管家">
      <button className="superagent-caretaker-trigger" aria-expanded={expanded} aria-controls="superagent-caretaker-panel" onClick={() => setExpanded((value) => !value)}>
        <span className="superagent-caretaker-orb"><Bot size={18} /></span>
        <span className="superagent-caretaker-title"><strong>SuperAgent</strong><small>你的长期对话管家</small></span>
        <span className={'superagent-caretaker-status ' + (connected ? 'is-connected' : '')}><CircleDot size={10} />{connected ? '在线' : '未连接'}</span>
        {activeCount > 0 && <span className="superagent-caretaker-count">{activeCount}</span>}
      </button>
      {expanded && (
        <div className="superagent-caretaker-panel" id="superagent-caretaker-panel">
          <header className="superagent-chat-header">
            <div className="superagent-chat-identity"><span className="superagent-chat-avatar"><Bot size={18} /></span><span><strong>SuperAgent 管家</strong><small><span className="superagent-online-dot" />短思考 · 委派给 subagent</small></span></div>
            <button className="icon-btn" aria-label="关闭 SuperAgent 对话窗口" onClick={() => setExpanded(false)}><X size={17} /></button>
          </header>
          <div className="superagent-chat-status"><Sparkles size={13} />我负责理解和汇报，subagent 负责执行</div>
          <div className="superagent-caretaker-messages" aria-live="polite">
            {messages.slice(-24).map((message) => (
              <div className={'superagent-chat-row ' + message.role} key={message.id}>
                {message.role === 'assistant' && <span className="superagent-chat-avatar small"><Bot size={13} /></span>}
                <div className="superagent-chat-bubble"><p>{message.text}</p>{message.taskId && <small><Clock3 size={11} />{message.state === 'report' ? '执行状态已回传' : '委派任务'}</small>}<time>{timeLabel(message.createdAt)}</time></div>
              </div>
            ))}
            {thinking && <div className="superagent-chat-row assistant"><span className="superagent-chat-avatar small"><Bot size={13} /></span><div className="superagent-chat-bubble thinking"><i /><i /><i /><span>正在理解你的意思…</span></div></div>}
          </div>
          <div className="superagent-chat-quick"><button onClick={() => submit('安排今天最重要的三件事')}>安排今天</button><button onClick={() => submit('整理邮件和长期任务')}>整理任务</button><button onClick={() => setDraft('帮我持续推进这个目标')}>持续推进</button><button onClick={() => onNavigate('workspace')}>打开工作台</button></div>
          <div className="superagent-caretaker-compose">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} rows={2} placeholder="发消息给你的管家…" aria-label="和 SuperAgent 对话" />
            <div><button className="superagent-caretaker-attach" aria-label="添加上下文" onClick={() => onNotice('请在对应对话中添加附件，SuperAgent 会沿用当前账号上下文。')}><Paperclip size={15} /></button><button className="superagent-caretaker-send" aria-label="发送给 SuperAgent" disabled={!draft.trim() || thinking} onClick={() => submit()}><ArrowUp size={16} /></button></div>
          </div>
          <p className="superagent-caretaker-retention">对话按当前账号保存在本机，刷新后继续。打开工作台可查看真实任务、目标、计划、邮件和持仓。</p>
          <div className="superagent-chat-footer"><span><CheckCircle2 size={12} />Leader 不直接执行</span><button onClick={() => onNavigate('workspace')}>查看工作台</button></div>
        </div>
      )}
    </section>
  );
}
