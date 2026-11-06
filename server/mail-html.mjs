import sanitizeHtml from 'sanitize-html';
import { safeMailHref } from '../shared/mail-display.mjs';

export const MAX_MAIL_HTML = 250000;

/** Produce a bounded, inert fragment. The client adds its own styles and sandbox/CSP. */
export function sanitizeMailHtml(source) {
  if (typeof source !== 'string' || !source) return { html: '', remoteImageCount: 0 };
  let remoteImageCount = 0;
  const html = sanitizeHtml(source.slice(0, MAX_MAIL_HTML), {
    allowedTags: [
      'div',
      'span',
      'p',
      'br',
      'hr',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'del',
      'small',
      'sub',
      'sup',
      'mark',
      'blockquote',
      'pre',
      'code',
      'ul',
      'ol',
      'li',
      'dl',
      'dt',
      'dd',
      'a',
      'table',
      'caption',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
    ],
    allowedAttributes: {
      a: ['href'],
      span: ['data-mail-image', 'data-mail-alt'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'noscript',
      'iframe',
      'object',
      'svg',
      'math',
    ],
    nestingLimit: 60,
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { href: safeMailHref(attrs.href) } }),
      // Never keep a request-capable src, srcset, CSS or original data-* attribute.
      span: () => ({ tagName: 'span', attribs: {} }),
      img: (_tag, attrs) => {
        const src = safeMailHref(attrs.src, true),
          alt = (attrs.alt || '邮件图片').slice(0, 200);
        if (src && remoteImageCount < 30) {
          remoteImageCount++;
          return {
            tagName: 'span',
            attribs: { 'data-mail-image': src, 'data-mail-alt': alt },
            text: `[${alt} · 未加载]`,
          };
        }
        return { tagName: 'span', attribs: {}, text: `[${alt}]` };
      },
      td: (_tag, attrs) => ({ tagName: 'td', attribs: spans(attrs) }),
      th: (_tag, attrs) => ({ tagName: 'th', attribs: spans(attrs) }),
    },
  });
  return { html, remoteImageCount };
}

function spans(attrs) {
  return Object.fromEntries(
    ['colspan', 'rowspan'].flatMap((key) => {
      const value = Number(attrs[key]);
      return Number.isInteger(value) && value > 0 && value <= 20 ? [[key, String(value)]] : [];
    }),
  );
}
