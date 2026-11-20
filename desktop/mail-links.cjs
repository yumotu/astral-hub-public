// Separate from the generic window allowlist: only the trusted app can invoke this IPC.
function mailLink(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f-\x9f]/.test(value))
    return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return /%0[ad]/i.test(value) ? '' : url.href;
    return ['http:', 'https:'].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}
module.exports = { mailLink };
