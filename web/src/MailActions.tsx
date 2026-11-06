import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { z } from 'zod';
import { mailOperationSchema } from '../../shared/mail-actions.mjs';
import { api } from './data';
import type { Settings } from './types';

export type MailOperation = z.infer<typeof mailOperationSchema>;
export type MailActionPreview = {
  id: string;
  action: MailOperation['action'];
  title: string;
  mailbox: string | null;
  destination: string | null;
  messages: { uid: number; subject: string; from: string }[];
  groups?: { destination: string; create: boolean; uids: number[] }[];
  result?: {
    count: number;
    groups?: { destination: string; count: number; state: string; folderCreated: boolean }[];
  };
  expiresAt: string;
  state: 'prepared' | 'running' | 'done' | 'unknown' | 'denied' | 'error';
  error?: string;
};

export function MailActionDialog({
  settings,
  preview,
  onClose,
  onDone,
}: {
  settings: Settings;
  preview: MailActionPreview;
  onClose: () => void;
  onDone: (result: MailActionPreview) => void;
}) {
  const [state, setState] = useState(preview),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null),
    submitted = useRef(false);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        if (!submitted.current) onClose();
      }
      if (e.key !== 'Tab') return;
      const controls = panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),input,select,textarea,[tabindex="0"]',
      );
      if (!controls?.length) {
        e.preventDefault();
        return;
      }
      const first = controls[0],
        last = controls[controls.length - 1];
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
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
      old?.focus();
    };
  }, [onClose]);
  async function confirm() {
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<MailActionPreview>(settings, `/mail/actions/${preview.id}/confirm`, {
        confirm: true,
      });
      setState(result);
      if (result.state === 'done') onDone(result);
    } catch (e) {
      setError((e as Error).message);
      // A lost response is queried, never resubmitted: the remote mutation may have happened.
      try {
        const result = await api<MailActionPreview>(settings, `/mail/actions/${preview.id}`);
        setState(result);
        if (result.state === 'done') {
          setError('');
          onDone(result);
        }
      } catch {
        setState({ ...state, state: 'unknown' });
      }
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    if (busy) return;
    if (!submitted.current && state.state === 'prepared') {
      try {
        await api(settings, `/mail/actions/${preview.id}/deny`, {});
      } catch {}
    }
    onClose();
  }
  useBackLayer(true, () => void close(), 110);
  return createPortal(
    <div className="mail-action-overlay">
      <section
        className="mail-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-action-title"
        tabIndex={-1}
        ref={panel}
      >
        <header>
          <ShieldCheck size={20} />
          <h2 id="mail-action-title">确认{preview.title}</h2>
          <button
            className="icon-btn"
            aria-label="关闭邮件操作预览"
            disabled={busy}
            onClick={() => void close()}
          >
            <X size={18} />
          </button>
        </header>
        <div className="mail-action-body">
          <p>
            {preview.mailbox ? (
              <>
                来源：<b>{preview.mailbox}</b>
              </>
            ) : (
              '仅创建文件夹'
            )}
            {preview.destination && (
              <>
                {' '}
                → <b>{preview.destination}</b>
              </>
            )}
          </p>
          {preview.groups?.map((group) => (
            <details key={group.destination} open>
              <summary>
                <b>{group.destination}</b> · {group.uids.length} 封
                {group.create ? ' · 新建文件夹' : ''}
              </summary>
              <ul>
                {preview.messages
                  .filter((m) => group.uids.includes(m.uid))
                  .map((m) => (
                    <li key={m.uid}>
                      <strong>{m.subject}</strong>
                      <small>
                        {m.from} · UID {m.uid}
                      </small>
                    </li>
                  ))}
              </ul>
            </details>
          ))}
          {!!preview.messages.length && !preview.groups && (
            <>
              <p>仅操作以下 {preview.messages.length} 封邮件：</p>
              <ul>
                {preview.messages.map((m) => (
                  <li key={m.uid}>
                    <strong>{m.subject}</strong>
                    <small>
                      {m.from} · UID {m.uid}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
          {preview.action === 'trash' && (
            <p className="inline-hint">邮件移至邮箱回收站，可从回收站恢复。</p>
          )}
          <p className="inline-hint">
            预览有效至 {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}
            。其他设备已移动的邮件不会被替换操作。
          </p>
          {state.state === 'unknown' && (
            <p role="alert" className="error">
              操作结果待核对，请先刷新邮箱；此操作不会重复提交。
            </p>
          )}
          {state.result?.groups && (
            <ul>
              {state.result.groups.map((g) => (
                <li key={g.destination}>
                  <strong>
                    {g.destination} · {g.count} 封
                  </strong>
                  <small>
                    {g.state === 'done'
                      ? '已完成'
                      : g.state === 'pending'
                        ? '未执行'
                        : '结果待核对'}
                    {g.folderCreated ? ' · 文件夹已创建' : ''}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button className="secondary" disabled={busy} onClick={() => void close()}>
            {submitted.current ? '关闭并核对邮箱' : '取消'}
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              submitted.current ||
              state.state !== 'prepared' ||
              Date.parse(state.expiresAt) <= Date.now()
            }
            onClick={() => void confirm()}
          >
            {busy && <LoaderCircle size={15} className="spin" />}
            {busy ? '正在执行…' : '确认执行'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
