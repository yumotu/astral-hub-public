import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { ProjectNameDialog } from './ProjectDisplayName';
import { useBackLayer } from './back-navigation';

export function ProjectSummary({
  name,
  detail,
  saveName,
  newConversation,
  remove,
  restore,
}: {
  name: string;
  detail?: ReactNode;
  saveName: (name: string | null) => Promise<void>;
  newConversation?: () => void;
  remove?: () => void;
  restore?: () => void;
}) {
  const [rename, setRename] = useState(false);
  return (
    <>
      <ManagementSummary
        name={name}
        menuLabel={'项目“' + name + '”的操作'}
        title="长按或右键管理项目"
        actions={[
          { label: '重命名', icon: <Pencil size={16} />, run: () => setRename(true) },
          ...(newConversation
            ? [{ label: '新建项目对话', icon: <Plus size={16} />, run: newConversation }]
            : []),
          ...(restore ? [{ label: '恢复项目', icon: <RotateCcw size={16} />, run: restore }] : []),
          ...(remove
            ? [{ label: '删除项目', icon: <Trash2 size={16} />, danger: true, run: remove }]
            : []),
        ]}
      >
        <ChevronRight className="project-tree-caret" size={14} aria-hidden="true" />
        <FolderOpen size={15} />
        <span>{name}</span>
        <small>{detail}</small>
      </ManagementSummary>
      {rename && <ProjectNameDialog name={name} save={saveName} close={() => setRename(false)} />}
    </>
  );
}

type ManagementAction = { label: string; icon: ReactNode; run: () => void; danger?: boolean };

export function ManagementSummary({
  name,
  title,
  className,
  children,
  actions,
  menuLabel,
}: {
  name: string;
  title: string;
  className?: string;
  children: ReactNode;
  actions: ManagementAction[];
  menuLabel?: string;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
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
    if (!actions.length) return;
    const rect = origin.getBoundingClientRect();
    setAnchor({ x: x ?? rect.right, y: y ?? rect.bottom, origin });
  }
  return (
    <>
      <summary
        title={title}
        className={className}
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
        {children}
        {!!actions.length && (
          <button
            className="icon-btn project-row-more"
            aria-label={menuLabel || '电脑“' + name + '”的操作'}
            aria-haspopup="menu"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open(e.currentTarget);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
      </summary>
      {anchor && (
        <ProjectMenu name={name} anchor={anchor} close={() => setAnchor(null)} actions={actions} />
      )}
    </>
  );
}

function ProjectMenu({
  name,
  anchor,
  close,
  actions,
}: {
  name: string;
  anchor: { x: number; y: number; origin: HTMLElement };
  close: () => void;
  actions: ManagementAction[];
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
      aria-label={name + '的操作'}
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
      {actions.map((action) => (
        <button
          key={action.label}
          role="menuitem"
          className={action.danger ? 'danger' : ''}
          onClick={() => {
            close();
            action.run();
          }}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
