// Leave the outer 16 CSS pixels to Android/browser system-back gestures.
export const SYSTEM_BACK_EDGE = 16;
export function gestureRange(value) {
  const n = Number(value);
  return [0, 24, 40, 64].includes(n) ? n : 40;
}
export function swipeStartPanel({
  panel,
  width,
  startX,
  conversationsAvailable,
  fromHeader = false,
  fromConversation = false,
  range = 40,
  blocked = false,
}) {
  if (blocked || width > 1000 || !gestureRange(range)) return null;
  if (startX < SYSTEM_BACK_EDGE || startX > width - SYSTEM_BACK_EDGE) return null;
  if (panel) return panel;
  if (fromConversation) return 'conversation';
  if (width <= 700 && startX <= SYSTEM_BACK_EDGE + gestureRange(range)) return 'workspace';
  if (conversationsAvailable && startX >= width - SYSTEM_BACK_EDGE - gestureRange(range))
    return 'conversations';
  return fromHeader ? 'header' : null;
}
export function panelDrag({ panel, open, dx, size }) {
  const direction = panel === 'workspace' ? -1 : 1;
  const offset = Math.min(size, Math.max(0, (open ? 0 : size) + dx * direction));
  return { offset: offset ? offset * direction : 0, progress: 1 - offset / size };
}
export function swipePanel({
  panel,
  width,
  startX,
  startY,
  endX,
  endY,
  duration,
  conversationsAvailable,
  fromHeader = false,
  fromConversation = false,
  blocked = false,
  range = 40,
}) {
  const dx = endX - startX,
    dy = endY - startY;
  if (
    !swipeStartPanel({
      panel,
      width,
      startX,
      conversationsAvailable,
      fromHeader,
      fromConversation,
      range,
      blocked,
    }) ||
    width > 1000 ||
    duration > 650 ||
    Math.abs(dx) < 48 ||
    Math.abs(dx) < Math.abs(dy) * 1.5
  )
    return panel;
  if (panel === 'workspace') return dx < 0 ? null : panel;
  if (panel === 'conversations') return dx > 0 ? null : panel;
  if (
    dx > 0 &&
    width <= 700 &&
    (startX <= SYSTEM_BACK_EDGE + range || fromHeader || fromConversation)
  )
    return 'workspace';
  if (
    dx < 0 &&
    conversationsAvailable &&
    (startX >= width - SYSTEM_BACK_EDGE - range || fromHeader || fromConversation)
  )
    return 'conversations';
  return panel;
}
