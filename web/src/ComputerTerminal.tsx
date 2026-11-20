import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, Square, X, RefreshCw } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api } from './data';
import { peekAPI } from './resource-cache';
import { serverIdentity } from './session';
import { useTheme } from './Theme';
import type { ComputerProject } from './computer-api';
import type { Settings } from './types';
type Session = {
  id: string;
  status: string;
  closed: boolean;
  exitCode: number | null;
  error?: string;
  createdAt: string;
};
type Read = Session & {
  chunks: { seq: number; data: string }[];
  cursor: number;
  reset: boolean;
  inputReceipts: { id: string; status: string; error?: string }[];
};
export function ComputerTerminal({
  settings,
  owner,
  deviceId,
  project,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  project: ComputerProject;
}) {
  const base = '/relay/terminals?deviceId=' + deviceId + '&projectId=' + project.id,
    key =
      'astral.computer.terminal:' +
      JSON.stringify([serverIdentity(settings), owner, deviceId, project.id]);
  const [sessions, setSessions] = useState<Session[]>(
      () => peekAPI<{ sessions: Session[] }>(settings, base)?.sessions || [],
    ),
    [id, setId] = useState(() => sessionStorage.getItem(key) || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false),
    [blocked, setBlocked] = useState(() => !!sessionStorage.getItem(key + ':input'));
  const box = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    ready = useRef(false),
    block = useRef(blocked),
    transmit = useRef<(data: string) => void>(() => {}),
    alive = useRef(true);
  const { appearance, palette } = useTheme();
  const updateTheme = () => {
    if (!terminal.current) return;
    const style = getComputedStyle(document.documentElement);
    terminal.current.options.theme = {
      background: style.getPropertyValue('--surface').trim() || '#fff',
      foreground: style.getPropertyValue('--text').trim() || '#222',
      cursor: style.getPropertyValue('--accent').trim() || '#6160ff',
      selectionBackground: appearance === 'dark' ? '#58587f' : '#d9d9ff',
    };
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    block.current = blocked;
  }, [blocked]);
  async function refresh() {
    const r = await api<{ sessions: Session[] }>(settings, base, undefined, undefined, false, {
      fresh: true,
    });
    if (alive.current) setSessions(r.sessions);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [settings, deviceId, project.id]);
  useEffect(() => {
    if (!id || !box.current) return;
    sessionStorage.setItem(key, id);
    ready.current = false;
    setConnected(false);
    setError('');
    const saved = sessionStorage.getItem(key + ':input:' + id);
    block.current = !!saved;
    setBlocked(!!saved);
    const term = new Terminal({
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 2000,
      cursorBlink: true,
      convertEol: false,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    terminal.current = term;
    updateTheme();
    const controller = new AbortController();
    let live = true,
      cursor = 0,
      buffer = '',
      sending = false,
      resizeTimer: ReturnType<typeof setTimeout>,
      flushTimer: ReturnType<typeof setTimeout>;
    const pending = new Set<string>();
    function failure(message: string, requestId?: string) {
      if (!live) return;
      block.current = true;
      setBlocked(true);
      setError(message);
      buffer = '';
      if (requestId) sessionStorage.setItem(key + ':input:' + id, requestId);
    }
    async function flush() {
      if (!live || !buffer || sending || block.current || !ready.current) return;
      sending = true;
      const data = buffer;
      buffer = '';
      const requestId = crypto.randomUUID();
      sessionStorage.setItem(key + ':input:' + id, requestId);
      try {
        await api(
          settings,
          '/relay/terminals/' + id + '/input',
          { id: requestId, data },
          undefined,
          false,
          { signal: controller.signal, timeout: 15000 },
        );
        pending.add(requestId);
        if (sessionStorage.getItem(key + ':input:' + id) === requestId)
          sessionStorage.removeItem(key + ':input:' + id);
      } catch (e) {
        failure(
          '输入未确认执行，未自动重发。请核对输出后恢复输入：' + (e as Error).message,
          requestId,
        );
      } finally {
        sending = false;
        if (buffer && !block.current) flushTimer = setTimeout(() => void flush(), 25);
      }
    }
    function input(data: string) {
      if (!live || !ready.current || block.current) {
        if (live) setError('终端尚未连接或有待确认输入，本次按键未发送。');
        return;
      }
      if (buffer.length + data.length > 16384) {
        failure('单次终端输入过长，整段未发送，请核对后分段输入。');
        return;
      }
      buffer += data;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => void flush(), 25);
    }
    transmit.current = input;
    const inputListener = term.onData(input);
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!live) return;
        fit.fit();
        if (ready.current)
          void api(settings, '/relay/terminals/' + id + '/resize', {
            id: crypto.randomUUID(),
            cols: Math.max(20, Math.min(300, term.cols)),
            rows: Math.max(5, Math.min(100, term.rows)),
          }).catch(() => {});
      }, 180);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(box.current);
    resize();
    void (async () => {
      while (live) {
        try {
          const r = await api<Read>(
            settings,
            '/relay/terminals/' + id + '?after=' + cursor,
            undefined,
            undefined,
            false,
            { fresh: true, signal: controller.signal, timeout: 15000 },
          );
          if (!live) break;
          const wasReady = ready.current;
          ready.current = r.status === 'open';
          setConnected(ready.current);
          setSessions((old) =>
            old.some((s) => s.id === id && s.status !== r.status)
              ? old.map((s) => (s.id === id ? { ...s, status: r.status, closed: r.closed } : s))
              : old,
          );
          if (!wasReady && ready.current) resize();
          if (r.reset) term.writeln('\r\n[较早输出已移出缓冲区]\r\n');
          for (const c of r.chunks) term.write(c.data);
          cursor = r.cursor;
          for (const receipt of r.inputReceipts || [])
            if (pending.has(receipt.id)) {
              if (receipt.status === 'done') pending.delete(receipt.id);
              else if (['error', 'cancelled', 'interrupted'].includes(receipt.status)) {
                pending.delete(receipt.id);
                failure(receipt.error || '本机未确认执行此输入，未自动重发。', receipt.id);
              }
            }
          if (r.error) setError(r.error);
          else if (ready.current && !block.current) setError('');
          if (r.closed) {
            term.writeln(`\r\n[终端已结束，退出码 ${r.exitCode ?? '未知'}]\r\n`);
            setSessions((old) => old.map((s) => (s.id === id ? r : s)));
            break;
          }
        } catch (e) {
          if (!live) break;
          ready.current = false;
          setConnected(false);
          setError('终端连接中断，已保留输出，未重发输入：' + (e as Error).message);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, 400);
          function finish() {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', finish);
            resolve();
          }
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      }
    })();
    return () => {
      live = false;
      ready.current = false;
      buffer = '';
      controller.abort();
      clearTimeout(resizeTimer);
      clearTimeout(flushTimer);
      inputListener.dispose();
      observer.disconnect();
      term.dispose();
      terminal.current = null;
      transmit.current = () => {};
    };
  }, [id, settings, deviceId, project.id]);
  useEffect(updateTheme, [appearance, palette, id]);
  async function create() {
    setBusy(true);
    setError('');
    const next = crypto.randomUUID();
    const pendingKey = key + ':open';
    try {
      const previous = sessionStorage.getItem(pendingKey);
      if (previous) {
        const r = await api<Read>(
          settings,
          '/relay/terminals/' + previous,
          undefined,
          undefined,
          false,
          { fresh: true },
        );
        setId(r.id);
        sessionStorage.removeItem(pendingKey);
        await refresh();
        return;
      }
      sessionStorage.setItem(pendingKey, next);
      const r = await api<{ session: Session }>(settings, '/relay/terminals', {
        id: next,
        deviceId,
        projectId: project.id,
        cols: 100,
        rows: 20,
      });
      setSessions((old) => [r.session, ...old]);
      setId(r.session.id);
      sessionStorage.removeItem(pendingKey);
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408)
        sessionStorage.removeItem(pendingKey);
      setError('终端启动未确认，不会自动重开：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    const requestId = sessionStorage.getItem(key + ':input:' + id);
    try {
      if (requestId) {
        try {
          const r = await api<{ operation: { status: string } }>(
            settings,
            '/relay/operations/' + requestId,
            undefined,
            undefined,
            false,
            { fresh: true },
          );
          if (['queued', 'running'].includes(r.operation.status))
            throw Error('上次输入仍在确认，请先等待结果。');
        } catch (e) {
          if ((e as Error & { status?: number }).status !== 404) throw e;
        }
      }
      sessionStorage.removeItem(key + ':input:' + id);
      block.current = false;
      setBlocked(false);
      setError('');
      terminal.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function close() {
    if (!id) return;
    try {
      await api(settings, '/relay/terminals/' + id + '/close', { id: crypto.randomUUID() });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="computer-terminal" aria-label="电脑终端" data-no-panel-swipe>
      <div className="computer-toolbar">
        <select
          className="standard-input"
          aria-label="电脑终端会话"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          <option value="">选择会话</option>
          {sessions.map((s, i) => (
            <option key={s.id} value={s.id}>
              终端 {sessions.length - i} ·{' '}
              {s.closed
                ? '已结束'
                : s.status === 'opening'
                  ? '启动中'
                  : s.status === 'open'
                    ? '已连接'
                    : '连接中'}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          aria-label="新建电脑终端"
          disabled={busy || !project.allowExecute}
          onClick={() => void create()}
        >
          <Plus size={17} />
        </button>
        <button
          className="icon-btn"
          aria-label="刷新电脑终端会话"
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {!project.allowExecute && (
        <p className="field-help">
          目标电脑尚未授权执行。请在本机对该项目使用 --allow-execute；文件权限不会自动授予终端权限。
        </p>
      )}
      <p className="field-help">
        终端使用目标电脑当前用户的系统权限，项目目录不是Shell沙箱。切换页面保留会话，断线只补输出，不重发按键。
      </p>
      {id && (
        <>
          <div className="computer-terminal-actions">
            <span>{connected ? '已连接' : '等待电脑或读取保留输出'}</span>
            <button
              className="text-link"
              disabled={!connected || blocked}
              onClick={() => transmit.current('\u0003')}
            >
              <Square size={14} />
              中断命令
            </button>
            <button className="text-link danger" onClick={() => void close()}>
              <X size={15} />
              关闭终端
            </button>
          </div>
          <div ref={box} className="computer-terminal-screen" />
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {blocked && (
        <button className="secondary" disabled={!connected} onClick={() => void resume()}>
          已核对终端，继续输入
        </button>
      )}
    </section>
  );
}
