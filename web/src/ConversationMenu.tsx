import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ServerProject } from './ProjectBrowser';
import { useBackLayer } from './back-navigation';

export type Conversation = {
  id: string;
  title: string;
  updatedAt: string;
  projectId?: string | null;
  access?: 'read' | 'edit';
  pinnedAt?: string | null;
  archivedAt?: string | null;
  branch?: { conversationId: string; turnId: string; position: 'before' | 'after' } | null;
};
export type MenuAnchor = { conversation: Conversation; x: number; y: number; origin: HTMLElement };
export type ConversationAction = 'pin' | 'rename' | 'archive' | 'delete' | 'directory' | 'new';

export function ConversationRow({
  conversation,
  selected,
  disabled,
  detail,
  choose,
  openMenu,
}: {
  conversation: Conversation;
  selected: boolean;
  disabled: boolean;
  detail: ReactNode;
  choose: () => void;
  openMenu: (anchor: MenuAnchor) => void;
}) {
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => cancelHold, []);
  function open(origin: HTMLElement, x?: number, y?: number) {
    if (disabled) return;
    cancelHold();
    const rect = origin.getBoundingClientRect();
    openMenu({ conversation, x: x ?? rect.right, y: y ?? rect.bottom, origin });
  }
  return (
    <div
      className={`pi-conversation-row ${selected ? 'is-selected' : ''}`}
      onContextMenu={(event) => {
        if (disabled) return;
        event.preventDefault();
        open(event.currentTarget.querySelector('button')!, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          open(event.target as HTMLElement);
        }
      }}
      onPointerDown={(event) => {
        suppressClick.current = false;
        if (
          disabled ||
          (event.pointerType === 'mouse' && event.button !== 0) ||
          (event.target instanceof Element && event.target.closest('.pi-conversation-more'))
        )
          return;
        cancelHold();
        point.current = { x: event.clientX, y: event.clientY };
        const origin = event.currentTarget.querySelector('button')!;
        hold.current = setTimeout(() => {
          hold.current = null;
          suppressClick.current = true;
          open(origin, point.current.x, point.current.y);
        }, 550);
      }}
      onPointerMove={(event) => {
        if (Math.hypot(event.clientX - point.current.x, event.clientY - point.current.y) > 10)
          cancelHold();
      }}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <button
        className={`contact-choice ${selected ? 'selected' : ''}`}
        disabled={disabled}
        onClick={choose}
        aria-current={selected ? 'page' : undefined}
      >
        <span>
          <b title={conversation.title}>
            {conversation.pinnedAt && <Pin size={12} aria-label="已置顶" />}
            {conversation.title}
          </b>
          <small>{detail}</small>
        </span>
      </button>
      <button
        className="icon-btn pi-conversation-more"
        aria-label={`${conversation.title}的更多操作`}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={(event) => open(event.currentTarget)}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  );
}

