import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  gestureRange,
  panelDrag,
  swipeStartPanel,
  swipePanel,
} from '../../shared/mobile-navigation.mjs';
import './mobile-navigation.css';
import { backLayers, useBackLayer } from './back-navigation';
import { useMobileViewport } from './mobile-viewport';
type Panel = 'workspace' | 'conversations' | null;
const storageKey = 'astral.mobile.gestureRange';
const Context = createContext<{
  panel: Panel;
  displayPanel: Panel;
  setPanel: (panel: Panel) => void;
  setConversationsAvailable: (available: boolean) => void;
  range: number;
  setRange: (range: number) => void;
} | null>(null);
export function MobilePanelsProvider({ children }: { children: ReactNode }) {
  useMobileViewport();
  const [panel, setPanel] = useState<Panel>(null);
  const [drag, setDrag] = useState<{ panel: Panel; offset: number; progress: number } | null>(null);
  const [available, setAvailable] = useState(false);
  const [range, setRangeState] = useState(() => {
    try {
      return gestureRange(localStorage.getItem(storageKey) ?? 40);
    } catch {
      return 40;
    }
  });
  const setRange = useCallback((value: number) => {
    const next = gestureRange(value);
    setRangeState(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {}
  }, []);
  const current = useRef({ panel, available, range });
  current.current = { panel, available, range };
  useEffect(() => {
    let start: {
      x: number;
      y: number;
      at: number;
      header: boolean;
      conversation: boolean;
      panel: Panel;
      candidate: string;
      locked: Panel;
      size: number;
    } | null = null;
    let suppressClickUntil = 0;
    const selected = () => {
      const selection = window.getSelection();
      return !!selection && !selection.isCollapsed;
    };
    const cancel = () => {
      start = null;
      setDrag(null);
    };
    const touchStart = (event: TouchEvent) => {
      cancel();
      if (
        event.touches.length !== 1 ||
        selected() ||
        document.documentElement.dataset.keyboard === 'open'
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        !target ||
        target.closest(
          'input,textarea,select,[contenteditable="true"],[role="slider"],.cm-editor,pre,table,[role="dialog"],[data-no-panel-swipe]',
        )
      )
        return;
      const { clientX: x, clientY: y } = event.touches[0];
      const state = current.current;
      const header = !!target.closest('.assistant-workspace-heading,.topbar');
      const conversation = !!target.closest('[data-conversation-swipe]');
      if (!state.panel && target.closest('button,a,summary')) return;
      const candidate = swipeStartPanel({
        panel: state.panel,
        width: innerWidth,
        startX: x,
        conversationsAvailable: state.available,
        fromHeader: header,
        fromConversation: conversation,
        range: state.range,
      });
      if (!candidate || y < 16 || y > innerHeight - 24) return;
      start = {
        x,
        y,
        at: Date.now(),
        header,
        conversation,
        panel: state.panel,
        candidate,
        locked: null,
        size: 0,
      };
    };
    const touchMove = (event: TouchEvent) => {
      if (!start) return;
      if (event.touches.length !== 1 || selected() || current.current.panel !== start.panel) {
        cancel();
        return;
      }
      const t = event.touches[0],
        dx = t.clientX - start.x,
        dy = t.clientY - start.y;
      if (!start.locked) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) {
          cancel();
          return;
        }
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        const side = ['header', 'conversation'].includes(start.candidate)
          ? dx > 0
            ? 'workspace'
            : 'conversations'
          : start.candidate;
        if (
          (side === 'workspace' && innerWidth > 700) ||
          (side === 'conversations' && !current.current.available) ||
          (!start.panel &&
            ((side === 'workspace' && dx < 0) || (side === 'conversations' && dx > 0)))
        ) {
          cancel();
          return;
        }
        start.locked = side as Panel;
        const element = document.querySelector(
          side === 'workspace' ? '.sidebar' : '#pi-project-navigation',
        );
        start.size =
          element?.getBoundingClientRect().width ||
          (side === 'workspace' ? 240 : Math.min(310, innerWidth - 36));
      }
      if (event.cancelable) event.preventDefault();
      setDrag({
        panel: start.locked,
        ...panelDrag({ panel: start.locked, open: !!start.panel, dx, size: start.size }),
      });
    };
    const touchEnd = (event: TouchEvent) => {
      const gesture = start;
      cancel();
      if (!gesture || !event.changedTouches.length || current.current.panel !== gesture.panel)
        return;
      const t = event.changedTouches[0];
      const next = swipePanel({
        panel: gesture.panel,
        width: innerWidth,
        startX: gesture.x,
        startY: gesture.y,
        endX: t.clientX,
        endY: t.clientY,
        duration: Date.now() - gesture.at,
        conversationsAvailable: current.current.available,
        fromHeader: gesture.header,
        fromConversation: gesture.conversation,
        range: current.current.range,
        blocked: selected(),
      });
      if (gesture.locked) {
        if (event.cancelable) event.preventDefault();
        suppressClickUntil = Date.now() + 300;
      }
      setPanel(next as Panel);
    };
    const click = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel();
        setPanel(null);
      }
    };
    const resize = () => {
      cancel();
      if ((current.current.panel === 'workspace' && innerWidth > 700) || innerWidth > 1000)
        setPanel(null);
    };
    window.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', touchMove, { capture: true, passive: false });
    window.addEventListener('touchend', touchEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', cancel, true);
    window.addEventListener('click', click, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('touchstart', touchStart, true);
      window.removeEventListener('touchmove', touchMove, true);
      window.removeEventListener('touchend', touchEnd, true);
      window.removeEventListener('touchcancel', cancel, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', resize);
    };
  }, []);
  useEffect(() => {
    if (!available) {
      setDrag(null);
      setPanel((p) => (p === 'conversations' ? null : p));
    }
  }, [available]);
  const displayPanel = drag?.panel || panel;
  useBackLayer(
    !!displayPanel,
    () => {
      setDrag(null);
      setPanel(null);
    },
    80,
  );
  useEffect(() => {
    const menu = backLayers.register(() => {
      const details = [
        ...document.querySelectorAll<HTMLDetailsElement>(
          'details.assistant-options[open],details.notification-center[open],details.thinking-picker[open],details.session-telemetry[open]',
        ),
      ].filter((node) => node.getBoundingClientRect().height > 0);
      const top = details.at(-1);
      if (!top) return false;
      top.open = false;
      top.querySelector<HTMLElement>('summary')?.focus();
    }, 95);
    const back = (event: Event) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        selection.removeAllRanges();
        event.preventDefault();
        return;
      }
      if (backLayers.handle()) event.preventDefault();
    };
    window.addEventListener('astral-native-back', back);
    return () => {
      menu();
      window.removeEventListener('astral-native-back', back);
    };
  }, []);
  useEffect(() => {
    if (!displayPanel) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [displayPanel]);
  const value = useMemo(
    () => ({
      panel,
      displayPanel,
      setPanel,
      setConversationsAvailable: setAvailable,
      range,
      setRange,
    }),
    [panel, displayPanel, range, setRange],
  );
  return (
    <Context.Provider value={value}>
      <div
        className="mobile-panels-root"
        data-panel-dragging={drag ? '' : undefined}
        style={
          {
            '--panel-drag-offset': drag ? `${drag.offset}px` : undefined,
            '--panel-scrim-opacity': drag?.progress,
          } as CSSProperties
        }
      >
        {children}
      </div>
    </Context.Provider>
  );
}
export function useMobilePanels() {
  const value = useContext(Context);
  if (!value) throw new Error('MobilePanelsProvider is required');
  return value;
}
export function MobileNavigationSettings() {
  const { range, setRange } = useMobilePanels();
  return (
    <section className="surface" aria-label="手机手势设置">
      <div className="section-title">
        <h2>手机导航</h2>
        <span className="tag">当前设备 · 立即生效</span>
      </div>
      <label className="field-label" htmlFor="mobile-gesture-range">
        其他页面的边缘滑动范围
      </label>
      <select
        id="mobile-gesture-range"
        className="standard-input"
        value={range}
        onChange={(e) => setRange(Number(e.target.value))}
      >
        <option value={24}>窄 · 24px</option>
        <option value={40}>标准 · 40px</option>
        <option value={64}>宽 · 64px</option>
        <option value={0}>关闭滑动，使用导航按钮</option>
      </select>
      <p className="field-help">
        助手对话正文中，右滑打开星屿插件导航，左滑打开项目与对话记录；无需从边缘开始。其他页面使用上述边缘范围，顶栏空白处也可滑动。最外侧16px留给系统返回，输入框、选中文字、代码和表格不触发。
      </p>
      {range > 0 && (
        <div className="mobile-gesture-diagram" aria-hidden="true">
          <i style={{ width: range }} />
          <span>助手正文均可左右滑动</span>
          <i style={{ width: range }} />
        </div>
      )}
    </section>
  );
}
