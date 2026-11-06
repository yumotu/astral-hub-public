import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Globe, X, LoaderCircle } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import './sandbox-network.css';
type Policy = {
  enabled: boolean;
  version: number;
  expiresAt: number | null;
  request?: { id: string; minutes: number; expiresAt: number };
};
type Request = {
  id: string;
  username: string;
  conversationId: string;
  minutes: number;
  createdAt: string;
};
export function SandboxNetworkControl({
  settings,
  conversation,
  admin,
}: {
  settings: Settings;
  conversation: string;
  admin: boolean;
}) {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [open, setOpen] = useState(false),
    [minutes, setMinutes] = useState('15'),
    [ack, setAck] = useState(false),
    [requests, setRequests] = useState<Request[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null),
    alive = useRef(true),
    dialog = useRef<HTMLElement>(null);
  const path = `/pi/conversations/${conversation}/network`;
  useBackLayer(
    open,
    () => {
      if (!busy) {
        setOpen(false);
        trigger.current?.focus();
      }
    },
    100,
  );
  async function refresh() {
    try {
      const value = await api<Policy>(settings, path);
      if (alive.current) setPolicy((old) => (!old || value.version >= old.version ? value : old));
      if (admin && open) {
        const r = await api<{ requests: Request[] }>(settings, '/pi/network-requests');
        if (alive.current) setRequests(r.requests);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [settings.url, settings.sessionToken, settings.token, conversation, admin, open]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
        trigger.current?.focus();
      }
      if (event.key === 'Tab') {
        const controls = [
          ...dialog.current!.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]',
          ),
        ].filter((node) => node.offsetParent !== null);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.body.style.overflow = overflow;
    };
  }, [open]);
  const enabled = !!policy?.enabled && !!policy.expiresAt && policy.expiresAt > Date.now();
  async function apply(enabled: boolean) {
    setBusy(true);
    setError('');
    try {
      const value = await api<Policy>(
        settings,
        path,
        { enabled, minutes: Number(minutes), acknowledged: ack },
        'PATCH',
      );
      if (alive.current) {
        setPolicy(value);
        setAck(false);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function review(request: Request, approved: boolean) {
    setBusy(true);
    setError('');
    try {
      await api(settings, '/pi/network-requests/' + request.id, { approved, acknowledged: ack });
      await refresh();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`sandbox-network-trigger ${enabled ? 'enabled' : ''}`}
        aria-label={`Bash 联网：${enabled ? '已授权' : policy?.request ? '待审核' : '关闭'}`}
        onClick={() => {
          setAck(false);
          setOpen(true);
        }}
      >
        <Globe size={14} />
        <span>{enabled ? '已联网' : policy?.request ? '联网待审核' : 'Bash 联网'}</span>
      </button>
      {open &&
        createPortal(
          <div className="assistant-modal-backdrop">
            <section
              ref={dialog}
              className="surface assistant-modal sandbox-network-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Bash 联网授权"
            >
              <div className="sandbox-network-head">
                <h2>
                  <Globe size={18} />
                  Bash 联网
                </h2>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭联网授权"
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                >
                  <X size={18} />
                </button>
              </div>
              <div className="sandbox-network-body">
                <p>
                  默认关闭，单独授权当前对话。开启后可访问 Pi
                  容器能够连接的外部与内部地址；文件挂载和宿主命令审核继续按各自权限执行。
                </p>
                <p>
                  新启动的 Bash
                  命令才会使用新授权。撤销、到期或无法核验授权时，正在联网的命令会停止，请核对其已发生的修改。
                </p>
                <div className="sandbox-network-status" role="status">
                  {enabled
                    ? `当前对话已获准联网，至 ${new Date(policy!.expiresAt!).toLocaleTimeString()}`
                    : policy?.request
                      ? '此对话的申请等待管理员审核。'
                      : '当前对话未开启 Bash 联网。'}
                </div>
                <label>
                  有效期
                  <select
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                    disabled={busy}
                  >
                    <option value="5">5 分钟</option>
                    <option value="15">15 分钟</option>
                    <option value="60">60 分钟</option>
                  </select>
                </label>
                <label className="network-ack">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(event) => setAck(event.target.checked)}
                    disabled={busy}
                  />
                  <span>我已核对联网范围，包括容器可达的内部地址。</span>
                </label>
                <div className="action-row">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || (!enabled && !policy?.request)}
                    onClick={() => void apply(false)}
                  >
                    撤销／取消申请
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !ack || !!policy?.request}
                    onClick={() => void apply(true)}
                  >
                    {busy && <LoaderCircle size={14} className="spin" />}
                    {admin ? (enabled ? '延长授权' : '授权当前对话') : '向管理员申请'}
                  </button>
                </div>
                {admin && (
                  <section className="network-requests">
                    <h3>待审核的联网申请</h3>
                    {requests.length ? (
                      requests.map((request) => (
                        <article key={request.id}>
                          <b>
                            @{request.username} · {request.minutes} 分钟
                          </b>
                          <small>对话 {request.conversationId}</small>
                          <div className="action-row">
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => void review(request, false)}
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              className="primary"
                              disabled={busy || !ack}
                              onClick={() => void review(request, true)}
                            >
                              允许此申请
                            </button>
                          </div>
                        </article>
                      ))
                    ) : (
                      <p className="field-help">暂无待审核申请。</p>
                    )}
                  </section>
                )}
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
