import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { assistantCopyText } from '../../shared/assistant-artifacts.mjs';

export function CopyButton({
  text,
  label = '复制内容',
  assistant = false,
}: {
  text: string;
  label?: string;
  assistant?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    try {
      const content = assistant ? assistantCopyText(text) : text;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(content);
      else {
        const focused = document.activeElement as HTMLElement | null;
        const area = document.createElement('textarea');
        area.value = content;
        area.style.cssText = 'position:fixed;opacity:0;left:-9999px';
        document.body.append(area);
        try {
          area.select();
          if (!document.execCommand('copy')) throw new Error('copy');
        } finally {
          area.remove();
          focused?.focus({ preventScroll: true });
        }
      }
      setState('copied');
    } catch {
      setState('error');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2200);
  }
  const title = state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请重试' : label;
  return (
    <button
      type="button"
      className="message-action"
      aria-label={title}
      title={title}
      disabled={!text}
      onClick={() => void copy()}
    >
      {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
      <span>{state === 'idle' ? '复制' : title}</span>
    </button>
  );
}
