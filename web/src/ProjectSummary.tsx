import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, FolderOpen, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { ProjectNameDialog } from './ProjectDisplayName';
import { useBackLayer } from './back-navigation';

export function ProjectSummary({
  name,
  detail,
  saveName,
  newConversation,
}: {
  name: string;
  detail?: ReactNode;
  saveName: (name: string | null) => Promise<void>;
  newConversation: () => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
  const [rename, setRename] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null),
    suppress = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const cancel = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => cancel, []);
  function open(origin: HTMLElement, x?: number, y?: number) {
    cancel();
    const rect = origin.getBoundingClientRect();
    setAnchor({ x: x ?? rect.right, y: y ?? rect.bottom, origin });
  }
  return (
    <>
      <summary
        title="长按或右键管理项目"
        onContextMenu={(e) => {
          e.preventDefault();
          open(e.currentTarget, e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            e.preventDefault();
            open(e.currentTarget);
          }
        }}
        onPointerDown={(e) => {
          suppress.current = false;
          if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button'))) return;
          cancel();
          start.current = { x: e.clientX, y: e.clientY };
          const origin = e.currentTarget;
          hold.current = setTimeout(() => {
            hold.current = null;
            suppress.current = true;
            open(origin, start.current.x, start.current.y);
          }, 550);
        }}
        onPointerMove={(e) => {
          if (
            Math.abs(e.clientX - start.current.x) > 8 ||
            Math.abs(e.clientY - start.current.y) > 8
          )
            cancel();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        onClickCapture={(e) => {
          if (suppress.current) {
            e.preventDefault();
            e.stopPropagation();
            suppress.current = false;
          }
        }}
      >
        <ChevronRight className="project-tree-caret" size={14} aria-hidden="true" />
        <FolderOpen size={15} />
        <span>{name}</span>
        <small>{detail}</small>
        <button
          className="icon-btn project-row-more"
          aria-label={'项目“' + name + '”的操作'}
          aria-haspopup="menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            open(e.currentTarget);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </summary>
      {anchor && (
        <ProjectMenu
          name={name}
          anchor={anchor}
          close={() => setAnchor(null)}
          rename={() => setRename(true)}
          newConversation={newConversation}
        />
      )}
      {rename && <ProjectNameDialog name={name} save={saveName} close={() => setRename(false)} />}
    </>
  );
}

function ProjectMenu({
  name,
  anchor,
  close,
  rename,
  newConversation,
}: {
  name: string;
  anchor: { x: number; y: number; origin: HTMLElement };
  close: () => void;
  rename: () => void;
  newConversation: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null),
    [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  useBackLayer(true, close, 110);
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(10, Math.min(anchor.x, innerWidth - rect.width - 10)),
      top: Math.max(10, Math.min(anchor.y, innerHeight - rect.height - 10)),
    });
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      anchor.origin.focus();
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={menu}
      className="pi-conversation-menu"
      role="menu"
      aria-label={name + '的项目操作'}
      style={position}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          buttons[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        }
      }}
    >
      <p className="pi-conversation-menu-title">{name}</p>
      <button
        role="menuitem"
        onClick={() => {
          close();
          rename();
        }}
      >
        <Pencil size={16} />
        <span>重命名</span>
      </button>
      <button
        role="menuitem"
        onClick={() => {
          close();
          newConversation();
        }}
      >
        <Plus size={16} />
        <span>新建项目对话</span>
      </button>
    </div>,
    document.body,
  );
}
