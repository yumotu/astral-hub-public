// Lucide Sparkle, ISC. Attribution: web/public/brand-icon-LICENSE.txt.
export const brandColor = '#5263e7';
export const brandPath =
  'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z';
export function brandSvg({ shape = 'rounded' } = {}) {
  const background =
    shape === 'foreground'
      ? ''
      : shape === 'round'
        ? `<circle cx="54" cy="54" r="54" fill="${brandColor}"/>`
        : `<rect width="108" height="108" rx="${shape === 'maskable' ? 0 : 25}" fill="${brandColor}"/>`;
  // The mark stays inside Android/PWA adaptive-icon safe zones.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${background}<g transform="translate(25.2 25.2) scale(2.4)"><path d="${brandPath}" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></g></svg>\n`;
}
