import { useEffect, type RefObject } from 'react';

const controls =
  'form,input,textarea,select,button,a[href],summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"],[role="listbox"],[role="menuitem"],.cm-editor,.xterm';
const overlays =
  '[role="dialog"],[role="alertdialog"],dialog[open],[role="menu"],.assistant-settings-panel,.project-navigation-scrim.is-open,.sidebar.open,.thinking-picker[open],[data-composer-scope]';
const visible = (element: Element) =>
  !element.closest('[hidden],[inert]') && element.getClientRects().length > 0;

// Reuse the live form and submit button so upload/history/permission guards and
// the current delivery mode remain identical to an ordinary click on Send.
export function historyComposerEnter(
  event: KeyboardEvent,
  area: HTMLTextAreaElement | null,
  history: HTMLElement | null,
) {
  if (
    event.key !== 'Enter' ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return false;
  if (!area?.isConnected || area.disabled || area.readOnly || !visible(area)) return false;
  const doc = area.ownerDocument,
    target = event.target as Element | null;
  if (doc.visibilityState === 'hidden' || !target) return false;
  if (target !== doc.body && target !== doc.documentElement && !history?.contains(target))
    return false;
  const scope = area.closest('[data-composer-scope]');
  if (
    target.closest?.(controls) ||
    [...doc.querySelectorAll(overlays)].some(
      (overlay) => visible(overlay) && overlay !== scope && !(scope && overlay.contains(scope)),
    )
  )
    return false;
  event.preventDefault();
  area.focus({ preventScroll: true });
  const form = area.form;
  // Completion belongs to the editor's existing arrow/Enter handler.
  if (form?.querySelector('.pi-command-menu')) return true;
  const button = form?.querySelector<HTMLButtonElement>(
    '[data-composer-submit],.composer-primary-action:not(.stop-task)',
  );
  if (button && !button.disabled && button.getAttribute?.('aria-disabled') !== 'true')
    form!.requestSubmit(button);
  return true;
}

export function editorComposerEnter(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    repeat: boolean;
    defaultPrevented: boolean;
    nativeEvent: { isComposing: boolean; keyCode: number };
    preventDefault: () => void;
  },
  submit: () => void | Promise<void>,
) {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return false;
  event.preventDefault();
  if (!event.repeat) void submit();
  return true;
}

export function useHistoryComposerEnter(
  area: RefObject<HTMLTextAreaElement | null>,
  history: RefObject<HTMLElement | null>,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) =>
      historyComposerEnter(event, area.current, history.current);
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [area, history, enabled]);
}
