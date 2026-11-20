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
