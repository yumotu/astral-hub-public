import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Image, Link2 } from 'lucide-react';
import { useBackLayer } from './back-navigation';
import { useTheme } from './Theme';
import { themeColors } from '../../shared/theme-presets.mjs';
import { safeMailHref, mailLinkLabel } from '../../shared/mail-display.mjs';
import { normalizeMailTables } from '../../shared/mail-layout.mjs';
import './mail-body.css';
import { openMailLink } from './mail-links';

function textLabel(children: ReactNode): string {
  return typeof children === 'string' || typeof children === 'number'
    ? String(children)
    : Array.isArray(children)
      ? children.map(textLabel).join('')
      : '';
}

/** Only the server's sanitized fragment enters the sandbox; no mail script or stylesheet runs. */
export function MailBody({
  text,
  html,
  remoteImageCount = 0,
}: {
  text: string;
  html?: string;
  remoteImageCount?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    cleanup = useRef<() => void>(() => {});
  const [images, setImages] = useState(false),
    [height, setHeight] = useState(160),
    [error, setError] = useState('');
  const { palette, appearance } = useTheme();
  const document = useMemo(() => {
    const c = themeColors(palette, appearance);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${images ? 'https:' : "'none'"}; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      :root{color-scheme:${appearance};background:${c.surface};color:${c.text};font:15px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      *{box-sizing:border-box}html,body{margin:0;padding:0;min-width:0}body{padding:4px 0;overflow-wrap:anywhere;word-break:normal}
      h1,h2,h3,h4,h5,h6{line-height:1.4;margin:1.1em 0 .5em}h1{font-size:1.5em}h2{font-size:1.3em}h3{font-size:1.15em}
      p{margin:.6em 0}a{color:${c.accent};text-decoration:underline;text-underline-offset:3px}a:not([href]){color:inherit;text-decoration:none}
      [data-mail-layout]{display:block;width:100%;min-width:0;max-width:100%;margin:0;padding:0;border:0}
      td[data-mail-layout]:empty{display:none}td[data-mail-layout]>:first-child{margin-top:0}
      .mail-data-table{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;margin:1em 0}
      table[data-mail-table="data"]{width:100%;border-collapse:collapse} [data-mail-cell]{border:1px solid ${c.border};padding:8px;min-width:7ch;vertical-align:top;overflow-wrap:normal;word-break:normal}
      th[data-mail-cell]{background:${c['surface-soft']};text-align:left}blockquote{margin:1em 0;padding:4px 12px;border-left:3px solid ${c.border};color:${c.muted}}
      pre{max-width:100%;padding:10px;background:${c['surface-soft']};white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}code{font-family:ui-monospace,monospace}
      img{display:block;max-width:100%;height:auto;margin:10px 0}span[data-mail-image]{display:inline-block;padding:8px 10px;margin:8px 0;border:1px dashed ${c.border};border-radius:6px;color:${c.muted};font-size:13px}
      hr{border:0;border-top:1px solid ${c.border};margin:1em 0}body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}::selection{background:${c.selection};color:${c['selection-text']}}
    </style></head><body>${html || ''}</body></html>`;
  }, [html, images, palette, appearance]);
  useEffect(() => () => cleanup.current(), []);
  const open = (href: string) => {
    setError('');
    void openMailLink(href).catch(() => setError('无法打开链接，请切换纯文本查看地址。'));
  };
  useBackLayer(
    !!html,
    () => {
      const selection = frame.current?.contentWindow?.getSelection();
      if (!selection || selection.isCollapsed) return false;
      selection.removeAllRanges();
    },
    90,
  );

  function loaded() {
    cleanup.current();
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    normalizeMailTables(doc);
    const measure = () =>
      setHeight(
        Math.max(80, Math.min(30000, Math.ceil(doc.body.getBoundingClientRect().height) + 2)),
      );
    for (const link of doc.querySelectorAll<HTMLAnchorElement>('a')) {
      const href = safeMailHref(link.getAttribute('href'));
      if (!href) {
        link.removeAttribute('href');
        continue;
      }
      link.href = href;
      const label = mailLinkLabel(link.textContent, href);
      // Keep useful markup and image placeholders inside human-labelled links.
      if (label !== link.textContent?.trim()) link.textContent = label;
      link.title = new URL(href).hostname || '电子邮件';
    }
    if (images)
      for (const placeholder of doc.querySelectorAll<HTMLElement>('[data-mail-image]')) {
        const src = safeMailHref(placeholder.dataset.mailImage, true);
        if (!src) continue;
        const image = doc.createElement('img');
        image.alt = placeholder.dataset.mailAlt || '邮件图片';
        image.referrerPolicy = 'no-referrer';
        image.loading = 'lazy';
        image.addEventListener('load', measure, { once: true });
        image.addEventListener(
          'error',
          () => {
            image.replaceWith(doc.createTextNode(`[${image.alt} · 加载失败]`));
            measure();
          },
          { once: true },
        );
        image.src = src;
        placeholder.replaceWith(image);
      }
    const click = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.('a');
      if (!link) return;
      event.preventDefault();
      const href = safeMailHref(link.getAttribute('href'));
      if (href) open(href);
    };
    doc.addEventListener('click', click);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      window.dispatchEvent(new Event('astral-native-back', { cancelable: true }));
    };
    doc.addEventListener('keydown', escape);
    const observer = new ResizeObserver(measure);
    observer.observe(doc.body);
    measure();
    cleanup.current = () => {
      observer.disconnect();
      doc.removeEventListener('click', click);
      doc.removeEventListener('keydown', escape);
    };
  }
  if (!html)
    return (
      <div className="mail-body mail-body-formatted mail-body-markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ children, href }) => {
              const safe = safeMailHref(href),
                label = textLabel(children);
              return safe ? (
                <a
                  href={safe}
                  title={new URL(safe).hostname || '电子邮件'}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault();
                    open(safe);
                  }}
                >
                  <Link2 size={12} aria-hidden="true" />
                  {mailLinkLabel(label, safe) || children}
                </a>
              ) : (
                <span>{children}</span>
              );
            },
            img: ({ alt }) => <span className="muted">[{alt || '外部图片'} · 未加载]</span>,
          }}
        >
          {text}
        </Markdown>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  return (
    <div className="mail-body mail-body-web">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {remoteImageCount > 0 && (
        <div className="mail-image-choice">
          <span>
            {images ? '已允许本封邮件的远程图片' : `${remoteImageCount} 张远程图片未加载`}
          </span>
          <button className="text-link" onClick={() => setImages(!images)}>
            <Image size={14} />
            {images ? '隐藏图片' : '加载图片'}
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        title="邮件网页正文"
        sandbox="allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={document}
        onLoad={loaded}
        style={{ height }}
      />
    </div>
  );
}
