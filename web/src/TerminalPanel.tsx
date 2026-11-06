import { useBackLayer } from './back-navigation';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronDown, Plus, Square, TerminalSquare, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { api } from './data';
import type { Settings } from './types';
import { useTheme } from './Theme';
type Target = 'pi' | 'server';
type Session = {
  id: string;
  target: Target;
  cwd: string;
  closed: boolean;
  exitCode: number | null;
  createdAt: string;
};
type ReadResult = Session & {
  chunks: { seq: number; data: string }[];
  cursor: number;
  reset: boolean;
};
export function TerminalPanel({
  settings,
  owner,
  onClose,
}: {
  settings: Settings;
  owner: string;
  onClose: () => void;
}) {
  const key = `astral.terminal:${settings.url}:${owner}`;
  const [target, setTarget] = useState<Target>(() =>
    localStorage.getItem(key + ':target') === 'server' ? 'server' : 'pi',
  );
  const [sessions, setSessions] = useState<Session[]>([]),
    [id, setId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<{ pi: boolean; server: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  const { appearance } = useTheme();
  const selected = sessions.find((s) => s.id === id);
  useBackLayer(true, onClose, 60);
  useEffect(() => {
    let live = true;
    setId('');
    setSessions([]);
    setError('');
    setConnected(false);
    localStorage.setItem(key + ':target', target);
    void api<{ pi: boolean; server: boolean }>(settings, '/terminals/status')
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    void api<{ sessions: Session[] }>(settings, `/terminals/${target}`)
      .then((value) => {
        if (!live) return;
        setSessions(value.sessions);
        const saved = localStorage.getItem(key + ':' + target);
        setId(
          value.sessions.find((s) => s.id === saved && !s.closed)?.id ||
            value.sessions.find((s) => !s.closed)?.id ||
            '',
        );
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [target, settings.url, settings.sessionToken]);
  useEffect(() => {
    if (!id || !box.current) return;
    localStorage.setItem(key + ':' + target, id);
    const term = new Terminal({
      fontSize: 12,
      lineHeight: 1.3,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    terminal.current = term;
    const controller = new AbortController();
    let live = true,
      cursor = 0,
      inputChain = Promise.resolve(),
      resizeTimer: ReturnType<typeof setTimeout>;
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!live) return;
        fit.fit();
        void api(settings, `/terminals/${target}/${id}/resize`, {
          cols: Math.max(20, Math.min(300, term.cols)),
          rows: Math.max(5, Math.min(100, term.rows)),
        }).catch(() => {});
      }, 100);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(box.current);
    resize();
    const input = term.onData((data) => {
      inputChain = inputChain
        .then(async () => {
          if (!live) return;
          await api(settings, `/terminals/${target}/${id}/input`, { data });
        })
        .catch((e) => {
          if (live) setError('输入未确认送达，请检查当前命令后继续：' + e.message);
        });
    });
    void (async () => {
      while (live) {
        try {
          const r = await fetch(
            `${settings.url.replace(/\/$/, '')}/api/terminals/${target}/${id}?after=${cursor}`,
            {
              headers: { Authorization: 'Bearer ' + settings.sessionToken },
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
              redirect: 'error',
            },
          );
          const value = (await r.json()) as ReadResult & { error?: string };
          if ([401, 403, 404, 409].includes(r.status)) {
            if (live) {
              setConnected(false);
              setError(value.error || '终端会话已失效，请重新登录或新建会话。');
            }
            break;
          }
          if (!r.ok) throw new Error(value.error || '终端连接失败。');
          if (!live) break;
          setError('');
          setConnected(!value.closed);
          if (value.reset) term.writeln('\r\n[较早输出已移出缓冲区]\r\n');
          for (const chunk of value.chunks) term.write(chunk.data);
          cursor = value.cursor;
          if (value.closed) {
            term.writeln(`\r\n[会话结束，退出码 ${value.exitCode ?? '未知'}]`);
            setSessions((old) =>
              old.map((s) => (s.id === id ? { ...s, closed: true, exitCode: value.exitCode } : s)),
            );
            break;
          }
        } catch (e) {
          if (!live) break;
          setConnected(false);
          setError((e as Error).message);
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(wait);
              controller.signal.removeEventListener('abort', done);
              resolve(null);
            };
            const wait = setTimeout(done, 1500);
            controller.signal.addEventListener('abort', done, { once: true });
          });
        }
      }
    })();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id, target, settings.url, settings.sessionToken]);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    if (terminal.current)
      terminal.current.options.theme = {
        background: style.getPropertyValue('--surface').trim() || '#fff',
        foreground: style.getPropertyValue('--text').trim() || '#222',
        cursor: style.getPropertyValue('--accent').trim() || '#6160ff',
        selectionBackground: appearance === 'dark' ? '#58587f' : '#d9d9ff',
      };
  }, [appearance, id]);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const session = await api<Session>(settings, `/terminals/${target}`, { cols: 100, rows: 20 });
      setSessions((old) => [...old, session]);
      setId(session.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    if (!id) return;
    try {
      await api(settings, `/terminals/${target}/${id}/input`, { data: '\u0003' });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function end() {
    if (!id) return;
    try {
      await api(settings, `/terminals/${target}/${id}/close`, {});
      setSessions((old) => old.map((s) => (s.id === id ? { ...s, closed: true } : s)));
      setId('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="chat-terminal" aria-label="服务器终端">
      <div className="terminal-heading">
        <div className="terminal-targets" role="tablist" aria-label="终端环境">
          <button
            type="button"
            role="tab"
            aria-selected={target === 'pi'}
            onClick={() => setTarget('pi')}
          >
            Pi 宿主
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={target === 'server'}
            onClick={() => setTarget('server')}
          >
            服务器主机 <span>root</span>
          </button>
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            aria-label="新建终端会话"
            title="新建会话"
            disabled={busy || !status?.[target]}
            onClick={() => void create()}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            aria-label="中断终端命令"
            title="Ctrl+C"
            disabled={!id || selected?.closed}
            onClick={() => void stop()}
          >
            <Square size={13} />
          </button>
          <button
            type="button"
            aria-label="结束终端会话"
            title="结束当前会话"
            disabled={!id}
            onClick={() => void end()}
          >
            <X size={15} />
          </button>
          <button type="button" aria-label="收起终端" title="收起，保留会话" onClick={onClose}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="terminal-session-bar">
        <TerminalSquare size={12} />
        <span>
          {target === 'server'
            ? '服务器主机 · root · 命令可影响整台服务器'
            : 'Pi 宿主容器 · node · 可联网管理插件'}
        </span>
        {sessions.length > 0 && (
          <select aria-label="终端会话" value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">选择会话</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.slice(0, 8)}
                {s.closed ? ' · 已结束' : ''}
              </option>
            ))}
          </select>
        )}
        {id && <i className={connected ? 'connected' : ''}>{connected ? '已连接' : '重连中'}</i>}
      </div>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      {id ? (
        <div
          className="terminal-viewport"
          ref={box}
          aria-label={`${target === 'server' ? '服务器主机' : 'Pi 宿主'}交互终端`}
        />
      ) : (
        <div className="terminal-empty">
          <p>
            {status?.[target]
              ? '切换对话或收起面板会保留会话；空闲 15 分钟后自动关闭。'
              : '此终端服务尚未连接。'}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || !status?.[target]}
            onClick={() => void create()}
          >
            {target === 'server' ? '启动 root 终端' : '启动 Pi 终端'}
          </button>
        </div>
      )}
    </section>
  );
}
