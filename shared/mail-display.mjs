import { splitAssistantArtifacts } from './assistant-artifacts.mjs';

export function mailAssistantDraft(input) {
  let fence = null,
    openers = 0,
    closers = 0;
  for (const line of input.split(/\r?\n/)) {
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (!fence) fence = { char: code[1][0], size: code[1].length };
      else if (code[1][0] === fence.char && code[1].length >= fence.size && !code[2].trim())
        fence = null;
      continue;
    }
    if (fence) continue;
    if (/^:::writing(?:\{|\s*$)/.test(line)) {
      openers++;
      const open = /^:::writing\{([^{}\r\n]{0,500})\}\s*$/.exec(line);
      if (open) {
        const keys = [...open[1].matchAll(/([a-zA-Z]+)="([^"\r\n]*)"/g)].map((field) => field[1]);
        if (new Set(keys).size !== keys.length)
          return { error: '助手文稿属性重复，请重新生成一份明确的邮件正文。' };
      }
    } else if (/^:::\s*$/.test(line)) closers++;
  }
  const artifacts = splitAssistantArtifacts(input).filter((part) => part.kind === 'artifact');
  if (artifacts.length > 1)
    return { error: '助手生成了多个文稿，请让助手只提供一份要采用的邮件正文。' };
  if (openers && (openers !== 1 || closers !== 1 || artifacts.length !== 1))
    return { error: '助手文稿包装未完整或格式不受支持，请重新生成完整邮件正文。' };
  if (artifacts.length) {
    if (!['email', 'document', 'standard'].includes(artifacts[0].variant))
      return { error: '这份文稿不是邮件正文，请让助手生成完整邮件正文。' };
    return { text: artifacts[0].text };
  }
  return { text: input };
}

/** Mail links are opened only after a deliberate click, never resolved against the app origin. */
export function safeMailHref(value, image = false) {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f-\u009f]/u.test(value)
  )
    return '';
  try {
    const url = new URL(value);
    if (image && url.protocol !== 'https:') return '';
    if (url.protocol === 'mailto:' && !image) return /%0[ad]/i.test(value) ? '' : url.href;
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return '';
    return url.href;
  } catch {
    return '';
  }
}

export function mailLinkLabel(label, href) {
  const text = String(label || '').trim();
  const safe = safeMailHref(href);
  if (!safe) return text;
  // Preserve useful human labels, but hide tracking/query strings in bare URL text.
  if (text && !/^(?:\[|<)?(?:https?:\/\/|mailto:|www\.)/i.test(text)) return text;
  const url = new URL(safe);
  return url.protocol === 'mailto:' ? '发送邮件' : `访问 ${url.hostname}`;
}
