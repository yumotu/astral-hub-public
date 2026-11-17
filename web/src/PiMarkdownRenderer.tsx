import { useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from '../../shared/markdown-math.mjs';
import { Check, Copy, FileText } from 'lucide-react';
import { CopyButton } from './CopyButton';
import { splitAssistantArtifacts } from '../../shared/assistant-artifacts.mjs';
function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null),
    [copied, setCopied] = useState(false);
  return (
    <div className="pi-code">
      <button
        type="button"
        aria-label="复制代码"
        onClick={() => {
          void navigator.clipboard
            .writeText(ref.current?.textContent || '')
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            })
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? '已复制' : '复制'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
export function PiMarkdown({ text }: { text: string }) {
  return (
    <div className="pi-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { trust: false, maxExpand: 1000, maxSize: 20 }]]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="muted">[图片：{alt || '外部图片'}]</span>,
        }}
      >
        {normalizeMathDelimiters(text)}
      </Markdown>
    </div>
  );
}

/** Agent replies use plain Markdown unless the model explicitly emits a finished writing block. */
export function AssistantReply({ text }: { text: string }) {
  const parts = splitAssistantArtifacts(text);
  return (
    <div className="assistant-reply">
      {parts.map((part, index) =>
        part.kind === 'artifact' ? (
          <section className="assistant-artifact" aria-label={part.title || '文稿'} key={index}>
            <header className="assistant-artifact-heading">
              <FileText size={15} aria-hidden="true" />
              <strong>{part.title || (part.variant === 'email' ? '邮件文稿' : '文稿')}</strong>
              <CopyButton text={part.text} label="复制文稿" />
            </header>
            <PiMarkdown text={part.text} />
          </section>
        ) : (
          <PiMarkdown text={part.text} key={index} />
        ),
      )}
    </div>
  );
}
