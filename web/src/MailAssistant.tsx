import { useBackLayer } from './back-navigation';
import { useEffect, useState } from 'react';
import { CalendarClock, LoaderCircle, Mail, RefreshCw, Sparkles, X } from 'lucide-react';
import { api, dateLabel } from './data';
import { mailAssistantDefaults, mailAssistantInput } from '../../shared/mail-assistant.mjs';
import type { AuthSession, Settings } from './types';

type Mailbox = { path: string; name: string };
type AssistantSettings = {
  enabled: boolean;
  dailyEnabled: boolean;
  dailyTime: string;
  timezone: string;
  mailbox: string;
  limit: number;
  newMailEnabled: boolean;
  pollMinutes: number;
};
type AssistantRun = {
  id: number;
  kind: 'daily' | 'new' | 'manual';
  mailbox: string;
  digest: string;
  messages: { uid: number; subject: string; from: string; date: string | null }[];
  createdAt: string;
  read: boolean;
};

const defaults: AssistantSettings = mailAssistantDefaults;

const kindLabel = {
  daily: '每日任务',
  new: '新邮件',
  manual: '手动整理',
};

export function MailAssistant({
  settings,
  session,
  onClose,
}: {
  settings: Settings;
  session: AuthSession | null;
  onClose: () => void;
}) {
  const [form, setForm] = useState<AssistantSettings>(defaults);
  const [runs, setRuns] = useState<AssistantRun[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  useBackLayer(true, onClose, 100);

  async function load() {
    if (!session) return;
    setError('');
    setBusy('load');
    try {
      const [assistant, accountResult] = await Promise.all([
        api<{ settings: AssistantSettings; runs: AssistantRun[] }>(settings, '/mail/assistant'),
        api<{ account: { address: string } | null }>(settings, '/mail/account'),
      ]);
      setForm(mailAssistantInput(assistant.settings));
      setRuns(assistant.runs);
      setAccount(accountResult.account?.address || null);
      if (accountResult.account) {
        const boxes = await api<{ mailboxes: Mailbox[] }>(settings, '/mail/mailboxes');
        setMailboxes(boxes.mailboxes);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    void load();
    // Load once per opened assistant; the server owns the persisted settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, settings.url]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  async function save() {
    setError('');
    setSaved('');
    setBusy('save');
    try {
      const result = await api<{ settings: AssistantSettings }>(
        settings,
        '/mail/assistant',
        mailAssistantInput(form),
      );
      setForm(mailAssistantInput(result.settings));
      setSaved('邮件助手设置已保存。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function runNow() {
    setError('');
    setSaved('');
    setBusy('run');
    try {
      const result = await api<{ run: AssistantRun }>(settings, '/mail/assistant/run', {});
      setRuns((current) => [result.run, ...current].slice(0, 20));
      setSaved('已生成一次整理。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div
      className="mail-assistant-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="智能邮件助手"
    >
      <section className="mail-assistant">
        <header className="mail-assistant-head">
          <div className="mail-assistant-title">
            <span className="assistant-orb">
              <Mail size={20} />
            </span>
            <div>
              <span className="eyebrow">MAIL AGENT</span>
              <h2>智能邮件助手</h2>
              <p>每天整理收件箱，或在新邮件到达时自动生成摘要。</p>
            </div>
          </div>
          <button className="icon-btn" aria-label="关闭邮件助手" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="mail-assistant-body">
          {!account && (
            <div className="info-banner">
              <Mail size={17} />
              <span>
                还没有连接邮箱。请先到「邮件」页连接 QQ 邮箱或 Gmail，再启用每日任务和新邮件整理。
              </span>
            </div>
          )}

          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {saved && <div className="mail-assistant-saved">{saved}</div>}

          <div className="mail-assistant-grid">
            <section className="mail-assistant-card">
              <div className="mail-assistant-card-head">
                <div>
                  <h3>每日任务</h3>
                  <p>在指定时间整理最近邮件，结果保存在下方记录里。</p>
                </div>
                <label className="mail-switch">
                  <input
                    type="checkbox"
                    checked={form.dailyEnabled}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        dailyEnabled: event.target.checked,
                        enabled: event.target.checked ? true : current.enabled,
                      }))
                    }
                  />
                  <span />
                </label>
              </div>
              <div className="mail-assistant-fields">
                <label>
                  时间
                  <input
                    type="time"
                    value={form.dailyTime}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, dailyTime: event.target.value }))
                    }
                  />
                </label>
                <label>
                  文件夹
                  <select
                    value={form.mailbox}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, mailbox: event.target.value }))
                    }
                  >
                    {(mailboxes.length ? mailboxes : [{ path: 'INBOX', name: 'INBOX' }]).map(
                      (item) => (
                        <option key={item.path} value={item.path}>
                          {item.path === 'INBOX' ? '收件箱' : item.name}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  整理封数
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form.limit}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, limit: Number(event.target.value) }))
                    }
                  />
                </label>
                <label>
                  时区
                  <input
                    value={form.timezone}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, timezone: event.target.value }))
                    }
                    placeholder="Asia/Shanghai"
                  />
                </label>
              </div>
            </section>

            <section className="mail-assistant-card">
              <div className="mail-assistant-card-head">
                <div>
                  <h3>新邮件到达</h3>
                  <p>按间隔检查新邮件，有更新时自动整理并留下记录。</p>
                </div>
                <label className="mail-switch">
                  <input
                    type="checkbox"
                    checked={form.newMailEnabled}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        newMailEnabled: event.target.checked,
                        enabled: event.target.checked ? true : current.enabled,
                      }))
                    }
                  />
                  <span />
                </label>
              </div>
              <div className="mail-assistant-fields">
                <label>
                  检查间隔（分钟）
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    value={form.pollMinutes}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        pollMinutes: Number(event.target.value),
                      }))
                    }
                  />
                </label>
                <label className="mail-assistant-toggle">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  启用邮件助手调度
                </label>
              </div>
              <p className="inline-hint">
                新邮件整理只读取邮件，不会标记已读、回复或发送。首次启用时会先记录当前最新
                UID，之后只整理新到邮件。
              </p>
            </section>
          </div>

          <div className="mail-assistant-actions">
            <button className="primary" disabled={!!busy || !account} onClick={() => void save()}>
              {busy === 'save' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <CalendarClock size={15} />
              )}
              保存设置
            </button>
            <button
              className="secondary"
              disabled={!!busy || !account}
              onClick={() => void runNow()}
            >
              {busy === 'run' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              立即整理一次
            </button>
            <button className="secondary" disabled={!!busy} onClick={() => void load()}>
              <RefreshCw size={14} />
              刷新记录
            </button>
          </div>

          <section className="mail-assistant-runs">
            <h3>最近整理</h3>
            {!runs.length && <p className="mail-assistant-empty">还没有整理记录。</p>}
            {runs.map((run) => (
              <details className="mail-assistant-run" key={run.id}>
                <summary>
                  <span className={`tag ${run.kind}`}>{kindLabel[run.kind]}</span>
                  <b>{run.messages.length} 封</b>
                  <small>{dateLabel(run.createdAt)}</small>
                </summary>
                <pre>{run.digest}</pre>
              </details>
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}
