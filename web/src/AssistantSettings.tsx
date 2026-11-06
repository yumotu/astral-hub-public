import { useRef, useState, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Settings2, ChevronDown, X } from 'lucide-react';
import { useBackLayer } from './back-navigation';
export function AssistantSettings({
  children,
  location = '服务器',
}: {
  children: ReactNode;
  location?: string;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 100, maxHeight: 400 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const v = window.visualViewport,
        bottom = (v?.offsetTop || 0) + (v?.height || innerHeight),
        width = Math.min(340, innerWidth - 28),
        top = Math.max(8, Math.min(rect.bottom + 8, bottom - 160));
      setPosition({
        left: Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)),
        top,
        maxHeight: Math.max(80, bottom - top - 12),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open]);
  useBackLayer(open, () => setOpen(false), 80);
  useEffect(() => {
    if (!open) return;
    const dismiss = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest('.assistant-modal-backdrop')) return;
      if (!root.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <div
      className="assistant-task-settings"
      ref={root}
      onKeyDown={(e) => {
        if (
          e.key === 'Escape' &&
          !e.defaultPrevented &&
          !(e.target instanceof Element && e.target.closest('.approval-dialog'))
        ) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label="对话设置"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Settings2 size={15} />
        设置
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
          <>
            <div className="assistant-settings-backdrop" onClick={() => setOpen(false)} />
            <section
              ref={panel}
              style={position}
              className="surface assistant-settings-panel"
              aria-label="对话设置面板"
              role="dialog"
              aria-modal="true"
              onKeyDown={(e) => {
                if (
                  e.key === 'Escape' &&
                  !e.defaultPrevented &&
                  !(e.target instanceof Element && e.target.closest('.approval-dialog'))
                ) {
                  e.preventDefault();
                  setOpen(false);
                  root.current?.querySelector('button')?.focus();
                }
              }}
            >
              <header className="assistant-settings-heading">
                <strong>对话设置</strong>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭对话设置"
                  onClick={() => {
                    setOpen(false);
                    root.current?.querySelector('button')?.focus();
                  }}
                >
                  <X size={17} />
                </button>
              </header>
              <p className="assistant-settings-location">执行位置 · {location}</p>
              {children}
            </section>
          </>,
          document.body,
        )}
    </div>
  );
}
