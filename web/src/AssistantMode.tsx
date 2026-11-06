import { useBackLayer } from './back-navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, MessageCircle } from 'lucide-react';

const modes = [
  {
    value: 'read',
    label: '询问',
    description: '查看项目文件；原生插件仍拥有 Pi 的进程权限',
    Icon: MessageCircle,
  },
  { value: 'edit', label: '智能体', description: '修改项目文件、运行隔离 Bash 命令', Icon: Bot },
] as const;

export function AssistantMode({
  value,
  projectName,
  readOnly,
  locked,
  onChange,
}: {
  value: 'read' | 'edit';
  projectName?: string;
  readOnly?: boolean;
  locked?: string;
  onChange: (value: 'read' | 'edit') => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selected = modes.find((m) => m.value === value)!;
  const editReason = !projectName
    ? '选择项目后可启用文件修改'
    : readOnly
      ? '此文件夹只允许读取'
      : '';
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  useBackLayer(open, close, 95);
  function focus(index: number) {
    root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[index]?.focus();
  }
  return (
    <div
      className="assistant-mode"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Tab') setOpen(false);
      }}
    >
      <button
        type="button"
        ref={trigger}
        className={`assistant-mode-trigger ${open ? 'is-open' : ''}`}
        aria-label={`助手模式：${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => focus(event.key === 'ArrowDown' ? 0 : 1));
          }
        }}
      >
        <selected.Icon size={14} />
        <span>{selected.label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="assistant-mode-menu"
          id={menuId}
          role="menu"
          aria-label="选择助手模式"
          onKeyDown={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = [
                ...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
              ];
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              focus(
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 1
                    : (current + (event.key === 'ArrowDown' ? 1 : -1) + 2) % 2,
              );
            }
          }}
        >
          <div className="assistant-mode-heading">
            <span>助手模式</span>
            {projectName && <small title={projectName}>{projectName}</small>}
          </div>
          {modes.map((mode) => {
            const reason = locked || (mode.value === 'edit' ? editReason : '');
            return (
              <button
                type="button"
                key={mode.value}
                className="assistant-mode-option"
                role="menuitemradio"
                aria-checked={value === mode.value}
                aria-disabled={!!reason}
                onClick={() => {
                  if (reason) return;
                  if (value !== mode.value) onChange(mode.value);
                  close();
                }}
              >
                <mode.Icon size={17} />
                <span>
                  <strong>{mode.label}</strong>
                  <small>
                    {mode.value === 'edit' && editReason ? editReason : mode.description}
                  </small>
                </span>
                {value === mode.value && <Check size={15} />}
              </button>
            );
          })}
          {locked && <p className="assistant-mode-note">{locked}</p>}
        </div>
      )}
    </div>
  );
}
