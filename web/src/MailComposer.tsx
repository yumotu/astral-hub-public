import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { X, Send, Save, Sparkles, LoaderCircle, Square, Check, ChevronDown } from 'lucide-react';
import { api } from './data';
import { usePiTasks, taskPending, taskLabel, type PiTask } from './pi-tasks';
import { PiMarkdown } from './PiMarkdown';
import { useComposerSize, useMailEditorFocus } from './mobile-viewport';
import type { Settings } from './types';
import './mail-composer.css';
export type ReplySource = {
  uid: number;
  mailbox: string;
  to: string;
  subject: string;
  text: string;
  initialDraft?: string;
};
type Draft = {
  id: string;
  to: string;
  subject: string;
  text: string;
  conversationId: string;
  taskId?: string;
  instruction?: string;
};
type Confirmation = {
  confirmation: string;
  expiresAt: number;
  from: string;
  to: string[];
  subject: string;
  text: string;
};
export function MailComposer({
  settings,
  address,
  reply,
  onClose,
}: {
  settings: Settings;
  address: string;
  reply: ReplySource | null;
  onClose: () => void;
}) {
  const key = `astral.mail.compose:${address}:${reply ? `${reply.mailbox}:${reply.uid}` : 'new'}`;
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (
        saved &&
        typeof saved.text === 'string' &&
        typeof saved.to === 'string' &&
        typeof saved.id === 'string'
      )
        return saved;
    } catch {}
    return {
      id: crypto.randomUUID(),
      to: reply?.to || '',
      subject: reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '',
      text: reply?.initialDraft || '',
      conversationId: crypto.randomUUID(),
    };
  });
  const [instruction, setInstruction] = useState(draft.instruction || ''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(''),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [localTask, setLocalTask] = useState<PiTask | null>(null),
    [sent, setSent] = useState(false),
    [previousText, setPreviousText] = useState<string | null>(null),
    [sendUnknown, setSendUnknown] = useState(false),
    [agentOpen, setAgentOpen] = useState(true);
  const { tasks, connection, failure, reconnect } = usePiTasks(settings, true);
  const task = tasks.find((t) => t.id === draft.taskId) || localTask;
  const active = !!task && taskPending(task),
    valid = !!draft.to.trim() && !!draft.subject.trim() && !!draft.text.trim();
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null),
    body = useRef<HTMLTextAreaElement>(null),
    agentInput = useRef<HTMLTextAreaElement>(null);
  useComposerSize(body, draft.text, { min: 120, max: 440, ratio: 0.42 });
  useComposerSize(agentInput, instruction, { min: 68 });
  useMailEditorFocus(panel);
  const attempt = useRef<{ id: string; signature: string } | null>(null);
  useBackLayer(
    true,
    () => {
      if (busy) return;
      if (confirmation) setConfirmation(null);
      else onClose();
    },
    100,
  );
  useEffect(() => {
    if (innerWidth > 800 && !reply) input.current?.focus();
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        if (confirmation) setConfirmation(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, confirmation, onClose]);
  useEffect(() => {
    try {
      if (!sent) localStorage.setItem(key, JSON.stringify({ ...draft, instruction }));
    } catch {
      setNotice('本机无法保存草稿，请手动保存到邮箱。');
    }
  }, [key, draft, instruction, sent]);
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
  const update = (field: 'to' | 'subject' | 'text', value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setConfirmation(null);
    setConfirmed(false);
    setNotice('');
  };
  const fields = () => ({
    id: draft.id,
    to: draft.to
      .split(/[,;，；]/)
      .map((x) => x.trim())
      .filter(Boolean),
    subject: draft.subject,
    text: draft.text,
    ...(reply ? { reply: { uid: reply.uid, mailbox: reply.mailbox } } : {}),
  });
  async function save() {
    setBusy('save');
    setError('');
    try {
      const result = await api<{ draftMailbox: string; warning?: string }>(
        settings,
        '/mail/compose/draft',
        fields(),
      );
      setNotice(result.warning || `已保存到邮箱草稿 · ${result.draftMailbox}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function prepare() {
    setBusy('prepare');
    setError('');
    setConfirmed(false);
    try {
      setConfirmation(await api<Confirmation>(settings, '/mail/compose/prepare', fields()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function send() {
    if (!confirmation || !confirmed) return;
    setBusy('send');
    setError('');
    try {
      await api(settings, '/mail/compose/send', {
        confirmation: confirmation.confirmation,
        confirm: true,
      });
      setSent(true);
      setNotice('邮件已发送');
      setConfirmation(null);
      try {
        localStorage.removeItem(key);
      } catch {}
    } catch (e) {
      setError((e as Error).message);
      setSendUnknown(true);
    } finally {
      setBusy('');
    }
  }
  async function assist() {
    if (!instruction.trim() || active) return;
    setBusy('agent');
    setError('');
    const signature = JSON.stringify([
      instruction,
      draft.to,
      draft.subject,
      draft.text,
      reply?.uid,
      reply?.mailbox,
    ]);
    const id = attempt.current?.signature === signature ? attempt.current.id : crypto.randomUUID();
    attempt.current = { id, signature };
    setDraft((d) => ({ ...d, taskId: id }));
    try {
      const r = await api<{ task: PiTask }>(settings, '/mail/compose/assist', {
        id,
        conversationId: draft.conversationId,
        instruction,
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        ...(reply ? { reply: { uid: reply.uid, mailbox: reply.mailbox } } : {}),
      });
      setLocalTask(r.task);
      setDraft((d) => ({ ...d, taskId: id }));
      attempt.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="mail-compose-overlay">
      <section
        ref={panel}
        className="mail-composer"
        role="dialog"
        aria-modal="true"
        aria-label={reply ? '撰写回复' : '编写邮件'}
      >
        <header>
          <div>
            <h2>{reply ? '撰写回复' : '编写邮件'}</h2>
            <small>
              {address} · {sent ? '已发送' : '草稿自动保存在本机'}
            </small>
          </div>
          <button
            className="icon-btn"
            aria-label="关闭写信窗口"
            disabled={busy === 'send'}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="mail-compose-content">
          <div className="mail-compose-edit">
            <label>
              收件人
              <input
                ref={input}
                value={draft.to}
                onChange={(e) => update('to', e.target.value)}
                readOnly={!!reply || sent}
                maxLength={2600}
                placeholder="name@example.com；多个地址用分号分隔"
                autoComplete="email"
              />
            </label>
            <label>
              主题
              <input
                value={draft.subject}
                onChange={(e) => update('subject', e.target.value)}
                maxLength={300}
                readOnly={sent}
                placeholder="邮件主题"
              />
            </label>
            <textarea
              ref={body}
              className="mail-compose-body"
              aria-label="邮件正文"
              placeholder="在这里写下你的邮件，也可以让右侧助手先起草…"
              value={draft.text}
              onChange={(e) => update('text', e.target.value)}
              maxLength={20000}
              readOnly={sent}
            />
            {reply && (
              <details className="mail-compose-original">
                <summary>查看原邮件</summary>
                <pre>{reply.text}</pre>
              </details>
            )}
            <small className="mail-compose-count">
              {draft.text.length.toLocaleString()} / 20,000 字
            </small>
          </div>
          <aside className={`mail-compose-agent ${agentOpen ? 'expanded' : ''}`}>
            <button
              className="mail-compose-agent-heading"
              aria-expanded={agentOpen}
              onClick={() => setAgentOpen(!agentOpen)}
            >
              <Sparkles size={16} />
              <strong>Pi 撰写助手</strong>
              <ChevronDown size={14} />
            </button>
            <div className="mail-compose-agent-content">
              <p className="field-help">
                描述意图、语气或修改要求。助手只起草正文；你选择采用后再保存或发送。
              </p>
              <div className="mail-compose-presets">
                {['简洁、礼貌地起草', '润色当前正文，保持原意', '检查语气、事实和遗漏'].map((x) => (
                  <button key={x} disabled={active || sent} onClick={() => setInstruction(x)}>
                    {x}
                  </button>
                ))}
              </div>
              <textarea
                ref={agentInput}
                aria-label="给邮件助手的要求"
                rows={3}
                placeholder="例如：回复已收到，周五前提供资料，语气自然简洁。"
                maxLength={1800}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={sent}
              />
              <div className="action-row">
                {active ? (
                  <button
                    className="secondary"
                    onClick={() =>
                      void api(settings, `/pi/tasks/${task!.id}`, undefined, 'DELETE').catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    <Square size={13} />
                    停止起草
                  </button>
                ) : (
                  <button
                    className="secondary"
                    disabled={!!busy || !instruction.trim() || sent}
                    onClick={() => void assist()}
                  >
                    {busy === 'agent' ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    让 Agent 协助
                  </button>
                )}
              </div>
              {connection !== 'connected' && draft.taskId && (
                <p className="field-help">
                  {failure || '正在重新连接任务状态…'}{' '}
                  <button className="text-link" onClick={reconnect}>
                    重新连接
                  </button>
                </p>
              )}
              {task && (
                <div className="mail-compose-suggestion">
                  <div className="mail-agent-status">
                    {active ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{' '}
                    {taskLabel(task)}
                    {active && task.phase ? ` · ${task.phase}` : ''}
                  </div>
                  {task.output && <PiMarkdown text={task.output} />}
                  {task.error && <p className="error">{task.error}</p>}
                  {task.status === 'done' && !!task.output && (
                    <button
                      className="secondary"
                      disabled={sent}
                      onClick={() => {
                        setPreviousText(draft.text);
                        update('text', task.output);
                        setNotice('已采用助手建议，请检查正文。');
                      }}
                    >
                      采用此正文
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="mail-compose-notice" role="status">
            {notice}
          </p>
        )}
        {previousText !== null && !sent && (
          <div className="mail-compose-undo">
            <span>已替换正文</span>
            <button
              className="text-link"
              onClick={() => {
                update('text', previousText);
                setPreviousText(null);
                setNotice('已恢复替换前的正文。');
              }}
            >
              撤销替换
            </button>
          </div>
        )}
        <footer>
          <span>{reply ? '回复原发件人' : '新邮件'} · 发送需再次确认</span>
          {sent ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <>
              <button className="secondary" disabled={!valid || !!busy} onClick={() => void save()}>
                {busy === 'save' ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}
                保存到邮箱草稿
              </button>
              <button
                className="primary"
                disabled={!valid || !!busy || sendUnknown}
                onClick={() => void prepare()}
              >
                <Send size={14} />
                检查并发送
              </button>
            </>
          )}
        </footer>
        {confirmation && (
          <div
            className="mail-compose-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label="确认发送邮件"
          >
            <div>
              <header>
                <h3>确认发送</h3>
                <button
                  className="icon-btn"
                  aria-label="返回编辑"
                  disabled={busy === 'send'}
                  onClick={() => setConfirmation(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <dl>
                <dt>发件人</dt>
                <dd>{confirmation.from}</dd>
                <dt>收件人</dt>
                <dd>{confirmation.to.join('；')}</dd>
                <dt>主题</dt>
                <dd>{confirmation.subject}</dd>
              </dl>
              <pre>{confirmation.text}</pre>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已检查收件人、主题与正文
              </label>
              <div className="action-row">
                <button
                  className="secondary"
                  disabled={busy === 'send'}
                  onClick={() => setConfirmation(null)}
                >
                  返回编辑
                </button>
                <button
                  className="primary"
                  disabled={
                    !confirmed || !!busy || sendUnknown || confirmation.expiresAt <= Date.now()
                  }
                  onClick={() => void send()}
                >
                  {busy === 'send' && <LoaderCircle size={14} className="spin" />}确认发送
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
