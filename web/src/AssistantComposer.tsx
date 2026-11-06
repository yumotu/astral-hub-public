import type { KeyboardEventHandler, ReactNode, RefObject, TextareaHTMLAttributes } from 'react';
import { pastedFiles, insertPastedText } from './composer-paste';
import { useHistoryComposerEnter, editorComposerEnter } from './composer-keyboard';
import { useComposerSize } from './mobile-viewport';

export function AssistantComposer({
  area,
  history,
  value,
  onValue,
  send,
  upload,
  attributes,
  onKeyDown,
  header,
  children,
  active = true,
}: {
  area: RefObject<HTMLTextAreaElement | null>;
  history: RefObject<HTMLElement | null>;
  value: string;
  onValue: (value: string) => void;
  send: () => void | Promise<void>;
  upload: (files: File[]) => void | Promise<void>;
  attributes: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange' | 'onPaste' | 'onKeyDown'
  > & { 'data-quote-input'?: boolean };
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  header?: ReactNode;
  children: ReactNode;
  active?: boolean;
}) {
  useHistoryComposerEnter(area, history, active);
  useComposerSize(area, value, { enabled: active });
  const submit = () => {
    const button = area.current?.form?.querySelector<HTMLButtonElement>(
      '.composer-primary-action:not(.stop-task)',
    );
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    return send();
  };
  return (
    <form
      className="message-composer assistant-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {header}
      <textarea
        rows={2}
        maxLength={8000}
        placeholder="发送消息… 输入 / 查看命令"
        aria-description="可直接粘贴图片、文件和文字，附件预览后再发送。"
        {...attributes}
        ref={area}
        value={value}
        onChange={(event) => onValue(event.target.value)}
        onPaste={(event) => {
          const files = pastedFiles(event.clipboardData);
          if (!files.length) return;
          event.preventDefault();
          event.stopPropagation();
          const text = event.clipboardData.getData('text/plain'),
            field = event.currentTarget;
          if (text) {
            const result = insertPastedText(
              field.value,
              text,
              field.selectionStart,
              field.selectionEnd,
            );
            onValue(result.value);
            requestAnimationFrame(() => {
              if (area.current === field) field.setSelectionRange(result.cursor, result.cursor);
            });
          }
          void upload(files);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Enter' && event.repeat && !event.shiftKey) {
            event.preventDefault();
            return;
          }
          onKeyDown?.(event);
          editorComposerEnter(event, submit);
        }}
      />
      {children}
    </form>
  );
}
