import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, Square, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { api } from './data';
import type { Settings } from './types';
import { useTheme } from './Theme';
import { useBackLayer } from './back-navigation';

type Session = {
  id: string;
  title: string;
  state: string;
  exitCode: number | null;
  writable: boolean;
  error?: string;
};
type Screen = Session & { chunks: { seq: number; data: string }[]; cursor: number; reset: boolean };
export function DshTerminal({
  settings,
  conversation,
  close,
}: {
  settings: Settings;
  conversation: string;
  close: () => void;
}) {
  const base = '/agent/remote/conversations/' + conversation + '/terminals';
  const [sessions, setSessions] = useState<Session[]>([]),
    [id, setId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [connected, setConnected] = useState(false);
  const box = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    write = useRef<(value: string) => void>(() => {}),
    mounted = useRef(true);
  const { appearance } = useTheme();
  useBackLayer(true, close, 60);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<{ terminals: Session[] }>(settings, base, undefined, undefined, false, {
      fresh: true,
      signal: controller.signal,
    })
      .then((r) => {
        if (mounted.current) {
          setSessions(r.terminals);
          setId(r.terminals.find((s) => s.state === 'running')?.id || '');
        }
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [settings, base]);
  useEffect(() => {
    if (!id || !box.current) return;
    const term = new Terminal({
      fontSize: 12,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    terminal.current = term;
    const controller = new AbortController();
    let live = true,
      writable = false,
      failed = false,
      cursor = 0,
      chain = Promise.resolve(),
      resizeTimer: ReturnType<typeof setTimeout>;
    setConnected(false);
    const input = (data: string) => {
      if (!writable || failed || !live) return;
      chain = chain
        .then(async () => {
          if (!live || failed) return;
          const r = await api<{ operation: { state: string } }>(
            settings,
            base + '/' + id + '/input',
            { id: crypto.randomUUID(), data },
            undefined,
            false,
            { signal: controller.signal },
          );
          if (!['accepted', 'observed'].includes(r.operation.state))
            throw Error('输入结果待核对，不会重发。');
        })
        .catch((e) => {
          failed = true;
          writable = false;
          if (live) {
            setConnected(false);
            setError(e.message);
          }
        });
    };
    write.current = input;
    const data = term.onData(input);
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!live) return;
        fit.fit();
        if (!writable || failed) return;
        void api(
          settings,
          base + '/' + id + '/resize',
          {
            id: crypto.randomUUID(),
            cols: Math.max(20, Math.min(300, term.cols)),
            rows: Math.max(5, Math.min(100, term.rows)),
          },
          undefined,
          false,
          { signal: controller.signal },
        ).catch((e) => {
          if (live) setError(e.message);
        });
      }, 160);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(box.current);
    resize();
    void (async () => {
      try {
        while (live) {
          const { terminal: screen } = await api<{ terminal: Screen }>(
            settings,
            base + '/' + id + '?cursor=' + cursor,
            undefined,
            undefined,
            false,
            { fresh: true, signal: controller.signal },
          );
          if (!live) break;
          if (screen.reset) {
            term.reset();
            term.writeln('[较早输出已移出缓冲区]');
          }
          for (const chunk of screen.chunks) term.write(chunk.data);
          cursor = screen.cursor;
          writable = screen.writable && !failed;
          setConnected(writable);
          setSessions((old) => old.map((s) => (s.id === id ? screen : s)));
          if (screen.error) {
            setError(screen.error);
            failed = true;
            writable = false;
            setConnected(false);
            break;
          }
          if (screen.state !== 'running') {
            term.writeln(`\r\n[终端已结束，退出码 ${screen.exitCode ?? '未知'}]`);
            break;
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 600);
            controller.signal.addEventListener('abort', done, { once: true });
          });
        }
      } catch (e) {
        if (live) {
          failed = true;
          writable = false;
          setConnected(false);
          setError((e as Error).message);
        }
      }
    })();
    return () => {
      live = false;
      writable = false;
      controller.abort();
      clearTimeout(resizeTimer);
      observer.disconnect();
      data.dispose();
      term.dispose();
      terminal.current = null;
      write.current = () => {};
    };
  }, [id, base, settings]);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    if (terminal.current)
      terminal.current.options.theme = {
        background: style.getPropertyValue('--surface').trim() || '#fff',
        foreground: style.getPropertyValue('--text').trim() || '#222',
        cursor: style.getPropertyValue('--accent').trim() || '#6160ff',
      };
  }, [appearance, id]);
  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ terminal: Screen | null; operation: { state: string } }>(
        settings,
        base,
        { id: crypto.randomUUID(), terminalId: crypto.randomUUID(), cols: 80, rows: 15 },
      );
      if (!r.terminal || !['accepted', 'observed'].includes(r.operation.state))
        throw Error('终端创建结果待核对，请刷新列表；不会自动重建。');
      if (mounted.current) {
        setSessions((old) => [...old, r.terminal!]);
        setId(r.terminal.id);
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function end() {
    if (!id || busy) return;
    setBusy(true);
    try {
      const r = await api<{ operation: { state: string } }>(settings, base + '/' + id + '/close', {
        id: crypto.randomUUID(),
      });
      if (!['accepted', 'observed'].includes(r.operation.state))
        throw Error('关闭结果待主机确认。');
      if (mounted.current) {
        setSessions((old) => old.filter((s) => s.id !== id));
        setId('');
        setError('');
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="chat-terminal dsh-terminal" aria-label="DSH终端">
      <header className="terminal-heading">
        <strong>DSH 终端</strong>
        <div className="terminal-actions">
          <button
            type="button"
            aria-label="新建DSH终端"
            disabled={busy}
            onClick={() => void create()}
          >
            <Plus size={15} />
          </button>
          <button
            type="button"
            aria-label="中断DSH终端命令"
            disabled={!connected}
            onClick={() => write.current('\u0003')}
          >
            <Square size={13} />
          </button>
          <button type="button" disabled={!id || busy} onClick={() => void end()}>
            结束
          </button>
          <button type="button" aria-label="收起DSH终端" onClick={close}>
            <X size={16} />
          </button>
        </div>
      </header>
      <div className="terminal-session-bar">
        <span>主机执行账号权限 · 独立于 Agent 审核模式</span>
        {!!sessions.length && (
          <select
            aria-label="DSH终端会话"
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setError('');
            }}
          >
            <option value="">选择终端</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || '终端'}
                {s.state === 'running' ? '' : ' · 已结束'}
              </option>
            ))}
          </select>
        )}
        {id && <i>{connected ? '已连接' : '不可输入'}</i>}
      </div>
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      {id ? (
        <div className="terminal-viewport" ref={box} aria-label="DSH交互终端" />
      ) : (
        <div className="terminal-empty">
          <p>
            在当前 DSH
            工作区启动真实终端。收起保留会话，连续10分钟未使用、退出登录或断开连接后关闭。
          </p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void create()}>
            启动 DSH 终端
          </button>
        </div>
      )}
    </section>
  );
}
