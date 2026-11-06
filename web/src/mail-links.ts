import { Capacitor, registerPlugin } from '@capacitor/core';
import { safeMailHref } from '../../shared/mail-display.mjs';
const nativeLinks = registerPlugin<{
  open: (value: { url: string }) => Promise<{ opened: boolean }>;
}>('AstralMailLinks');

export async function openMailLink(value: string) {
  const url = safeMailHref(value);
  if (!url) throw new Error('不支持此邮件链接。');
  if (window.astralDesktop?.openMailLink) return window.astralDesktop.openMailLink(url);
  if (Capacitor.getPlatform() === 'android') return nativeLinks.open({ url });
  window.open(url, '_blank', 'noopener,noreferrer');
  return { opened: true };
}
