import { lazy, Suspense } from 'react';

const Markdown = lazy(() =>
  import('./PiMarkdownRenderer').then((module) => ({ default: module.PiMarkdown })),
);
const Reply = lazy(() =>
  import('./PiMarkdownRenderer').then((module) => ({ default: module.AssistantReply })),
);

function LoadingMarkdown({ text }: { text: string }) {
  return (
    <div className="pi-markdown" aria-busy="true">
      <span className="field-help" role="status">
        正在载入排版…
      </span>
      <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  );
}

export function PiMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<LoadingMarkdown text={text} />}>
      <Markdown text={text} />
    </Suspense>
  );
}

export function AssistantReply({ text }: { text: string }) {
  return (
    <Suspense fallback={<LoadingMarkdown text={text} />}>
      <Reply text={text} />
    </Suspense>
  );
}
