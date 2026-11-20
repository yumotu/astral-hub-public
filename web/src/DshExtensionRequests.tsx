import { useEffect, useState } from 'react';
import { Puzzle } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { Preview, DshExtensionTab } from './DshExtensions';
import './dsh-extension-requests.css';

type Operation = { id: string; state: string; createdAt?: string };
type Requests = { pending: Preview[]; operations: Operation[] };
const labels: Record<string, string> = {
  sending: '正在应用',
  running: '正在应用',
  applied: '已应用',
  'restart-required': '已保存，等待主机重启',
  failed: '应用失败',
  cancelled: '已取消',
  rejected: '未应用',
  unknown: '结果待核对',
  accepted: '已接受，结果待核对',
  observed: '结果待核对',
  'not-found': '主机未找到原操作',
};

export function DshExtensionRequests({
  settings,
  id,
  connected,
  idle,
  open,
}: {
  settings: Settings;
  id: string;
  connected: boolean;
  idle: boolean;
  open: (plan?: string, tab?: DshExtensionTab) => void;
}) {
  const [data, setData] = useState<Requests>({ pending: [], operations: [] });
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<Operation | null>(null);
  const base = '/agent/remote/conversations/' + id + '/extensions';
  useEffect(() => {
    setData({ pending: [], operations: [] });
    setChecked(null);
    setError('');
    if (!connected) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined,
      inFlight = false,
      denied = false;
    const refresh = async () => {
      if (abort.signal.aborted || inFlight || denied) return;
      if (timer) clearTimeout(timer);
      inFlight = true;
      try {
        const value = await api<Requests>(
          settings,
          base + '/requests',
          undefined,
          undefined,
          false,
          { fresh: true, signal: abort.signal },
        );
        if (!abort.signal.aborted) {
          setData(value);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          denied = (e as Error & { status?: number }).status === 403;
          if (denied) setData({ pending: [], operations: [] });
          else setError('扩展状态暂未更新，可稍后核对。');
        }
      } finally {
        inFlight = false;
        if (!abort.signal.aborted && !denied)
          timer = setTimeout(refresh, document.hidden ? 15000 : 3500);
      }
    };
    const changed = () => void refresh();
    window.addEventListener('astral:dsh-extensions', changed);
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
      window.removeEventListener('astral:dsh-extensions', changed);
    };
  }, [settings.url, settings.token, settings.sessionToken, id, connected]);
  const recent = data.operations[0];
  const settled =
    recent &&
    ['applied', 'restart-required', 'failed', 'cancelled', 'rejected'].includes(recent.state);
  const operation = !settled && checked?.id === recent?.id ? checked : recent;
  if (!data.pending.length && !operation) return null;
  async function check() {
    if (!operation || checking) return;
    setChecking(true);
    setError('');
    try {
      const r = await api<{ result: { state: string } }>(
        settings,
        base + '/operations/' + operation.id,
        undefined,
        undefined,
        false,
        { fresh: true },
      );
      setChecked({ ...operation, state: r.result.state });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  return (
    <section className="dsh-extension-requests" aria-label="聊天扩展方案">
      {data.pending.map((p) => (
        <article key={p.plan}>
          <header>
            <Puzzle size={16} />
            <strong>
              {p.title} · {p.target}
            </strong>
            <span>待你确认</span>
          </header>
          <p>作用范围：{p.scope}</p>
          {p.detail?.version && <p>固定版本：{p.detail.version}</p>}
          <p className="field-help">
            {p.needsConfiguration ? '需要你填写连接凭据。' : '尚未应用。'}
            {!idle ? ' 本轮结束后可确认，当前任务继续。' : ' 查看方案后再决定是否应用。'}
          </p>
          <div className="dsh-extension-buttons">
            <button type="button" onClick={() => open(p.plan)}>
              查看和确认
            </button>
            {p.kind === 'mcp-save' && (
              <button type="button" onClick={() => open(p.plan, 'mcps')}>
                编辑 MCP 配置
              </button>
            )}
          </div>
        </article>
      ))}
      {operation && (
        <div className="dsh-extension-result" role="status">
          <span>扩展更改 · {labels[operation.state] || '结果待核对'}</span>
          <button
            type="button"
            className="secondary"
            disabled={checking || !connected}
            onClick={() => void check()}
          >
            {checking ? '正在核对…' : '核对原操作'}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