export function ConversationMenu({
  anchor,
  close,
  action,
}: {
  anchor: MenuAnchor;
  close: () => void;
  action: (action: ConversationAction, conversation: Conversation) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });
  const c = anchor.conversation;
  useBackLayer(true, close, 110);
  useLayoutEffect(() => {
    const rect = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(10, Math.min(anchor.x, window.innerWidth - rect.width - 10)),
      top: Math.max(10, Math.min(anchor.y, window.innerHeight - rect.height - 10)),
    });
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    function outside(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node)) close();
    }
    function reposition() {
      close();
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', reposition);
      anchor.origin.focus();
    };
  }, [anchor]);
  const actions: { key: ConversationAction; icon: ReactNode; label: string }[] = [
    {
      key: 'pin',
      icon: c.pinnedAt ? <PinOff size={16} /> : <Pin size={16} />,
      label: c.pinnedAt ? '取消置顶' : '置顶对话',
    },
    { key: 'rename', icon: <Pencil size={16} />, label: '重命名' },
    ...(c.projectId
      ? [{ key: 'directory' as const, icon: <FolderOpen size={16} />, label: '查看工作目录' }]
      : []),
    { key: 'new', icon: <Plus size={16} />, label: '新建同目录对话' },
    {
      key: 'archive',
      icon: c.archivedAt ? <ArchiveRestore size={16} /> : <Archive size={16} />,
      label: c.archivedAt ? '恢复对话' : '归档对话',
    },
    { key: 'delete', icon: <Trash2 size={16} />, label: '删除对话' },
  ];
  return createPortal(
    <div
      ref={menu}
      className="pi-conversation-menu"
      role="menu"
      aria-label={`${c.title}的操作`}
      style={position}
      onKeyDown={(event) => {
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ]?.focus();
        }
      }}
    >
      <p className="pi-conversation-menu-title">{c.title}</p>
      {actions.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          className={item.key === 'delete' ? 'danger' : ''}
          onClick={() => {
            close();
            action(item.key, c);
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function ConversationDialog({
  title,
  close,
  children,
  className = '',
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  className?: string;
}) {
  const content = useRef<HTMLElement>(null);
  useBackLayer(true, close, 100);
  useEffect(() => {
    const origin = document.activeElement as HTMLElement | null;
    content.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    return () => origin?.focus();
  }, []);
  return createPortal(
    <div
      className="pi-management-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') {
          const elements = [
            ...content.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled)',
            ),
          ];
          const first = elements[0],
            last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        ref={content}
        className={`surface pi-management-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="section-title">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn push-right"
            aria-label={`关闭${title}`}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}

export function ConversationEditor({
  conversation,
  kind,
  running,
  close,
  submit,
  computer = false,
}: {
  computer?: boolean;
  conversation: Conversation;
  kind: 'rename' | 'delete';
  running: boolean;
  close: () => void;
  submit: (title?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(conversation.title),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (kind === 'rename')
      document.querySelector<HTMLInputElement>('.pi-management-dialog input')?.select();
  }, []);
  return (
    <ConversationDialog
      title={kind === 'rename' ? '重命名对话' : '删除对话'}
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void submit(kind === 'rename' ? title.trim() : undefined)
            .then(close)
            .catch((error) => setError(error.message))
            .finally(() => setBusy(false));
        }}
      >
        {kind === 'rename' ? (
          <label>
            对话名称
            <input
              aria-label="对话名称"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              disabled={busy}
            />
          </label>
        ) : (
          <>
            <p>
              {computer
                ? `将删除「${conversation.title}」在星屿中的聊天记录与附件；电脑上的原生缓存由目标电脑保留。`
                : `将永久删除「${conversation.title}」的聊天记录、附件和 Pi 会话，并停用关联的定时任务。`}
            </p>
            <p className="field-help">项目文件会保留。此操作无法撤销；仅想收起对话可使用归档。</p>
            {running && (
              <p className="error" role="alert">
                对话仍有任务或排队消息，请先停止任务并撤回队列。
              </p>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className={kind === 'delete' ? 'primary pi-delete-confirm' : 'primary'}
            disabled={
              busy || (kind === 'delete' && running) || (kind === 'rename' && !title.trim())
            }
          >
            {busy ? '保存中…' : kind === 'rename' ? '保存名称' : '确认删除'}
          </button>
        </div>
      </form>
    </ConversationDialog>
  );
}

export function DefaultDirectory({
  projects,
  selected,
  close,
  chooseFolder,
  save,
}: {
  projects: ServerProject[];
  selected: string | null;
  close: () => void;
  chooseFolder: () => void;
  save: (id: string | null) => Promise<void>;
}) {
  const [id, setId] = useState(selected || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const project = projects.find((p) => p.id === id);
  return (
    <ConversationDialog
      title="默认工作目录"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          void save(id || null)
            .then(close)
            .catch((error) => setError(error.message))
            .finally(() => setBusy(false));
        }}
      >
        <p className="field-help">
          用于全局「新对话」，在账号下同步。项目内新建对话使用该项目的文件夹。
        </p>
        <label>
          新对话的工作目录
          <select
            aria-label="默认工作目录"
            value={id}
            disabled={busy}
            onChange={(event) => setId(event.target.value)}
          >
            <option value="">独立会话 · 不访问项目文件</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {project && <code className="pi-default-path">{project.serverPath}</code>}
        <button
          type="button"
          className="text-link"
          disabled={busy || !projects.some((p) => p.source)}
          onClick={chooseFolder}
        >
          <FolderOpen size={15} />
          选择其他文件夹…
        </button>
        <p className="field-help">仅影响之后的新对话，已有对话的工作目录和上下文保持不变。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '保存中…' : '保存设置'}
          </button>
        </div>
      </form>
    </ConversationDialog>
  );
}
