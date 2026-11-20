import { useEffect, useState } from 'react';
import { X, Minus, Minimize2 } from 'lucide-react';
import type { DesktopWindowState } from './desktop-bridge';
import './desktop-window.css';

export function DesktopWindowBar() {
  const [state, setState] = useState<DesktopWindowState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const bridge = window.astralDesktop?.windowControls;
    if (!bridge) return;
    let live = true,
      changes = 0;
    const receive = (value: DesktopWindowState | null) => {
      if (live) setState((old) => (!old || !value || value.revision >= old.revision ? value : old));
    };
    const remove = bridge.onChange((value) => {
      changes++;
      receive(value);
    });
    void bridge
      .status()
      .then((value) => {
        if (!changes) receive(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      remove();
    };
  }, []);
  const shown = state?.platform === 'darwin' && state.fullScreen;
  useEffect(() => {
    if (shown) document.documentElement.dataset.desktopFullscreen = '';
    else delete document.documentElement.dataset.desktopFullscreen;
    return () => {
      delete document.documentElement.dataset.desktopFullscreen;
    };
  }, [shown]);
  if (!shown) return null;
  async function action(value: 'exit-fullscreen' | 'minimize' | 'close') {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await window.astralDesktop!.windowControls!.action(value);
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="desktop-window-bar" aria-label="全屏窗口控制">
      <div role="group" aria-label="窗口操作">
        <button
          className="window-close"
          aria-label="关闭窗口"
          title="关闭窗口"
          disabled={busy}
          onClick={() => void action('close')}
        >
          <X size={9} />
        </button>
        <button
          className="window-minimize"
          aria-label="最小化窗口"
          title="最小化窗口"
          disabled={busy}
          onClick={() => void action('minimize')}
        >
          <Minus size={9} />
        </button>
        <button
          className="window-restore"
          aria-label="退出全屏"
          title="退出全屏（Control ⌘ F）"
          disabled={busy}
          onClick={() => void action('exit-fullscreen')}
        >
          <Minimize2 size={9} />
        </button>
      </div>
      <span>{error || '星屿'}</span>
      {error && (
        <span className="sr-only" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
