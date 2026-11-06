import { useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
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
        remarkPlugins={[remarkGfm]}
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
        {text}
      </Markdown>
    </div>
  );
}
