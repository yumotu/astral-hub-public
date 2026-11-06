const visible = new Map();
export function clearWebNotificationScope(scope) {
  for (const [key, n] of visible)
    if (key.startsWith(scope + ':')) {
      n.close();
      visible.delete(key);
    }
}
// Push subscriptions are optional: an open Mac browser can display notifications
// even when its push service is unreachable or PushManager is absent.
export async function deliverWebNotification(
  n,
  { workerSend, Notification, active, onClick, onlyBackground, timeout = 4000 },
) {
  if (!Notification)
    throw new Error('当前浏览器未提供系统通知接口。请使用支持通知的 Safari 或 Chrome。');
  if (Notification.permission !== 'granted')
    throw new Error('浏览器通知权限未开启，请在网站设置中允许通知。');
  if (!active()) return { mode: 'ignored' };
  try {
    const binding = await workerSend({ type: 'ASTRAL_BIND', scope: n.scope, onlyBackground });
    if (!active()) return { mode: 'ignored' };
    if (!binding.ok) throw new Error('通知账号绑定失败。');
    const result = await workerSend({ type: 'ASTRAL_NOTIFY', notification: n });
    if (result.ok && !result.ignored) return { mode: 'worker' };
  } catch {
    /* A direct page notification is the connection-time fallback. */
  }
  if (!active()) return { mode: 'ignored' };
  return new Promise((resolve, reject) => {
    let notice;
    const key = `${n.scope}:${n.id}`;
    const timer = setTimeout(() => {
      notice?.close();
      visible.delete(key);
      reject(
        new Error(
          '浏览器未确认展示通知。请检查 macOS「系统设置 → 通知」中的浏览器权限及专注模式。',
        ),
      );
    }, timeout);
    try {
      notice = new Notification(n.title, {
        body: n.body,
        tag: key,
        icon: './icon-192.png',
        badge: './notification-badge.png',
      });
      visible.set(key, notice);
      notice.onshow = () => {
        clearTimeout(timer);
        if (!active()) {
          notice.close();
          visible.delete(key);
          resolve({ mode: 'ignored' });
        } else resolve({ mode: 'page' });
      };
      notice.onerror = () => {
        clearTimeout(timer);
        notice.close();
        visible.delete(key);
        reject(new Error('浏览器无法展示通知，请检查网站和 macOS 的通知权限。'));
      };
      notice.onclose = () => visible.delete(key);
      notice.onclick = () => {
        if (active()) onClick(n);
        notice.close();
        visible.delete(key);
      };
    } catch {
      clearTimeout(timer);
      reject(new Error('当前浏览器无法直接展示通知，请使用完整浏览器并开启通知权限。'));
    }
  });
}
