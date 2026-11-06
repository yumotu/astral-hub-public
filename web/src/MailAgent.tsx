import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, LoaderCircle, Send, Square, X } from 'lucide-react';
import { api } from './data';
import { accountScope, loadSession } from './session';
import { usePiTasks, taskPending, taskLabel, type PiTask } from './pi-tasks';
import { PluginRequests } from './PluginRequests';
import { PiMarkdown } from './PiMarkdown';
import { useComposerSize } from './mobile-viewport';
import type { Settings } from './types';

export function MailAgent({
  settings,
  open,
  mailbox,
  uids,
  onClose,
  onSettled,
  filters,
  suggestion = '',
}: {
  settings: Settings;
  open: boolean;
  mailbox: string;
  uids: number[];
  onClose: () => void;
  onSettled: () => void;
  filters?: { q: string; unread: boolean; since?: string; before?: string };
  suggestion?: string;
}) {
  const key = 'astral.mail.agent:' + accountScope(settings, loadSession(settings));
  const [context, setContext] = useState<{ conversationId: string; taskId?: string }>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (saved?.conversationId) return saved;
    } catch {}
    return { conversationId: crypto.randomUUID() };
  });
  const [instruction, setInstruction] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [localTask, setLocalTask] = useState<PiTask | null>(null);
  const panel = useRef<HTMLElement>(null),
    settled = useRef(new Set<string>()),
    callback = useRef(onSettled);
  const input = useRef<HTMLTextAreaElement>(null);
  useComposerSize(input, instruction, { min: 68, enabled: open });
  const attempt = useRef<{ id: string; signature: string } | null>(null);
  callback.current = onSettled;
  const { tasks, connection, failure, reconnect } = usePiTasks(settings, open);
  const task =
    tasks.find((t) => t.id === context.taskId) ||
    (localTask?.id === context.taskId ? localTask : null);
  const active = !!task && taskPending(task);
  useEffect(() => {
    if (open && suggestion && !active) setInstruction(suggestion);
  }, [open, suggestion]);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(context));
    } catch {}
  }, [key, context]);
  useEffect(() => {
    if (task && !taskPending(task) && !settled.current.has(task.id)) {
      settled.current.add(task.id);
      try {
        if (sessionStorage.getItem(key + ':settled') === task.id) return;
        sessionStorage.setItem(key + ':settled', task.id);
      } catch {}
      callback.current();
    }
  }, [task?.id, task?.status]);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
      if (e.key !== 'Tab') return;
      const fields = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),textarea,input,select,[tabindex="0"]',
      );
      if (!fields?.length) {
        e.preventDefault();
        return;
      }
      const first = fields[0],
        last = fields[fields.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || document.activeElement === panel.current)
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, [open, onClose]);
  async function start() {
    if (!instruction.trim() || active || busy) return;
    const signature = JSON.stringify([
      context.conversationId,
      instruction.trim(),
      mailbox,
      uids,
      filters,
    ]);
    if (attempt.current && attempt.current.signature !== signature) {
      setError('上一条提交结果待核对，请保留原内容重试以取回同一个任务。');
      return;
    }
    const id = attempt.current?.id || crypto.randomUUID();
    attempt.current = { id, signature };
    setContext({ ...context, taskId: id });
    setError('');
    setBusy(true);
    try {
      const result = await api<{ task: PiTask }>(settings, '/mail/manage/assist', {
        id,
        conversationId: context.conversationId,
        instruction: instruction.trim(),
        mailbox,
        uids,
        ...filters,
      });
      setContext({ ...context, taskId: result.task.id });
      setLocalTask(result.task);
      setInstruction('');
      attempt.current = null;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ task: PiTask }>(
        settings,
        `/pi/tasks/${task.id}`,
        undefined,
        'DELETE',
      );
      setLocalTask(result.task);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useBackLayer(open, onClose, 100);
  if (!open) return null;
  return createPortal(
    <div className="mail-action-overlay">
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-agent-title"
        className="mail-action-dialog mail-agent-dialog"
      >
        <header>
          <Bot size={20} />
          <h2 id="mail-agent-title">邮件 Agent</h2>
          <button className="icon-btn" aria-label="收起邮件 Agent" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="mail-action-body">
          <p className="inline-hint">
            当前文件夹：{mailbox}
            {uids.length ? ` · 已选 ${uids.length} 封` : ''}
            。支持旧邮件检索、按主题或发件人分类；分组方案确认一次后实际创建文件夹并移动。已读/未读直接执行。收起后任务继续运行。
          </p>
          {connection === 'reconnecting' && <p role="status">正在重新连接…</p>}
          {failure && (
            <p className="error">
              {failure}
              <button className="secondary" onClick={reconnect}>
                重新连接
              </button>
            </p>
          )}
          {task && (
            <section className="mail-agent-result" aria-live="polite">
              <p>
                {active && <LoaderCircle className="spin" size={14} />}{' '}
                {task.phase || taskLabel(task)}
              </p>
              {task.output && <PiMarkdown text={task.output} />}
              {task.error && (
                <p role="alert" className="error">
                  {task.error}
                </p>
              )}
              <PluginRequests settings={settings} task={task} />
            </section>
          )}
          {!active && (
            <div className="mail-agent-examples">
              <button
                className="secondary"
                onClick={() => setInstruction('查看当前文件夹未读邮件，按主题归纳，先不要修改。')}
              >
                归纳未读邮件
              </button>
              <button
                className="secondary"
                onClick={() =>
                  setInstruction(
                    '根据所选邮件或当前筛选，按主题分类，优先使用已有文件夹，必要时新建。先展示分组方案供我一次确认，再执行创建和移动，保留不确定的邮件。',
                  )
                }
              >
                按主题分类
              </button>
              <button
                className="secondary"
                onClick={() =>
                  setInstruction(
                    '根据当前选择和筛选，检索所有历史邮件，按发件人或来源归组，名称相近的来源合并。分页读取而不只处理第一页，先预览分类方案再实际移动。',
                  )
                }
              >
                按来源归组
              </button>
            </div>
          )}
          {active && (
            <p className="inline-hint">
              停止任务会取消尚未确认的申请。已经确认并发送给邮箱的操作需以实际结果为准。
            </p>
          )}
        </div>
        <footer className="mail-agent-compose">
          <label className="field-label" htmlFor="mail-manage-instruction">
            告诉 Agent 你想做什么
          </label>
          <textarea
            ref={input}
            id="mail-manage-instruction"
            rows={3}
            maxLength={1800}
            placeholder="例如：把去年的邮件按工作、学习、账单分类，预览后执行。"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="action-row">
            {active && (
              <button className="secondary" disabled={busy} onClick={() => void stop()}>
                <Square size={14} />
                停止任务
              </button>
            )}
            <button
              className="primary"
              disabled={active || busy || !instruction.trim()}
              onClick={() => void start()}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}开始处理
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
