import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { Capacitor } from '@capacitor/core';
import { mobileViewport } from '../../shared/mobile-viewport.mjs';
import './mobile-viewport.css';

export function useMobileViewport() {
  useEffect(() => {
    const root = document.documentElement,
      view = window.visualViewport;
    let baseline = innerHeight,
      lastWidth = innerWidth,
      frame = 0;
    let nativeKeyboard: boolean | null = null;
    const update = () => {
      frame = 0;
      if (innerWidth > 1000 && Capacitor.getPlatform() !== 'android') {
        root.style.removeProperty('--app-viewport-height');
        root.style.removeProperty('--app-viewport-top');
        delete root.dataset.mobileViewport;
        delete root.dataset.keyboard;
        return;
      }
      if (Math.abs(innerWidth - lastWidth) > 80) baseline = innerHeight;
      baseline = Math.max(baseline, innerHeight);
      lastWidth = innerWidth;
      const active = document.activeElement;
      // Tabbing/tapping an editor action must not collapse keyboard layout
      // while the visual viewport is still reduced by the IME.
      const focused =
        active instanceof HTMLElement &&
        (active.matches('input,textarea,[contenteditable="true"]') ||
          (root.dataset.keyboard === 'open' &&
            !!active.closest('.assistant-composer,.mail-composer,.mail-agent-compose')));
      const geometry = mobileViewport({
        layoutHeight: innerHeight,
        visualHeight: view?.height,
        visualTop: view?.offsetTop,
        scale: view?.scale,
        baselineHeight: baseline,
        focused,
        nativeKeyboard,
      });
      root.style.setProperty('--app-viewport-height', `${geometry.height}px`);
      root.style.setProperty('--app-viewport-top', `${geometry.top}px`);
      root.dataset.mobileViewport = '';
      root.dataset.keyboard = geometry.keyboard ? 'open' : 'closed';
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const keyboard = (event: Event) => {
      nativeKeyboard = !!(event as CustomEvent<{ open: boolean }>).detail?.open;
      schedule();
    };
    update();
    view?.addEventListener('resize', schedule);
    view?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('astral-native-keyboard', keyboard);
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    return () => {
      cancelAnimationFrame(frame);
      view?.removeEventListener('resize', schedule);
      view?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('astral-native-keyboard', keyboard);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      root.style.removeProperty('--app-viewport-height');
      root.style.removeProperty('--app-viewport-top');
      delete root.dataset.mobileViewport;
      delete root.dataset.keyboard;
    };
  }, []);
}

export function useComposerSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: { min?: number; max?: number; ratio?: number; enabled?: boolean } = {},
) {
  const { min = 44, max = 180, ratio = 0.27, enabled = true } = options;
  useLayoutEffect(() => {
    if (!enabled) return;
    const resize = () => {
      const field = ref.current;
      if (!field) return;
      const visibleHeight = window.visualViewport?.height || innerHeight;
      const editor = field.closest('.mail-compose-content');
      const available = editor?.clientHeight ? editor.clientHeight - 16 : visibleHeight;
      const limit = Math.max(44, Math.min(max, visibleHeight * ratio, available));
      field.style.minHeight = `${Math.min(min, limit)}px`;
      field.style.maxHeight = `${limit}px`;
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, limit)}px`;
    };
    resize();
    const editor = ref.current?.closest('.mail-compose-content');
    const observer = editor ? new ResizeObserver(resize) : null;
    if (editor) observer?.observe(editor);
    window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, [ref, value, min, max, ratio, enabled]);
}

/** Scroll only the editor's inner region, without moving the fixed action footer or the app. */
export function useMailEditorFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !ref.current?.contains(field) || innerWidth > 800)
          return;
        const scroller = field.closest<HTMLElement>('.mail-compose-content,.mail-action-body');
        if (!scroller) return;
        const visible = scroller.getBoundingClientRect(),
          rect = field.getBoundingClientRect();
        if (rect.height > visible.height - 16) scroller.scrollTop += rect.top - visible.top - 8;
        else if (rect.bottom > visible.bottom - 8)
          scroller.scrollTop += rect.bottom - visible.bottom + 8;
        else if (rect.top < visible.top + 8) scroller.scrollTop += rect.top - visible.top - 8;
      });
    };
    ref.current?.addEventListener('focusin', reveal);
    window.visualViewport?.addEventListener('resize', reveal);
    window.addEventListener('resize', reveal);
    const container = ref.current;
    return () => {
      cancelAnimationFrame(frame);
      container?.removeEventListener('focusin', reveal);
      window.visualViewport?.removeEventListener('resize', reveal);
      window.removeEventListener('resize', reveal);
    };
  }, [ref]);
}
