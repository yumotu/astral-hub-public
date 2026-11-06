import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, X, LoaderCircle, ChevronDown } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import './approval-control.css';
type Mode = 'manual' | 'rules' | 'assist' | 'full';
type Policy = {
  mode: Mode;
  targets: ('pi' | 'server')[];
  expiresAt: number | null;
  expired: boolean;
  rules: { id: string; target: string; kind: string }[];
};
const labels = { manual: '逐次审核', rules: '按规则授权', assist: '协助审核', full: '完全权限' };
export function ApprovalControl({
  settings,
  conversation,
}: {
  settings: Settings;
  conversation: string;
}) {
  const [policy, setPolicy] = useState<Policy | null>(null),
    [open, setOpen] = useState(false),
    [mode, setMode] = useState<Mode>('manual'),
    [targets, setTargets] = useState<('pi' | 'server')[]>(['pi']),
    [minutes, setMinutes] = useState('15'),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    let alive = true;
    void api<Policy>(settings, `/pi/approval-policies/${conversation}`)
      .then((p) => {
        if (alive) {
          setPolicy(p);
          setMode(p.mode);
          setTargets(p.targets);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [conversation, settings.url, settings.sessionToken, settings.token, open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open]);
  const expired = !!policy?.expiresAt && policy.expiresAt <= Date.now();
  const label = expired ? '逐次审核' : labels[policy?.mode || 'manual'];
  async function save(revoke = false) {
    setBusy(true);
    setError('');
    try {
      const p = await api<Policy>(
        settings,
        `/pi/approval-policies/${conversation}`,
        {
          mode: revoke ? 'manual' : mode,
          targets: revoke ? ['pi'] : targets,
          minutes: revoke || minutes === 'always' ? null : Number(minutes),
          acknowledged: ack,
        },
        'PATCH',
      );
      setPolicy(p);
      setMode(p.mode);
      setOpen(false);
      setAck(false);
      trigger.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="approval-control">
      <button
        ref={trigger}
        className={`approval-trigger ${policy?.mode === 'full' && !expired ? 'full' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setAck(false);
          setOpen(!open);
        }}
      >
        <ShieldCheck size={13} />
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="approval-backdrop" onClick={() => setOpen(false)}>
          <section
            className="approval-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="执行授权设置"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h3>执行授权</h3>
              <button className="icon-btn" aria-label="关闭授权设置" onClick={() => setOpen(false)}>
                <X size={17} />
              </button>
            </header>
            <p className="field-help">
              仅应用于此对话申请的宿主命令。Bash 沙箱的联网在「Bash
              联网」中单独授权；已加载原生插件的进程权限保持原有行为。
            </p>
            <label>
              审核方式
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value as Mode);
                  setAck(false);
                }}
              >
                {Object.entries(labels).map(([v, l]) => (
                  <option value={v} key={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-help">
              {mode === 'manual'
                ? '每次宿主命令都由你确认；保存将撤销已记住的规则。'
                : mode === 'rules'
                  ? '仅你明确记住的原样命令或只读同类命令自动通过，其余仍需确认。'
                  : mode === 'assist'
                    ? '自动通过受限语法中的只读检查。脚本、写入与复合命令仍需你审核，记录中保留判断依据。'
                    : '所选环境内的宿主命令无需逐条审核，继承该环境账户的文件与网络权限。'}
            </p>
            <fieldset>
              <legend>执行环境</legend>
              {(['pi', 'server'] as const).map((t) => (
                <label key={t}>
                  <input
                    type="checkbox"
                    checked={targets.includes(t)}
                    onChange={(e) =>
                      setTargets(
                        e.target.checked ? [...targets, t] : targets.filter((x) => x !== t),
                      )
                    }
                  />
                  {t === 'pi' ? 'Pi 宿主' : '服务器主机'}
                </label>
              ))}
            </fieldset>
            <label>
              有效期
              <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
                <option value="15">15 分钟</option>
                <option value="60">1 小时</option>
                <option value="120">2 小时</option>
                <option value="always">直到手动撤销</option>
              </select>
            </label>
            {!!policy?.rules.length && (
              <p className="field-help">
                已记住 {policy.rules.length} 条命令规则；可随时撤销全部授权。
              </p>
            )}
            {policy?.expiresAt && !expired && (
              <p className="field-help">
                当前授权有效至 {new Date(policy.expiresAt).toLocaleTimeString()}
              </p>
            )}
            {mode === 'full' && (
              <label className="approval-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                我确认允许此对话在所选环境中执行命令
              </label>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button className="secondary" disabled={busy} onClick={() => void save(true)}>
                撤销授权
              </button>
              <button
                className="primary"
                disabled={busy || !targets.length || (mode === 'full' && !ack)}
                onClick={() => void save()}
              >
                {busy && <LoaderCircle size={14} className="spin" />}应用设置
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
