import { useEffect, useState } from 'react';
import { Send, ShieldCheck } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import './app-functions.css';

type Request = {
  id: string;
  name: string;
  state: string;
  expiresAt: number;
  preview: {
    title: string;
    recipient?: { displayName: string; username: string };
    from?: string;
    to?: string[];
    subject?: string;
    text?: string;
    mailbox?: string;
    destination?: string;
    messages?: { uid: number; subject: string; from: string }[];
    groups?: { destination: string; create: boolean; uids: number[] }[];
  };
};
export function AppFunctionRequests({
  settings,
  taskId,
  active,
}: {
  settings: Settings;
  taskId?: string;
  active: boolean;
}) {
  const [requests, setRequests] = useState<Request[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  useEffect(() => {
    setRequests([]);
    setError('');
    if (!active || !taskId) return;
    let stopped = false,
      running = false;
    const controller = new AbortController();
    const poll = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const r = await api<{ requests: Request[] }>(
          settings,
          '/app-functions/requests?taskId=' + taskId,
          undefined,
          undefined,
          false,
          { signal: controller.signal, fresh: true },
        );
        if (!stopped) {
          setRequests(r.requests);
          setError('');
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1200);
    document.addEventListener('visibilitychange', poll);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [taskId, active, settings.sessionToken, settings.url, settings.token]);
  if (!active || !requests.length) return null;
  async function answer(id: string, confirm: boolean) {
    setBusy(id);
    setError('');
    try {
      await api(settings, '/app-functions/requests/' + id + (confirm ? '/confirm' : '/deny'), {});
      setRequests((r) => r.filter((q) => q.id !== id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="app-function-requests">
      {requests.map((r) => {
        const p = r.preview;
        return (
          <section className="app-function-request" key={r.id} aria-label={p.title}>
            <h3>
              <ShieldCheck size={18} />
              {p.title}
            </h3>
            {p.recipient && (
              <p>
                收件人：{p.recipient.displayName}（{p.recipient.username}）
              </p>
            )}
            {p.from && <p>发件人：{p.from}</p>}
            {p.to && <p>收件人：{p.to.join('；')}</p>}
            {p.subject && (
              <p>
                <strong>主题：{p.subject}</strong>
              </p>
            )}
            {p.text && <pre className="app-function-body">{p.text}</pre>}
            {p.mailbox && (
              <p>
                来源：{p.mailbox}
                {p.destination ? ' → ' + p.destination : ''}
              </p>
            )}
            {p.groups?.map((g) => (
              <p key={g.destination}>
                {g.destination} · {g.uids.length}封{g.create ? ' · 新建文件夹' : ''}
                <small>UID：{g.uids.join('、')}</small>
              </p>
            ))}
            {!!p.messages?.length && (
              <details>
                <summary>查看 {p.messages.length} 封邮件的精确范围</summary>
                {p.messages.map((m) => (
                  <p key={m.uid}>
                    UID {m.uid} · {m.subject} · {m.from}
                  </p>
                ))}
              </details>
            )}
            <small>仅执行此预览，有效至 {new Date(r.expiresAt).toLocaleTimeString()}。</small>
            <div className="app-function-actions">
              <button disabled={!!busy} onClick={() => void answer(r.id, false)}>
                取消
              </button>
              <button className="primary" disabled={!!busy} onClick={() => void answer(r.id, true)}>
                <Send size={16} />
                {busy === r.id ? '正在提交…' : r.name.endsWith('.send') ? '确认发送' : '确认执行'}
              </button>
            </div>
          </section>
        );
      })}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
