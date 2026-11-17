import { lazy, Suspense } from 'react';
import { dshMessagePresentation } from '../../shared/dsh-session.mjs';
import { CopyButton } from './CopyButton';

const Reply = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.AssistantReply })));
const Markdown = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.PiMarkdown })));

type Message = { id: string; text: string; thinking?: string };

/** Live DSH replies and prior engine segments share the same visibility rules. */
export function DshMessage({
  message,
  showThinking = false,
}: {
  message: Message;
  showThinking?: boolean;
}) {
  const presentation = dshMessagePresentation(message, { showThinking });
  if (!presentation.visible) return null;
  return (
    <div className="message assistant">
      {presentation.thinking && (
        <details className="pi-thinking">
          <summary>思考过程</summary>
          <Suspense fallback={<pre>{message.thinking}</pre>}>
            <Markdown text={message.thinking!} />
          </Suspense>
        </details>
      )}
      {presentation.text && (
        <Suspense fallback={<pre>{message.text}</pre>}>
          <Reply text={message.text} />
        </Suspense>
      )}
      {presentation.copy && <CopyButton text={message.text} assistant />}
    </div>
  );
}
