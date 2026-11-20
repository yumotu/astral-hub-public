// Replace terminal-only notification transports; other extensions load unchanged.
export function terminalNotifier(path) {
  return /\/node_modules\/(?:pi-notify|pi-desktop-notifications|@(?:jmcombs|raidou|bacnh85|xzzpig)\/pi-notify)\//.test(
    path.replaceAll('\\', '/'),
  );
}
export function nativeNotification(event) {
  const m = event.message;
  if (event.type !== 'message_end' || m?.role !== 'custom') return null;
  if (m.customType === 'astral-notification-policy' && typeof m.details?.enabled === 'boolean')
    return { type: 'notification_policy', enabled: m.details.enabled };
  const p = m.details;
  if (
    m.customType !== 'astral-notification' ||
    !/^[a-f0-9-]{36}$/.test(p?.id || '') ||
    typeof p.title !== 'string' ||
    typeof p.body !== 'string'
  )
    return null;
  return {
    type: 'notification',
    id: p.id,
    title: p.title.slice(0, 120),
    body: p.body.slice(0, 1200),
  };
}
